#!/usr/bin/env python3
"""
PersonaPlex ↔ LiveKit voice bridge.

Joins each active Nemochat session room as identity `personaplex`. For each
remote audio track (the browser microphone), it pipes PCM through a Moshi WS
session (anton:8998) and republishes Moshi's spoken reply as a LiveKit audio
track in the same room. Moshi text tokens are emitted as data events on
topic `nemoswarm.transcript` (FINAL only — partial tokens are coalesced into
sentence boundaries to keep the UI stable).

Design — same shape as nemotron_agent.py, three small pieces:
  • SwarmAPI   — list active sessions, mint per-room tokens
  • MoshiClient — WS handshake + frame protocol + auto-reconnect
  • RoomBridge  — per-session LiveKit lifecycle: subscribe browser audio,
                  publish synthesised audio, broadcast transcripts
  • Supervisor  — polls sessions, brings RoomBridges up/down

The bridge is defensive: Moshi being unreachable or crashing only affects voice;
text agents and the UI keep working. Audio resampling uses numpy linear
interpolation (cheap; Moshi is 24 kHz, LiveKit is typically 48 kHz).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import dataclass, field
from typing import Dict, List, Optional

import aiohttp
import httpx
import numpy as np

try:
    import sphn  # opus stream encode/decode
except ImportError:
    sphn = None  # type: ignore

from livekit import rtc

# ── Config ──────────────────────────────────────────────────────────────────
LIVEKIT_URL    = os.environ.get('LIVEKIT_URL',    'ws://10.1.8.66:7880')
SWARM_WEB_URL  = os.environ.get('SWARM_WEB_URL',  'http://10.1.8.66:8888')
MOSHI_URL      = os.environ.get('MOSHI_URL',      'ws://10.1.0.4:8998/api/chat')
NODE_NAME      = os.environ.get('NODE_NAME',      'personaplex')
POLL_INTERVAL_S = float(os.environ.get('POLL_INTERVAL_S', '5'))
MOSHI_RETRY_S   = float(os.environ.get('MOSHI_RETRY_S',   '10'))
MOSHI_SR        = int(os.environ.get('MOSHI_SR', '24000'))   # mimi sample rate
LK_SR           = int(os.environ.get('LK_SR',    '48000'))   # LiveKit/browser default
TRANSCRIPT_TOPIC = 'nemoswarm.transcript'

logging.basicConfig(level=logging.INFO,
                    format='%(asctime)s %(name)s %(levelname)s %(message)s')
log = logging.getLogger('pp-bridge')


# ── SwarmAPI ────────────────────────────────────────────────────────────────
class SwarmAPI:
    def __init__(self, base_url: str):
        self.base = base_url.rstrip('/')
        self._client = httpx.AsyncClient(timeout=15.0)

    async def close(self): await self._client.aclose()

    async def list_active(self) -> List[dict]:
        r = await self._client.get(f'{self.base}/api/nemo/sessions/active')
        r.raise_for_status()
        return r.json().get('sessions', [])

    async def token(self, session_id: str, identity: str) -> dict:
        r = await self._client.get(
            f'{self.base}/api/nemo/sessions/{session_id}/livekit-token',
            params={'identity': identity})
        r.raise_for_status()
        return r.json()


# ── Audio plumbing ──────────────────────────────────────────────────────────
def resample_linear(pcm: np.ndarray, src_sr: int, dst_sr: int) -> np.ndarray:
    """Cheap linear-interp resample. Mono float32 in/out."""
    if src_sr == dst_sr or pcm.size == 0:
        return pcm.astype(np.float32, copy=False)
    n_out = int(round(pcm.shape[-1] * dst_sr / src_sr))
    if n_out <= 1:
        return pcm[:n_out].astype(np.float32, copy=False)
    src_idx = np.linspace(0, pcm.shape[-1] - 1, n_out, dtype=np.float64)
    return np.interp(src_idx, np.arange(pcm.shape[-1]), pcm).astype(np.float32)


def pcm_to_int16(pcm_f32: np.ndarray) -> np.ndarray:
    return np.clip(pcm_f32 * 32767.0, -32768, 32767).astype(np.int16)


def int16_to_f32(pcm_i16: np.ndarray) -> np.ndarray:
    return (pcm_i16.astype(np.float32) / 32768.0)


# ── MoshiClient ─────────────────────────────────────────────────────────────
class MoshiClient:
    """
    Wraps one Moshi WS session. `send_pcm()` enqueues 24kHz mono float32 PCM.
    Background task encodes to Opus and ships frames; receive task decodes
    inbound audio and sentence-boundary text and invokes callbacks.
    """

    SENTENCE_BREAKS = '.!?\n'

    def __init__(self, url: str,
                 on_audio_pcm,           # callable(np.ndarray float32 mono @ MOSHI_SR)
                 on_text_final):         # callable(str)
        self.url = url
        self.on_audio_pcm = on_audio_pcm
        self.on_text_final = on_text_final
        self._send_q: asyncio.Queue = asyncio.Queue(maxsize=200)
        self._ws: Optional[aiohttp.ClientWebSocketResponse] = None
        self._session: Optional[aiohttp.ClientSession] = None
        self._tasks: List[asyncio.Task] = []
        self._text_buf = ''
        self._connected = asyncio.Event()
        self._stop = asyncio.Event()

    @property
    def connected(self) -> bool: return self._connected.is_set()

    async def start(self) -> None:
        if sphn is None:
            log.warning('sphn not installed — audio relay disabled')
            return
        self._tasks.append(asyncio.create_task(self._run_loop()))

    async def stop(self) -> None:
        self._stop.set()
        for t in self._tasks:
            t.cancel()
        if self._ws and not self._ws.closed:
            await self._ws.close()
        if self._session and not self._session.closed:
            await self._session.close()

    async def send_pcm(self, pcm_f32: np.ndarray) -> None:
        if not self.connected:
            return
        try:
            self._send_q.put_nowait(pcm_f32)
        except asyncio.QueueFull:
            log.warning('moshi send queue full, dropping frame')

    async def _run_loop(self) -> None:
        """Top-level loop: connect → run → on failure, back off and retry."""
        backoff = 1.0
        while not self._stop.is_set():
            try:
                await self._run_once()
                backoff = 1.0
            except Exception as e:
                log.warning('moshi session ended: %s', e)
            self._connected.clear()
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=backoff)
            except asyncio.TimeoutError:
                pass
            backoff = min(backoff * 1.7, MOSHI_RETRY_S)

    async def _run_once(self) -> None:
        log.info('connecting to moshi at %s', self.url)
        self._session = aiohttp.ClientSession()
        try:
            async with self._session.ws_connect(
                    self.url, params={'text_prompt': '', 'voice_prompt': ''},
                    timeout=20.0, max_msg_size=0) as ws:
                self._ws = ws
                # Wait for handshake byte 0x00
                msg = await asyncio.wait_for(ws.receive(), timeout=120.0)
                if msg.type != aiohttp.WSMsgType.BINARY:
                    raise RuntimeError(f'moshi closed before handshake: type={msg.type}')
                if not msg.data or msg.data[:1] != b'\x00':
                    raise RuntimeError(f'unexpected handshake bytes: {msg.data[:4]!r}')
                log.info('moshi handshake ok')
                self._connected.set()

                send_t = asyncio.create_task(self._sender_loop(ws))
                recv_t = asyncio.create_task(self._receiver_loop(ws))
                done, pending = await asyncio.wait(
                    {send_t, recv_t}, return_when=asyncio.FIRST_COMPLETED)
                for t in pending:
                    t.cancel()
                for t in done:
                    if t.exception():
                        raise t.exception()  # type: ignore
        finally:
            await self._session.close()
            self._session = None
            self._ws = None

    async def _sender_loop(self, ws) -> None:
        writer = sphn.OpusStreamWriter(MOSHI_SR)
        while not self._stop.is_set():
            pcm = await self._send_q.get()
            try:
                opus_chunk = writer.append_pcm(pcm)
            except Exception as e:
                log.debug('opus encode err: %s', e)
                continue
            if opus_chunk:
                await ws.send_bytes(b'\x01' + opus_chunk)

    async def _receiver_loop(self, ws) -> None:
        reader = sphn.OpusStreamReader(MOSHI_SR)
        async for msg in ws:
            if msg.type != aiohttp.WSMsgType.BINARY:
                if msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED,
                                aiohttp.WSMsgType.ERROR):
                    break
                continue
            data = msg.data
            if not data:
                continue
            kind = data[0]
            if kind == 0x01:           # audio
                pcm = reader.append_bytes(data[1:])
                if pcm.size > 0:
                    try:
                        self.on_audio_pcm(pcm.astype(np.float32, copy=False))
                    except Exception:
                        log.exception('on_audio_pcm callback failed')
            elif kind == 0x02:         # text token
                try:
                    tok = data[1:].decode('utf-8', errors='replace')
                except Exception:
                    continue
                self._text_buf += tok
                # emit on sentence boundary so partials don't flood
                while True:
                    pos = next((i for i, ch in enumerate(self._text_buf)
                                if ch in self.SENTENCE_BREAKS), -1)
                    if pos < 0:
                        break
                    sentence, self._text_buf = self._text_buf[:pos + 1], self._text_buf[pos + 1:]
                    sentence = sentence.strip()
                    if sentence:
                        try:
                            self.on_text_final(sentence)
                        except Exception:
                            log.exception('on_text_final callback failed')


# ── RoomBridge ──────────────────────────────────────────────────────────────
@dataclass
class RoomBridge:
    session_id: str
    room_name: str
    api: SwarmAPI
    room: rtc.Room = field(default_factory=rtc.Room)
    audio_source: Optional[rtc.AudioSource] = None
    moshi: Optional[MoshiClient] = None
    connected: bool = False
    _attached_streams: List[asyncio.Task] = field(default_factory=list)

    async def connect(self) -> None:
        info = await self.api.token(self.session_id, NODE_NAME)
        # outbound audio source — 24kHz mono (will resample if needed)
        self.audio_source = rtc.AudioSource(MOSHI_SR, 1)

        @self.room.on('track_subscribed')
        def _on_track(track, _pub, participant):
            if track.kind != rtc.TrackKind.KIND_AUDIO:
                return
            if participant.identity == NODE_NAME:
                return
            log.info('[%s] subscribing to mic from %s',
                     self.session_id[:8], participant.identity)
            self._attached_streams.append(
                asyncio.create_task(self._pump_audio_in(track)))

        @self.room.on('disconnected')
        def _on_disc(reason):
            self.connected = False
            log.warning('[%s] disconnected: %s', self.session_id[:8], reason)

        await self.room.connect(info['url'], info['token'])
        self.connected = True

        # Publish the synthesised-audio track
        track = rtc.LocalAudioTrack.create_audio_track('personaplex-tts', self.audio_source)
        await self.room.local_participant.publish_track(track)

        # Start moshi client with callbacks bound to this room
        self.moshi = MoshiClient(
            MOSHI_URL,
            on_audio_pcm=self._on_moshi_audio,
            on_text_final=self._on_moshi_text,
        )
        await self.moshi.start()
        log.info('[%s] joined room=%s; moshi worker started',
                 self.session_id[:8], self.room_name)

    async def disconnect(self) -> None:
        for t in self._attached_streams:
            t.cancel()
        self._attached_streams.clear()
        if self.moshi:
            await self.moshi.stop()
            self.moshi = None
        try:
            await self.room.disconnect()
        except Exception:
            pass
        self.connected = False

    async def _pump_audio_in(self, track: rtc.AudioTrack) -> None:
        """Browser mic → moshi: read frames, downmix, resample to MOSHI_SR."""
        stream = rtc.AudioStream(track)
        try:
            async for ev in stream:
                frame = ev.frame
                # frame.data is int16 interleaved; reshape & average to mono
                pcm = np.frombuffer(frame.data, dtype=np.int16)
                if frame.num_channels > 1:
                    pcm = pcm.reshape(-1, frame.num_channels).mean(axis=1).astype(np.int16)
                pcm_f32 = int16_to_f32(pcm)
                if frame.sample_rate != MOSHI_SR:
                    pcm_f32 = resample_linear(pcm_f32, frame.sample_rate, MOSHI_SR)
                if self.moshi:
                    await self.moshi.send_pcm(pcm_f32)
        except asyncio.CancelledError:
            pass
        except Exception:
            log.exception('[%s] audio-in pump failed', self.session_id[:8])
        finally:
            await stream.aclose()

    def _on_moshi_audio(self, pcm_f32: np.ndarray) -> None:
        """Moshi → LiveKit: enqueue synthesised PCM as audio frames."""
        if self.audio_source is None:
            return
        i16 = pcm_to_int16(pcm_f32)
        # AudioSource expects an AudioFrame
        frame = rtc.AudioFrame(
            data=i16.tobytes(),
            sample_rate=MOSHI_SR,
            num_channels=1,
            samples_per_channel=len(i16),
        )
        # capture_frame is async; schedule from the sync callback
        asyncio.create_task(self.audio_source.capture_frame(frame))

    def _on_moshi_text(self, sentence: str) -> None:
        """Publish FINAL transcript sentences as data events."""
        if not self.connected:
            return
        payload = {
            'from': NODE_NAME, 'type': 'transcript_final',
            'content': sentence,
        }
        asyncio.create_task(self.room.local_participant.publish_data(
            json.dumps(payload).encode('utf-8'),
            topic=TRANSCRIPT_TOPIC, reliable=True))


# ── Supervisor ──────────────────────────────────────────────────────────────
class Supervisor:
    def __init__(self, api: SwarmAPI):
        self.api = api
        self.rooms: Dict[str, RoomBridge] = {}
        self._stop = asyncio.Event()

    def stop(self): self._stop.set()

    async def run(self) -> None:
        log.info('supervisor starting; poll=%ss moshi=%s', POLL_INTERVAL_S, MOSHI_URL)
        while not self._stop.is_set():
            try:
                await self._reconcile()
            except Exception:
                log.exception('reconcile failed')
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=POLL_INTERVAL_S)
            except asyncio.TimeoutError:
                pass

    async def _reconcile(self) -> None:
        active = await self.api.list_active()
        active_ids = {s['id'] for s in active}

        for s in active:
            sid = s['id']
            if sid in self.rooms and self.rooms[sid].connected:
                continue
            if sid in self.rooms:
                await self.rooms[sid].disconnect()
                self.rooms.pop(sid, None)
            rb = RoomBridge(session_id=sid, room_name=s['room'], api=self.api)
            try:
                await rb.connect()
                self.rooms[sid] = rb
            except Exception as e:
                log.error('failed to bridge session %s: %s', sid[:8], e)

        for sid in list(self.rooms.keys()):
            if sid not in active_ids:
                log.info('[%s] session inactive, leaving', sid[:8])
                await self.rooms[sid].disconnect()
                self.rooms.pop(sid, None)

    async def shutdown(self) -> None:
        self.stop()
        for rb in list(self.rooms.values()):
            await rb.disconnect()
        self.rooms.clear()


# ── main ────────────────────────────────────────────────────────────────────
async def main() -> None:
    log.info('PersonaPlex Bridge starting; livekit=%s swarm=%s moshi=%s',
             LIVEKIT_URL, SWARM_WEB_URL, MOSHI_URL)
    if sphn is None:
        log.error('sphn module missing; bridge will run but cannot relay audio')
    api = SwarmAPI(SWARM_WEB_URL)
    sup = Supervisor(api)
    try:
        await sup.run()
    finally:
        await sup.shutdown()
        await api.close()


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass

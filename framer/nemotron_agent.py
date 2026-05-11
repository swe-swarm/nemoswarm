#!/usr/bin/env python3
"""
Nemotron LiveKit Agent (Phase 2 — multi-room, server-persisted).

One agent process joins every active Nemochat *session* room as a named
participant (anton / antonjr1 / antonjr2). For each user message it generates
an LLM response, streams tokens back over the room data channel, then
persists the final assistant message to swarm-web (idempotent on message_id)
and publishes a `persisted` ack so the UI can swap stream → durable bubble.

Design goals: small pieces, no globals, easy to read.
  • SwarmAPI       — typed httpx wrapper for the 4 endpoints we need
  • RoomSession    — one (session_id, room) lifecycle + turn handler
  • AgentSupervisor — polls /api/nemo/sessions/active and joins/leaves
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import AsyncIterator, Dict, List, Optional

import httpx
from livekit import rtc

# ── Config ──────────────────────────────────────────────────────────────────
LIVEKIT_URL = os.environ.get('LIVEKIT_URL', 'ws://10.1.8.66:7880')
NODE_NAME = os.environ.get('NODE_NAME', 'anton')
LLAMA_URL = os.environ.get('LLAMA_URL', 'http://10.1.0.4:30000')
LLAMA_MODEL = os.environ.get('LLAMA_MODEL', 'Nemotron-3-Nano-30B-A3B-UD-Q8_K_XL.gguf')
SWARM_WEB_URL = os.environ.get('SWARM_WEB_URL', 'http://10.1.8.66:8888')
POLL_INTERVAL_S = float(os.environ.get('POLL_INTERVAL_S', '5'))
TOKEN_REFRESH_S = float(os.environ.get('TOKEN_REFRESH_S', '3000'))  # < default 1h LiveKit TTL
MAX_HISTORY = int(os.environ.get('MAX_HISTORY', '30'))
LLM_MAX_TOKENS = int(os.environ.get('LLM_MAX_TOKENS', '1500'))
LLM_TEMPERATURE = float(os.environ.get('LLM_TEMPERATURE', '0.7'))
TURN_STAGGER_S = float(os.environ.get('TURN_STAGGER_S', '1.5'))
CHAT_TOPIC = 'nemoswarm.chat'

logging.basicConfig(level=logging.INFO,
                    format='%(asctime)s %(name)s %(levelname)s %(message)s')
log = logging.getLogger(f'agent[{NODE_NAME}]')


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


# ── SwarmAPI ────────────────────────────────────────────────────────────────
class SwarmAPI:
    """Thin async wrapper around the swarm-web nemo-sessions endpoints."""

    def __init__(self, base_url: str):
        self.base = base_url.rstrip('/')
        self._client = httpx.AsyncClient(timeout=20.0)

    async def close(self) -> None:
        await self._client.aclose()

    async def list_active(self) -> List[dict]:
        r = await self._client.get(f'{self.base}/api/nemo/sessions/active')
        r.raise_for_status()
        return r.json().get('sessions', [])

    async def messages(self, session_id: str, limit: int = MAX_HISTORY) -> List[dict]:
        r = await self._client.get(
            f'{self.base}/api/nemo/sessions/{session_id}/messages',
            params={'limit': limit})
        r.raise_for_status()
        return r.json().get('messages', [])

    async def token(self, session_id: str, identity: str) -> dict:
        r = await self._client.get(
            f'{self.base}/api/nemo/sessions/{session_id}/livekit-token',
            params={'identity': identity})
        r.raise_for_status()
        return r.json()

    async def append(self, session_id: str, payload: dict) -> dict:
        r = await self._client.post(
            f'{self.base}/api/nemo/sessions/{session_id}/messages',
            json=payload, timeout=30.0)
        r.raise_for_status()
        return r.json()


# ── LLM call ────────────────────────────────────────────────────────────────
async def stream_llm(messages: List[dict]) -> AsyncIterator[str]:
    """Stream tokens from llama-server with simple retry on 503/connect errors."""
    payload = {
        'model': LLAMA_MODEL, 'messages': messages,
        'max_tokens': LLM_MAX_TOKENS, 'temperature': LLM_TEMPERATURE,
        'stream': True,
    }
    # Generous read timeout: anton is a deep thinker (large ctx, --parallel 1).
    # connect/write fail fast; read allows long queue-then-stream waits.
    llm_timeout = httpx.Timeout(
        connect=30.0, write=30.0, pool=30.0,
        read=float(os.environ.get('LLM_READ_TIMEOUT', '1800')),  # 30 min default
    )
    for attempt in range(3):
        try:
            async with httpx.AsyncClient(timeout=llm_timeout) as client:
                async with client.stream('POST', f'{LLAMA_URL}/v1/chat/completions',
                                         json=payload) as resp:
                    if resp.status_code == 503:
                        log.warning('LLM 503, retry %d/3', attempt + 1)
                        await asyncio.sleep(2 * (attempt + 1))
                        continue
                    if resp.status_code != 200:
                        yield f'[Error: HTTP {resp.status_code}]'
                        return
                    async for line in resp.aiter_lines():
                        if not line or not line.startswith('data: '):
                            continue
                        chunk = line[6:].strip()
                        if chunk == '[DONE]':
                            return
                        try:
                            delta = json.loads(chunk).get('choices', [{}])[0].get('delta', {})
                            tok = delta.get('content', '')
                            if tok:
                                yield tok
                        except json.JSONDecodeError:
                            pass
                    return
        except httpx.ConnectError as e:
            log.warning('LLM connect error: %s, retry %d/3', e, attempt + 1)
            await asyncio.sleep(2 * (attempt + 1))
    yield '[Error: LLM unavailable after 3 retries]'


def build_messages(history: List[dict], turn_order: List[str]) -> List[dict]:
    """Build a llama.cpp-compatible message list (alternating, ends in user)."""
    others = ', '.join(n for n in turn_order if n != NODE_NAME) or 'none'
    system = (
        f"You are {NODE_NAME.upper()}, a Nemotron AI agent in the Nemoswarm "
        f"collaborative chatroom. Other agents in this room: {others}. "
        f"Be helpful, concise, and collaborative. Build on others' insights "
        f"when relevant. Keep responses under 200 words unless detail is "
        f"specifically needed."
    )
    raw: List[dict] = []
    for entry in history[-MAX_HISTORY:]:
        role = entry.get('role', 'user')
        content = (entry.get('content') or '').strip()
        if not content:
            continue
        if role == 'user':
            raw.append({'role': 'user', 'content': content})
        elif role == 'assistant':
            label = f"[{(entry.get('node') or 'AGENT').upper()}]"
            raw.append({'role': 'assistant', 'content': f'{label}: {content}'})
    # merge consecutive same-role
    merged: List[dict] = []
    for m in raw:
        if merged and merged[-1]['role'] == m['role']:
            merged[-1]['content'] += '\n\n' + m['content']
        else:
            merged.append(dict(m))
    # must end with user
    while merged and merged[-1]['role'] == 'assistant':
        merged.pop()
    return [{'role': 'system', 'content': system}] + merged


# ── RoomSession ─────────────────────────────────────────────────────────────
@dataclass
class RoomSession:
    session_id: str
    room_name: str
    turn_order: List[str]
    api: SwarmAPI
    room: rtc.Room = field(default_factory=rtc.Room)
    turn_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    seen_turns: set = field(default_factory=set)  # idempotency on inbound turn_id
    connected: bool = False
    token_url: str = ''
    last_token_at: float = 0.0

    async def connect(self) -> None:
        info = await self.api.token(self.session_id, NODE_NAME)
        self.token_url = info['url']
        token = info['token']

        @self.room.on('data_received')
        def _on_data(packet: rtc.DataPacket) -> None:
            try:
                payload = json.loads(packet.data.decode('utf-8'))
            except Exception as e:
                log.debug('[%s] non-json data: %s', self.session_id[:8], e)
                return
            if payload.get('from') == NODE_NAME:
                return
            if payload.get('type') != 'message':
                return
            sender = payload.get('from', 'unknown')
            if sender in self.turn_order:
                return  # other agents
            asyncio.create_task(self._handle_user(payload))

        @self.room.on('disconnected')
        def _on_disc(reason) -> None:
            self.connected = False
            log.warning('[%s] disconnected: %s', self.session_id[:8], reason)

        await self.room.connect(self.token_url, token)
        self.connected = True
        self.last_token_at = asyncio.get_event_loop().time()
        log.info('[%s] joined room=%s as %s', self.session_id[:8], self.room_name, NODE_NAME)

    async def disconnect(self) -> None:
        try:
            await self.room.disconnect()
        except Exception:
            pass
        self.connected = False

    async def _publish(self, payload: dict) -> None:
        try:
            await self.room.local_participant.publish_data(
                json.dumps(payload).encode('utf-8'), topic=CHAT_TOPIC)
        except Exception as e:
            log.warning('[%s] publish failed: %s', self.session_id[:8], e)

    async def _handle_user(self, incoming: dict) -> None:
        turn_id = incoming.get('turn_id') or f'turn-{uuid.uuid4().hex[:12]}'
        if turn_id in self.seen_turns:
            log.info('[%s] duplicate turn_id %s, skipping', self.session_id[:8], turn_id)
            return
        self.seen_turns.add(turn_id)
        # bound the set
        if len(self.seen_turns) > 256:
            self.seen_turns = set(list(self.seen_turns)[-128:])

        async with self.turn_lock:
            await self._respond(turn_id)

    async def _respond(self, turn_id: str) -> None:
        # stagger by index so multi-agent answers feel ordered
        idx = self.turn_order.index(NODE_NAME) if NODE_NAME in self.turn_order else 0
        if idx > 0:
            await asyncio.sleep(idx * TURN_STAGGER_S)

        message_id = f'msg-{uuid.uuid4().hex}'
        ts = utcnow_iso()
        await self._publish({'from': NODE_NAME, 'type': 'start',
                             'turn_id': turn_id, 'message_id': message_id,
                             'content': '', 'timestamp': ts})

        try:
            history = await self.api.messages(self.session_id)
        except Exception as e:
            log.error('[%s] history fetch failed: %s', self.session_id[:8], e)
            history = []

        messages = build_messages(history, self.turn_order)
        log.info('[%s] turn=%s history=%d ctx=%d',
                 self.session_id[:8], turn_id, len(history), len(messages))

        full = ''
        try:
            async for tok in stream_llm(messages):
                full += tok
                await self._publish({'from': NODE_NAME, 'type': 'token',
                                     'turn_id': turn_id, 'message_id': message_id,
                                     'content': tok, 'timestamp': utcnow_iso()})
                await asyncio.sleep(0.01)
        except Exception as e:
            full = f'[Error: {str(e)[:120]}]'
            log.exception('[%s] LLM stream failed', self.session_id[:8])

        await self._publish({'from': NODE_NAME, 'type': 'done',
                             'turn_id': turn_id, 'message_id': message_id,
                             'content': full, 'timestamp': utcnow_iso()})

        # Persist (idempotent — server keys on message_id)
        seq: Optional[int] = None
        try:
            res = await self.api.append(self.session_id, {
                'role': 'assistant', 'node': NODE_NAME, 'content': full,
                'message_id': message_id, 'turn_id': turn_id,
                'kind': 'text',
            })
            seq = res.get('seq')
            log.info('[%s] persisted turn=%s seq=%s dup=%s',
                     self.session_id[:8], turn_id, seq, res.get('duplicate', False))
        except Exception as e:
            log.error('[%s] persist failed: %s', self.session_id[:8], e)

        await self._publish({'from': NODE_NAME, 'type': 'persisted',
                             'turn_id': turn_id, 'message_id': message_id,
                             'seq': seq, 'timestamp': utcnow_iso()})


# ── AgentSupervisor ─────────────────────────────────────────────────────────
class AgentSupervisor:
    """Polls active sessions; maintains one RoomSession per session_id."""

    def __init__(self, api: SwarmAPI):
        self.api = api
        self.rooms: Dict[str, RoomSession] = {}
        self._stop = asyncio.Event()

    async def run(self) -> None:
        log.info('supervisor starting; poll=%ss', POLL_INTERVAL_S)
        while not self._stop.is_set():
            try:
                await self._reconcile()
            except Exception:
                log.exception('reconcile failed')
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=POLL_INTERVAL_S)
            except asyncio.TimeoutError:
                pass

    def stop(self) -> None:
        self._stop.set()

    async def _reconcile(self) -> None:
        active = await self.api.list_active()
        active_ids = {s['id'] for s in active}

        # Join new
        for s in active:
            sid = s['id']
            if sid in self.rooms and self.rooms[sid].connected:
                continue
            if sid in self.rooms and not self.rooms[sid].connected:
                # stale → drop and rebuild
                await self.rooms[sid].disconnect()
                self.rooms.pop(sid, None)
            rs = RoomSession(
                session_id=sid, room_name=s['room'],
                turn_order=s.get('turn_order') or ['antonjr2', 'antonjr1', 'anton'],
                api=self.api,
            )
            try:
                await rs.connect()
                self.rooms[sid] = rs
            except Exception as e:
                log.error('failed to join session %s: %s', sid[:8], e)

        # Leave stale (server says inactive)
        for sid in list(self.rooms.keys()):
            if sid not in active_ids:
                log.info('[%s] session no longer active, leaving', sid[:8])
                await self.rooms[sid].disconnect()
                self.rooms.pop(sid, None)

    async def shutdown(self) -> None:
        self.stop()
        for rs in list(self.rooms.values()):
            await rs.disconnect()
        self.rooms.clear()


# ── main ────────────────────────────────────────────────────────────────────
async def main() -> None:
    log.info('Nemotron Agent [%s] starting; livekit=%s llm=%s swarm=%s',
             NODE_NAME, LIVEKIT_URL, LLAMA_URL, SWARM_WEB_URL)
    api = SwarmAPI(SWARM_WEB_URL)
    sup = AgentSupervisor(api)
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

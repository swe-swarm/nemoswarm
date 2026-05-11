// Voice mode — connects to PersonaPlex Moshi WebSocket for full-duplex speech
// Protocol: ws://<host>:8998/api/chat?text_prompt=<>&voice_prompt=<>&...params...
// Handshake: server sends \x00 when ready
// Audio in:  client sends \x01 + OGG-Opus-page-bytes
// Audio out: server sends \x01 + OGG-Opus-page-bytes  (from sphn.OpusStreamWriter)
// Text out:  server sends \x02 + utf8_text
//
// Audio format: OGG Opus container, 24 kHz mono, 20ms frames (480 samples), 2 frames/page
// opusscript always decodes to 48kHz; aplay runs at 48kHz.
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { readdirSync } from 'fs';

import { LIVEKIT_BACKEND, LiveKitVoiceSession } from './livekit-room-client.js';

const SAMPLE_RATE = 24000;              // Moshi encode/decode rate
const PLAYBACK_RATE = 48000;            // opusscript always outputs 48kHz
const CHANNELS = 1;
const OPUS_FRAME_SAMPLES = 480;         // 20ms at 24kHz (official client encoderFrameSize=20)
const OPUS_FRAME_BYTES = OPUS_FRAME_SAMPLES * 2; // s16le = 960 bytes/frame
const FRAMES_PER_PAGE = 2;             // 2 frames per OGG page (official client maxFramesPerPage=2)
const OPUS_PAGE_MS = Math.round(OPUS_FRAME_SAMPLES * FRAMES_PER_PAGE / SAMPLE_RATE * 1000); // 40ms
const OPUS_DECODE_FRAME_SIZE = 5760;    // max decode buffer: 120ms @ 48kHz

// Model quality defaults matching official client (personaplex/client/src/useModelParams.ts)
const DEFAULT_MODEL_PARAMS = {
  audio_temperature: '0.8',
  text_temperature: '0.7',
  text_topk: '25',
  audio_topk: '250',
  pad_mult: '0',
  repetition_penalty: '1.0',
  repetition_penalty_context: '64',
};

export const AUDIO_SAVE_DIR = '/mnt/fschia/genai-media/audio';

// Known voice prompts from nvidia/personaplex-7b-v1
export const VOICE_PROMPTS = {
  'natf0': 'NATF0.pt', 'natf1': 'NATF1.pt', 'natf2': 'NATF2.pt', 'natf3': 'NATF3.pt',
  'natm0': 'NATM0.pt', 'natm1': 'NATM1.pt', 'natm2': 'NATM2.pt', 'natm3': 'NATM3.pt',
  'varf0': 'VARF0.pt', 'varf1': 'VARF1.pt', 'varf2': 'VARF2.pt', 'varf3': 'VARF3.pt', 'varf4': 'VARF4.pt',
  'varm0': 'VARM0.pt', 'varm1': 'VARM1.pt', 'varm2': 'VARM2.pt', 'varm3': 'VARM3.pt', 'varm4': 'VARM4.pt',
};

// Fleet nodes
export const FLEET_NODES = [
  { name: 'anton',    host: '10.1.0.4', port: 8998 },
  { name: 'antonjr1', host: '10.1.0.5', port: 8998 },
  { name: 'antonjr2', host: '10.1.0.6', port: 8998 },
];

export const DEFAULT_VOICE_BACKEND = 'personaplex';

const PERSONAPLEX_BACKEND = Object.freeze({
  name: DEFAULT_VOICE_BACKEND,
  label: 'PersonaPlex',
  description: 'Full-duplex voice over the existing PersonaPlex Moshi websocket flow.',
  aliases: ['moshi'],
  defaultNode: FLEET_NODES[0],
  nodes: FLEET_NODES,
});

const VOICELIVE_BACKEND = Object.freeze({
  ...LIVEKIT_BACKEND,
  label: 'VoiceLive',
  description: 'LiveKit room transport with PersonaPlex/Moshi as the audio conversation engine.',
  aliases: ['lk', 'voicelive', 'liveai', 'liveagents'],
  defaultNode: FLEET_NODES[0],
  nodes: FLEET_NODES,
});

export const VOICE_BACKENDS = Object.freeze({
  [PERSONAPLEX_BACKEND.name]: PERSONAPLEX_BACKEND,
  [VOICELIVE_BACKEND.name]: VOICELIVE_BACKEND,
});

const VOICE_BACKEND_ALIASES = new Map(
  Object.values(VOICE_BACKENDS).flatMap((backend) => [
    [backend.name, backend.name],
    ...backend.aliases.map((alias) => [alias, backend.name]),
  ])
);

export function resolveVoiceBackend(name = DEFAULT_VOICE_BACKEND) {
  const backendKey = VOICE_BACKEND_ALIASES.get(String(name).toLowerCase());
  if (!backendKey) throw new Error(`Unknown voice backend: ${name}`);
  return VOICE_BACKENDS[backendKey];
}

export function listVoiceBackends() {
  return Object.values(VOICE_BACKENDS);
}

// ── OGG Opus framing ──────────────────────────────────────────────────────────
// sphn.OpusStreamWriter/Reader (used by the server) operates on OGG Opus pages.
// We must wrap encoded Opus packets in valid OGG pages for the server to accept them,
// and parse the server's OGG pages to extract raw Opus packets for decoding.

// OGG CRC-32: polynomial 0x04c11db7, non-reflected (big-endian shift register)
const OGG_CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) {
      r = (r & 0x80000000) ? (((r << 1) >>> 0) ^ 0x04c11db7) : ((r << 1) >>> 0);
    }
    t[i] = r;
  }
  return t;
})();

function oggCRC32(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) {
    crc = (((crc << 8) >>> 0) ^ OGG_CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xFF]) >>> 0;
  }
  return crc;
}

// Build a single OGG page containing the given list of packets.
// granulePos should be in 48kHz output sample units for Opus.
function buildOggPage(headerType, granulePos, serial, seq, packets) {
  // OGG lacing: each packet split into segments of max 255 bytes;
  // a segment < 255 bytes terminates the packet (0 explicitly terminates 255-multiple packets).
  const lacingVals = [];
  for (const pkt of packets) {
    let rem = pkt.length;
    while (rem >= 255) { lacingVals.push(255); rem -= 255; }
    lacingVals.push(rem); // final lacing value (may be 0 for 255-multiple-length packets)
  }
  const headerLen = 27 + lacingVals.length;
  const dataLen = packets.reduce((s, p) => s + p.length, 0);
  const page = Buffer.allocUnsafe(headerLen + dataLen);

  page.write('OggS', 0, 'ascii');          // capture pattern
  page[4] = 0;                             // stream structure version
  page[5] = headerType;                    // 0x02=BOS, 0x04=EOS, 0x00=normal
  // Granule position as 64-bit LE (split into two 32-bit writes to avoid BigInt)
  page.writeUInt32LE(granulePos >>> 0, 6);
  page.writeUInt32LE(Math.floor(granulePos / 0x100000000) >>> 0, 10);
  page.writeUInt32LE(serial, 14);          // bitstream serial number
  page.writeUInt32LE(seq, 18);             // page sequence number
  page.writeUInt32LE(0, 22);              // CRC placeholder (filled after)
  page[26] = lacingVals.length;           // number of page segments
  for (let i = 0; i < lacingVals.length; i++) page[27 + i] = lacingVals[i];
  let off = headerLen;
  for (const pkt of packets) { pkt.copy(page, off); off += pkt.length; }
  page.writeUInt32LE(oggCRC32(page), 22); // fill CRC

  return page;
}

// Build the OpusHead + OpusTags header pages required to start an OGG Opus stream.
function buildOggOpusHeaders(sampleRate, serial) {
  // OpusHead packet: 19 bytes
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'ascii');
  head[8] = 1;                        // version
  head[9] = CHANNELS;                 // channel count
  head.writeUInt16LE(312, 10);        // pre-skip: 312 samples at 48kHz (~6.5ms)
  head.writeUInt32LE(sampleRate, 12); // original input sample rate
  head.writeInt16LE(0, 16);           // output gain: 0 dB
  head[18] = 0;                       // channel map family 0 (mono/stereo RTP)

  // OpusTags packet: mandatory comment header
  const vendor = Buffer.from('nemo-cli');
  const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
  tags.write('OpusTags', 0, 'ascii');
  tags.writeUInt32LE(vendor.length, 8);
  vendor.copy(tags, 12);
  tags.writeUInt32LE(0, 12 + vendor.length); // zero user comments

  return Buffer.concat([
    buildOggPage(0x02, 0, serial, 0, [head]), // BOS page (page sequence 0)
    buildOggPage(0x00, 0, serial, 1, [tags]), // comment page (page sequence 1)
  ]);
}

// Streaming OGG parser: accumulates incoming bytes, returns extracted raw Opus packets.
// Handles OGG page structure and skips header packets (OpusHead, OpusTags).
// Correctly handles packets that span multiple pages (cross-page continuation).
class OggStreamParser {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.pktBuf = Buffer.alloc(0); // accumulates bytes for a cross-page packet
  }

  // Feed raw OGG bytes (as received from the server's \x01 messages).
  // Returns array of complete raw Opus packets ready for decoding.
  feed(data) {
    this.buf = Buffer.concat([this.buf, data]);
    const packets = [];
    const OGGS = Buffer.from([0x4F, 0x67, 0x67, 0x53]); // 'OggS'

    while (this.buf.length >= 27) {
      // Re-sync if not at an OGG capture pattern
      if (this.buf[0] !== 0x4F || this.buf[1] !== 0x67 ||
          this.buf[2] !== 0x67 || this.buf[3] !== 0x53) {
        const idx = this.buf.indexOf(OGGS, 1);
        if (idx === -1) { this.buf = this.buf.slice(Math.max(0, this.buf.length - 3)); break; }
        this.buf = this.buf.slice(idx);
        continue;
      }

      const numSegs = this.buf[26];
      if (this.buf.length < 27 + numSegs) break;

      let pageDataLen = 0;
      const segTable = [];
      for (let i = 0; i < numSegs; i++) {
        segTable.push(this.buf[27 + i]);
        pageDataLen += this.buf[27 + i];
      }

      const pageLen = 27 + numSegs + pageDataLen;
      if (this.buf.length < pageLen) break;

      // Extract packets: a segment < 255 terminates the current packet
      const dataBase = 27 + numSegs;
      let pos = 0;
      for (const segSize of segTable) {
        if (segSize > 0) {
          this.pktBuf = Buffer.concat([
            this.pktBuf,
            this.buf.slice(dataBase + pos, dataBase + pos + segSize),
          ]);
        }
        pos += segSize;
        if (segSize < 255) {
          // Packet complete — skip OGG Opus header packets, emit audio packets
          if (this.pktBuf.length > 0) {
            const magic = this.pktBuf.slice(0, 8).toString('ascii');
            if (magic !== 'OpusHead' && magic !== 'OpusTags') {
              packets.push(Buffer.from(this.pktBuf));
            }
          }
          this.pktBuf = Buffer.alloc(0);
        }
      }

      this.buf = this.buf.slice(pageLen);
    }

    return packets;
  }
}

function pcmBufferFromFrame(frame) {
  if (Buffer.isBuffer(frame)) return frame;
  if (frame instanceof Int16Array) {
    return Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  }
  if (frame instanceof ArrayBuffer) return Buffer.from(frame);
  if (ArrayBuffer.isView(frame)) {
    return Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  }
  if (frame && typeof frame === 'object' && 'data' in frame) {
    return pcmBufferFromFrame(frame.data);
  }
  throw new TypeError('PersonaPlex PCM frame must be Int16Array, Buffer, ArrayBuffer, or an ArrayBuffer view');
}

function int16ViewFromDecoded(decoded) {
  if (decoded instanceof Int16Array) return decoded;
  if (Buffer.isBuffer(decoded) || ArrayBuffer.isView(decoded)) {
    return new Int16Array(decoded.buffer, decoded.byteOffset, Math.floor(decoded.byteLength / 2));
  }
  if (decoded instanceof ArrayBuffer) return new Int16Array(decoded);
  throw new TypeError('Decoded PersonaPlex audio must be an Int16Array-compatible buffer');
}

// ── PersonaPlexVoiceSession ───────────────────────────────────────────────────

export class PersonaPlexVoiceSession extends EventEmitter {
  constructor(host = '10.1.0.4', port = 8998, options = {}) {
    super();
    this.host = host;
    this.port = port;
    this.textPrompt = options.textPrompt ?? 'You are Nemo, a helpful AI voice assistant.';
    this.voicePrompt = options.voicePrompt ?? 'NATF0.pt';
    this.modelParams = { ...DEFAULT_MODEL_PARAMS, ...(options.modelParams ?? {}) };

    // Test mode: send silence instead of mic, discard received audio
    this.testMode = options.testMode ?? false;
    this.testDurationMs = options.testDurationMs ?? 10_000;
    this.enableMicrophone = options.enableMicrophone ?? !this.testMode;
    this.enablePlayback = options.enablePlayback ?? !this.testMode;
    this.emitAudioFrames = options.emitAudioFrames ?? false;

    this.ws = null;
    this.mic = null;
    this.player = null;
    this.encoder = null;
    this.decoder = null;
    this.running = false;
    this.ready = false;
    this.micBuf = Buffer.alloc(0);
    this._silenceTimer = null;
    this._pendingMicPackets = []; // accumulate FRAMES_PER_PAGE frames before sending

    // OGG stream state (initialized in start())
    this.oggSerial = 0;
    this.oggPageSeq = 2; // 0=OpusHead page, 1=OpusTags page, 2+=audio
    this.oggGranule = 0; // cumulative output samples at 48kHz
    this.oggParser = null;
  }

  async start() {
    const { default: OpusScript } = await import('opusscript');
    // Use AUDIO application (2049) matching official client encoderApplication=2049
    this.encoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
    if (this.enablePlayback || this.emitAudioFrames) {
      this.decoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
      this.oggParser = new OggStreamParser();
    }
    this.oggSerial = (Math.random() * 0xFFFFFFFF) >>> 0;
    this.oggPageSeq = 2;
    this.oggGranule = 0;
    await this._connect();
  }

  async _connect() {
    const { default: WebSocket } = await import('ws');
    // Include model quality params in URL (server reads but currently ignores them;
    // LMGen defaults match so audio quality is at correct settings regardless)
    const params = new URLSearchParams({
      text_prompt: this.textPrompt,
      voice_prompt: this.voicePrompt,
      ...this.modelParams,
    });
    const url = `ws://${this.host}:${this.port}/api/chat?${params}`;
    this.emit('status', `Connecting to ${this.host}:${this.port} ...`);

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        this.emit('status', 'Connected — waiting for model ready signal...');
      });

      this.ws.on('message', (data) => {
        if (!Buffer.isBuffer(data)) return;

        if (!this.ready) {
          if (data.length >= 1 && data[0] === 0x00) {
            this.ready = true;
            this.running = true;
            this.emit('status', 'Model ready — audio streaming active');
            // Send OGG stream headers so server's OpusStreamReader can initialize
            this._sendOggHeaders();
            if (this.testMode || this.enableMicrophone) this._startMic();
            if (this.enablePlayback) this._startPlayer();
            resolve();
          }
          return;
        }

        const kind = data[0];
        const payload = data.slice(1);
        if (kind === 0x01) {
          this._playAudio(payload);
        } else if (kind === 0x02) {
          this.emit('text', payload.toString('utf8'));
        }
      });

      this.ws.on('error', (err) => {
        if (!this.ready) reject(err);
        else this.emit('error', err);
      });

      this.ws.on('close', () => {
        this.running = false;
        if (this._silenceTimer) { clearInterval(this._silenceTimer); this._silenceTimer = null; }
        this.emit('close');
      });

      const timeout = setTimeout(() => {
        if (!this.ready) reject(new Error('Timeout waiting for model ready (>120s)'));
      }, 120_000);
      this.once('close', () => clearTimeout(timeout));
    });
  }

  // Send OpusHead + OpusTags OGG pages to the server as the first \x01 message.
  // sphn.OpusStreamReader requires these headers to know the sample rate and format.
  _sendOggHeaders() {
    const headers = buildOggOpusHeaders(SAMPLE_RATE, this.oggSerial);
    const msg = Buffer.allocUnsafe(1 + headers.length);
    msg[0] = 0x01;
    headers.copy(msg, 1);
    if (this.ws?.readyState === 1) this.ws.send(msg);
  }

  // Pack encoded Opus packets into one OGG data page and return the \x01 wire message.
  _buildAudioMsg(packets) {
    // Granule position: cumulative output samples at 48kHz
    // Each 480-sample input frame at 24kHz → 960 output samples at 48kHz
    this.oggGranule += packets.length * OPUS_FRAME_SAMPLES * (PLAYBACK_RATE / SAMPLE_RATE);
    const page = buildOggPage(0x00, this.oggGranule, this.oggSerial, this.oggPageSeq++, packets);
    const msg = Buffer.allocUnsafe(1 + page.length);
    msg[0] = 0x01;
    page.copy(msg, 1);
    return msg;
  }

  sendPcmAudioFrame(frame, options = {}) {
    if (!this.running || this.ws?.readyState !== 1) return false;

    const sampleRate = options.sampleRate ?? SAMPLE_RATE;
    const channels = options.channels ?? CHANNELS;
    if (sampleRate !== SAMPLE_RATE || channels !== CHANNELS) {
      throw new Error(`PersonaPlex expects ${SAMPLE_RATE}Hz mono PCM, got ${sampleRate}Hz/${channels}ch`);
    }

    this.micBuf = Buffer.concat([this.micBuf, pcmBufferFromFrame(frame)]);
    this._sendMicFrames();
    return true;
  }

  _startMic() {
    if (this.testMode) {
      // Send encoded silence at 25 pages/sec to keep stream alive and trigger model
      const silence = new Int16Array(OPUS_FRAME_SAMPLES); // all zeros
      let elapsed = 0;
      this._silenceTimer = setInterval(() => {
        if (!this.running) return;
        if (elapsed >= this.testDurationMs) {
          this.stop();
          return;
        }
        try {
          // Encode two 20ms silence frames → one 40ms OGG page (2 packets/page)
          const f1 = this.encoder.encode(silence, OPUS_FRAME_SAMPLES);
          const f2 = this.encoder.encode(silence, OPUS_FRAME_SAMPLES);
          if (f1?.length > 0 && f2?.length > 0 && this.ws?.readyState === 1) {
            this.ws.send(this._buildAudioMsg([Buffer.from(f1), Buffer.from(f2)]));
          }
        } catch (_) {}
        elapsed += OPUS_PAGE_MS;
      }, OPUS_PAGE_MS);
      return;
    }

    if (!this.enableMicrophone) return;

    // Live mic capture via arecord
    this.mic = spawn('arecord', [
      '--device=default', '--format=S16_LE',
      `--rate=${SAMPLE_RATE}`, '--channels=1', '--file-type=raw',
    ]);
    this.mic.stderr.on('data', () => {});
    this.mic.on('error', (e) => this.emit('error', new Error(`mic: ${e.message}`)));
    this.mic.stdout.on('data', (chunk) => {
      if (!this.running) return;
      this.micBuf = Buffer.concat([this.micBuf, chunk]);
      this._sendMicFrames();
    });
  }

  _sendMicFrames() {
    // Encode one 20ms frame at a time, batch FRAMES_PER_PAGE frames per OGG page
    while (this.micBuf.length >= OPUS_FRAME_BYTES && this.running) {
      const frame = this.micBuf.slice(0, OPUS_FRAME_BYTES);
      this.micBuf = this.micBuf.slice(OPUS_FRAME_BYTES);
      try {
        const pcm = new Int16Array(
          frame.buffer.slice(frame.byteOffset, frame.byteOffset + OPUS_FRAME_BYTES)
        );
        const encoded = this.encoder.encode(pcm, OPUS_FRAME_SAMPLES);
        if (encoded?.length > 0) this._pendingMicPackets.push(Buffer.from(encoded));
      } catch (_) {}

      if (this._pendingMicPackets.length >= FRAMES_PER_PAGE) {
        const pkts = this._pendingMicPackets.splice(0, FRAMES_PER_PAGE);
        if (this.ws?.readyState === 1) {
          this.ws.send(this._buildAudioMsg(pkts));
        }
      }
    }
  }

  _startPlayer() {
    if (this.testMode) return; // server saves WAV; no local playback in test mode

    // Play at PLAYBACK_RATE (48kHz): opusscript always decodes to 48kHz internally
    this.player = spawn('aplay', [
      '--device=default', '--format=S16_LE',
      `--rate=${PLAYBACK_RATE}`, '--channels=1', '--file-type=raw',
    ]);
    this.player.stderr.on('data', () => {});
    this.player.on('error', (e) => this.emit('error', new Error(`player: ${e.message}`)));
  }

  // payload is raw OGG page bytes received from the server (\x01 stripped)
  _playAudio(oggPayload) {
    if (!this.oggParser) return;
    // Parse OGG pages → extract raw Opus packets → decode → PCM at 48kHz → aplay
    const packets = this.oggParser.feed(oggPayload);
    for (const pkt of packets) {
      try {
        const decoded = this.decoder.decode(pkt, OPUS_DECODE_FRAME_SIZE);
        if (decoded?.length > 0) {
          const pcm = int16ViewFromDecoded(decoded);
          this.emit('audioFrame', {
            data: pcm,
            sampleRate: PLAYBACK_RATE,
            channels: CHANNELS,
            samplesPerChannel: pcm.length / CHANNELS,
          });
          if (this.enablePlayback && this.player?.stdin?.writable) {
            this.player.stdin.write(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
          }
        }
      } catch (_) {}
    }
  }

  stop() {
    this.running = false;
    if (this._silenceTimer) { clearInterval(this._silenceTimer); this._silenceTimer = null; }
    if (this.ws?.readyState === 1) this.ws.close();
    this.mic?.kill('SIGTERM');
    if (this.player?.stdin?.writable) this.player.stdin.end();
    this.encoder?.delete?.();
    this.decoder?.delete?.();
  }
}

// ── VoiceLiveSession ──────────────────────────────────────────────────────────
// LiveKit remains the room/data transport while PersonaPlex/Moshi owns audio
// conversation. The inherited LiveKit agent loop continues to handle text/data.
export class VoiceLiveSession extends LiveKitVoiceSession {
  constructor(options = {}) {
    const {
      personaHost,
      personaPort,
      audioHost,
      audioPort,
      personaSessionFactory,
      textPrompt,
      voicePrompt,
      modelParams,
      ...livekitOptions
    } = options;

    super({
      ...livekitOptions,
      enableMicrophone: livekitOptions.enableMicrophone ?? false,
      enablePlayback: livekitOptions.enablePlayback ?? false,
    });

    this.personaHost = personaHost ?? audioHost ?? PERSONAPLEX_BACKEND.defaultNode.host;
    this.personaPort = personaPort ?? audioPort ?? PERSONAPLEX_BACKEND.defaultNode.port;
    this.persona = personaSessionFactory
      ? personaSessionFactory({
          host: this.personaHost,
          port: this.personaPort,
          textPrompt,
          voicePrompt,
          modelParams,
        })
      : new PersonaPlexVoiceSession(this.personaHost, this.personaPort, {
          textPrompt,
          voicePrompt,
          modelParams,
          enableMicrophone: false,
          enablePlayback: false,
          emitAudioFrames: true,
        });

    this._personaAudioQueue = Promise.resolve();
    this._bindPersonaPlex();
  }

  _bindPersonaPlex() {
    this.persona.on?.('status', (message) => this.emit('status', `PersonaPlex: ${message}`));
    this.persona.on?.('error', (error) => this.emit('error', error));
    this.persona.on?.('text', (text) => this.emit('text', text));
    this.persona.on?.('audioFrame', (frame) => {
      this._personaAudioQueue = this._personaAudioQueue
        .then(() => this.publishAudioFrame(frame.data, {
          sampleRate: frame.sampleRate,
          channels: frame.channels,
          samplesPerChannel: frame.samplesPerChannel,
        }))
        .catch((error) => this.emit('error', error));
    });
  }

  async start(options = {}) {
    await this.persona.start();
    try {
      return await super.start(options);
    } catch (error) {
      await this.persona.stop?.();
      throw error;
    }
  }

  async stop() {
    await super.stop();
    await this._personaAudioQueue.catch(() => {});
    this.persona.stop?.();
  }

  async _handleTrackSubscribed(track, publication, participant) {
    if (publication?.kind && String(publication.kind).toLowerCase() !== 'audio') return;

    const key = this._remoteTrackKey(publication, track, participant);
    if (this.remoteAudioReaders.has(key)) return;

    try {
      const stream = await this.createAudioStream(track, {
        sampleRate: SAMPLE_RATE,
        numChannels: CHANNELS,
        frameSizeMs: this.frameSizeMs,
      });
      const reader = stream.getReader();
      this.remoteAudioReaders.set(key, reader);
      void this._pumpRemoteAudioToPersonaPlex(key, reader);
    } catch (error) {
      this.emit('error', new Error(`LiveKit to PersonaPlex audio setup failed: ${error.message}`));
    }
  }

  async _pumpRemoteAudioToPersonaPlex(key, reader) {
    try {
      while (this.running) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        this.persona.sendPcmAudioFrame(value.data ?? value, {
          sampleRate: value.sampleRate ?? SAMPLE_RATE,
          channels: value.channels ?? value.numChannels ?? CHANNELS,
          samplesPerChannel: value.samplesPerChannel,
        });
      }
    } catch (error) {
      if (this.running) {
        this.emit('error', new Error(`LiveKit to PersonaPlex audio bridge failed: ${error.message}`));
      }
    } finally {
      this.remoteAudioReaders.delete(key);
    }
  }
}

export { PersonaPlexVoiceSession as VoiceSession };
export { LIVEKIT_BACKEND, LiveKitVoiceSession };

export function createVoiceSession({
  backend = DEFAULT_VOICE_BACKEND,
  host,
  port,
  ...options
} = {}) {
  const resolvedBackend = resolveVoiceBackend(backend);
  if (resolvedBackend.name === PERSONAPLEX_BACKEND.name) {
    const targetHost = host ?? resolvedBackend.defaultNode.host;
    const targetPort = port ?? resolvedBackend.defaultNode.port;
    return new PersonaPlexVoiceSession(targetHost, targetPort, options);
  }
  if (resolvedBackend.name === LIVEKIT_BACKEND.name) {
    const hostIsLiveKitUrl = host && String(host).includes('://');
    return new VoiceLiveSession({
      host: hostIsLiveKitUrl ? host : undefined,
      port: hostIsLiveKitUrl ? port : undefined,
      personaHost: options.personaHost ?? (!hostIsLiveKitUrl ? host : undefined),
      personaPort: options.personaPort ?? (!hostIsLiveKitUrl ? port : undefined),
      ...options,
    });
  }

  throw new Error(`Voice backend is registered but not implemented: ${resolvedBackend.name}`);
}

// ── High-level test helper ────────────────────────────────────────────────────
// Connects, sends silence for durationMs, closes, returns transcript + saved files.
export async function runVoiceTest(node, options = {}) {
  const host = node.host;
  const port = node.port ?? 8998;
  const durationMs = options.durationMs ?? 10_000;
  const voiceFile = options.voicePrompt ?? 'NATF0.pt';
  const audioDir = options.audioDir ?? AUDIO_SAVE_DIR;
  const textPrompt = options.textPrompt ??
    'Greet the user warmly and introduce yourself as Nemo, a local AI assistant running on NVIDIA hardware. Keep it to two or three sentences.';

  // Snapshot audio dir before session
  let filesBefore = new Set();
  try { filesBefore = new Set(readdirSync(audioDir).filter(f => f.endsWith('.wav'))); } catch (_) {}

  const session = createVoiceSession({
    backend: DEFAULT_VOICE_BACKEND,
    host,
    port,
    textPrompt,
    voicePrompt: voiceFile,
    testMode: true,
    testDurationMs: durationMs,
  });

  const texts = [];
  session.on('text', (t) => texts.push(t));
  session.on('status', (msg) => options.onStatus?.(msg));
  session.on('error', (e) => options.onError?.(e));

  await session.start();

  // Wait for session close (silence timer triggers stop → ws.close → 'close' event)
  await new Promise((resolve) => session.once('close', resolve));

  // Brief pause for server to finish writing the WAV file
  await new Promise((r) => setTimeout(r, 1000));

  // Find new WAV files created during this session
  let savedFiles = [];
  try {
    const filesAfter = readdirSync(audioDir).filter(f => f.endsWith('.wav'));
    savedFiles = filesAfter.filter(f => !filesBefore.has(f)).map(f => `${audioDir}/${f}`);
  } catch (_) {}

  return {
    host,
    nodeName: node.name,
    text: texts.join('').trim(),
    savedFiles,
    durationMs,
  };
}

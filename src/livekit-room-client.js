import { spawn } from 'child_process';
import { EventEmitter } from 'events';

const DEFAULT_AUDIO_TRACK_NAME = 'nemo-audio';
const DEFAULT_SAMPLE_RATE = 24_000;
const DEFAULT_CHANNELS = 1;
const DEFAULT_FRAME_SIZE_MS = 20;
const DEFAULT_OUTPUT_TOPIC = 'nemo.assistant';
const DEFAULT_INPUT_TOPICS = Object.freeze(['nemo.prompt', 'nemo.user']);
const TEXT_DECODER = new TextDecoder();

export const LIVEKIT_BACKEND = Object.freeze({
  name: 'livekit',
  label: 'LiveKit',
  description: 'Native LiveKit room runtime for token-aware audio and data transport.',
  aliases: ['lk'],
});

function defaultRtcLoader() {
  return import('@livekit/rtc-node');
}

function defaultServerSdkLoader() {
  return import('livekit-server-sdk');
}

function normalizeProtocol(protocol, secure) {
  if (!protocol) return secure === false ? 'ws' : 'wss';
  if (protocol === 'http') return 'ws';
  if (protocol === 'https') return 'wss';
  return protocol;
}

function normalizeLiveKitUrl({ url, host, port, protocol, secure } = {}) {
  if (url) {
    return String(url)
      .replace(/^https:\/\//i, 'wss://')
      .replace(/^http:\/\//i, 'ws://');
  }
  if (!host) return undefined;
  const scheme = normalizeProtocol(protocol, secure);
  const suffix = port ? `:${port}` : '';
  return `${scheme}://${host}${suffix}`;
}

function normalizeParticipantMetadata(metadata) {
  if (metadata == null) return undefined;
  return typeof metadata === 'string' ? metadata : JSON.stringify(metadata);
}

function normalizeParticipantAttributes(attributes) {
  if (!attributes || typeof attributes !== 'object') return undefined;
  return Object.fromEntries(
    Object.entries(attributes).map(([key, value]) => [key, String(value)])
  );
}

function normalizeDestinationIdentities(destinationIdentities) {
  if (destinationIdentities == null) return undefined;
  if (Array.isArray(destinationIdentities)) {
    return destinationIdentities.map((identity) => String(identity));
  }
  return [String(destinationIdentities)];
}

function toUint8Array(data) {
  if (data instanceof Uint8Array) return data;
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new TypeError(
    'LiveKit data payload must be a string, Uint8Array, ArrayBuffer, or ArrayBuffer view'
  );
}

function toInt16Array(data) {
  if (data instanceof Int16Array) return data;
  const bytes = toUint8Array(data);
  if (bytes.byteLength % 2 !== 0) {
    throw new Error('LiveKit PCM audio payload must contain an even number of bytes');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pcm = new Int16Array(bytes.byteLength / 2);
  for (let index = 0; index < pcm.length; index += 1) {
    pcm[index] = view.getInt16(index * 2, true);
  }
  return pcm;
}

function createAudioFrame(rtc, frame, defaults) {
  if (frame instanceof rtc.AudioFrame) return frame;

  const descriptor = frame && typeof frame === 'object' && 'data' in frame
    ? frame
    : { data: frame };

  const sampleRate = descriptor.sampleRate ?? defaults.sampleRate;
  const channels = descriptor.channels ?? defaults.channels;
  if (!sampleRate) throw new Error('LiveKit audio frames require a sample rate');
  if (!channels) throw new Error('LiveKit audio frames require a channel count');

  const pcm = toInt16Array(descriptor.data);
  const samplesPerChannel = descriptor.samplesPerChannel ?? (pcm.length / channels);
  if (!Number.isInteger(samplesPerChannel) || samplesPerChannel * channels !== pcm.length) {
    throw new Error('LiveKit audio frame data length must align to full channels');
  }

  return new rtc.AudioFrame(pcm, sampleRate, channels, samplesPerChannel);
}

function toBuffer(view) {
  if (Buffer.isBuffer(view)) return view;
  const bytes = toUint8Array(view);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function parseIncomingDataPayload(payload) {
  const text = TEXT_DECODER.decode(toUint8Array(payload)).trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'string') return parsed.trim() || null;
    if (!parsed || typeof parsed !== 'object') return text;
    if (parsed.type === 'assistant_message') return null;
    if (typeof parsed.message === 'string') return parsed.message.trim() || null;
    if (typeof parsed.content === 'string') return parsed.content.trim() || null;
  } catch {
    return text;
  }

  return text;
}

export class LiveKitRoomClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.backend = LIVEKIT_BACKEND.name;

    this.host = options.host;
    this.port = options.port;
    this.protocol = options.protocol;
    this.secure = options.secure;
    this.url = normalizeLiveKitUrl(options);

    this.roomName = options.roomName;
    this.token = options.token;
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.ttl = options.ttl;

    this.participantIdentity = options.participantIdentity ?? options.identity;
    this.participantName = options.participantName ?? options.name;
    this.participantMetadata = normalizeParticipantMetadata(
      options.participantMetadata ?? options.metadata
    );
    this.participantAttributes = normalizeParticipantAttributes(
      options.participantAttributes ?? options.attributes
    );

    this.autoSubscribe = options.autoSubscribe ?? true;
    this.dynacast = options.dynacast ?? true;
    this.canPublish = options.canPublish ?? true;
    this.canSubscribe = options.canSubscribe ?? true;
    this.canPublishData = options.canPublishData ?? true;
    this.roomOptions = { ...(options.roomOptions ?? {}) };

    this.audioTrackName = options.audioTrackName ?? options.trackName ?? DEFAULT_AUDIO_TRACK_NAME;
    this.sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
    this.channels = options.channels ?? DEFAULT_CHANNELS;

    this._rtcLoader = options.rtcLoader ?? defaultRtcLoader;
    this._serverSdkLoader = options.serverSdkLoader ?? defaultServerSdkLoader;
    this._rtc = null;
    this._serverSdk = null;

    this.room = null;
    this.connected = false;
    this.localAudioSource = null;
    this.localAudioTrack = null;
    this.localAudioPublication = null;
  }

  async start(options = {}) {
    return this.connect(options);
  }

  async stop() {
    return this.disconnect();
  }

  async connect(options = {}) {
    const rtc = await this._loadRtc();
    const room = this.room ?? new rtc.Room();
    if (!this.room) {
      this.room = room;
      this._bindRoomEvents(room, rtc);
    }

    const url = normalizeLiveKitUrl({
      url: options.url ?? this.url,
      host: options.host ?? this.host,
      port: options.port ?? this.port,
      protocol: options.protocol ?? this.protocol,
      secure: options.secure ?? this.secure,
    });
    if (!url) throw new Error('LiveKit backend requires a room url or host');

    this.url = url;
    this.roomName = options.roomName ?? this.roomName;
    this.token = options.token ?? this.token;
    this.apiKey = options.apiKey ?? this.apiKey;
    this.apiSecret = options.apiSecret ?? this.apiSecret;
    this.participantIdentity = options.participantIdentity ?? options.identity ?? this.participantIdentity;
    this.participantName = options.participantName ?? options.name ?? this.participantName;
    if ('participantMetadata' in options || 'metadata' in options) {
      this.participantMetadata = normalizeParticipantMetadata(
        options.participantMetadata ?? options.metadata
      );
    }
    if ('participantAttributes' in options || 'attributes' in options) {
      this.participantAttributes = normalizeParticipantAttributes(
        options.participantAttributes ?? options.attributes
      );
    }

    const token = await this._resolveToken(options);
    this.emit('status', `Connecting to LiveKit room ${this.roomName ?? '(unspecified room)'} ...`);

    await room.connect(url, token, {
      ...this.roomOptions,
      ...(options.roomOptions ?? {}),
      autoSubscribe: options.autoSubscribe ?? this.autoSubscribe,
      dynacast: options.dynacast ?? this.dynacast,
    });

    this.connected = true;
    return room;
  }

  async disconnect() {
    this.connected = false;
    const room = this.room;
    try {
      if (room) await room.disconnect();
    } finally {
      this.room = null;
      await this._closeLocalAudio();
    }
  }

  async publishData(payload, options = {}) {
    if (!this.room?.localParticipant) throw new Error('LiveKit room is not connected');
    const data = toUint8Array(payload);
    await this.room.localParticipant.publishData(data, {
      reliable: options.reliable ?? true,
      destination_identities: normalizeDestinationIdentities(
        options.destinationIdentities ?? options.destination_identities
      ),
      topic: options.topic,
    });
    this.emit('dataPublished', { payload: data, options });
    return data;
  }

  async streamText(options = {}) {
    if (!this.room?.localParticipant) throw new Error('LiveKit room is not connected');
    return this.room.localParticipant.streamText({
      topic: options.topic,
      attributes: normalizeParticipantAttributes(options.attributes),
      destinationIdentities: normalizeDestinationIdentities(options.destinationIdentities),
      streamId: options.streamId,
      senderIdentity: options.senderIdentity,
    });
  }

  async sendText(text, options = {}) {
    if (!this.room?.localParticipant) throw new Error('LiveKit room is not connected');
    const result = await this.room.localParticipant.sendText(String(text), {
      topic: options.topic,
      attributes: normalizeParticipantAttributes(options.attributes),
      destinationIdentities: normalizeDestinationIdentities(options.destinationIdentities),
      streamId: options.streamId,
    });
    this.emit('textSent', { text: String(text), options, result });
    return result;
  }

  async sendChatMessage(text, options = {}) {
    if (!this.room?.localParticipant) throw new Error('LiveKit room is not connected');
    const message = await this.room.localParticipant.sendChatMessage(
      String(text),
      normalizeDestinationIdentities(options.destinationIdentities),
      options.senderIdentity
    );
    this.emit('chatMessageSent', { message, options });
    return message;
  }

  async ensureLocalAudioTrack(options = {}) {
    if (!this.room?.localParticipant) throw new Error('LiveKit room is not connected');
    const rtc = await this._loadRtc();

    const sampleRate = options.sampleRate ?? this.sampleRate;
    const channels = options.channels ?? this.channels;
    if (
      this.localAudioSource &&
      (this.localAudioSource.sampleRate !== sampleRate ||
        this.localAudioSource.numChannels !== channels)
    ) {
      throw new Error('LiveKit audio source is already initialized with a different format');
    }

    if (!this.localAudioSource) {
      this.localAudioSource = new rtc.AudioSource(sampleRate, channels);
      this.localAudioTrack = rtc.LocalAudioTrack.createAudioTrack(
        options.trackName ?? this.audioTrackName,
        this.localAudioSource
      );
    }

    if (!this.localAudioPublication) {
      const publishOptions = new rtc.TrackPublishOptions();
      publishOptions.source = options.trackSource ?? rtc.TrackSource.SOURCE_MICROPHONE;
      this.localAudioPublication = await this.room.localParticipant.publishTrack(
        this.localAudioTrack,
        publishOptions
      );
      this.emit('localTrackPublished', this.localAudioPublication);
    }

    return this.localAudioPublication;
  }

  async publishAudioFrame(frame, options = {}) {
    const rtc = await this._loadRtc();
    const publication = await this.ensureLocalAudioTrack(options);
    const audioFrame = createAudioFrame(rtc, frame, {
      sampleRate: options.sampleRate ?? this.sampleRate,
      channels: options.channels ?? this.channels,
    });
    await this.localAudioSource.captureFrame(audioFrame);
    this.emit('audioFramePublished', { frame: audioFrame, publication });
    return publication;
  }

  subscribeToTrack(publicationOrSid, participantIdentity) {
    return this.setTrackSubscribed(publicationOrSid, true, participantIdentity);
  }

  unsubscribeFromTrack(publicationOrSid, participantIdentity) {
    return this.setTrackSubscribed(publicationOrSid, false, participantIdentity);
  }

  setTrackSubscribed(publicationOrSid, subscribed = true, participantIdentity) {
    const publication = this._resolveRemotePublication(publicationOrSid, participantIdentity);
    publication.setSubscribed(subscribed);
    return publication;
  }

  async createAudioStream(trackOrPublication, options = {}) {
    const rtc = await this._loadRtc();
    const track = trackOrPublication?.track ?? trackOrPublication;
    if (!track) throw new Error('LiveKit audio stream requires a subscribed track or publication');
    return Object.keys(options).length > 0
      ? new rtc.AudioStream(track, options)
      : new rtc.AudioStream(track);
  }

  getRemoteParticipant(identity) {
    return this.room?.remoteParticipants?.get?.(identity);
  }

  async _loadRtc() {
    if (!this._rtc) this._rtc = await this._rtcLoader();
    return this._rtc;
  }

  async _loadServerSdk() {
    if (!this._serverSdk) this._serverSdk = await this._serverSdkLoader();
    return this._serverSdk;
  }

  async _resolveToken(options = {}) {
    const providedToken = options.token ?? this.token;
    if (providedToken) return providedToken;

    const roomName = options.roomName ?? this.roomName;
    if (!roomName) {
      throw new Error('LiveKit backend requires roomName when generating an access token');
    }

    const identity = options.participantIdentity ?? options.identity ?? this.participantIdentity;
    if (!identity) {
      throw new Error('LiveKit backend requires participantIdentity when generating an access token');
    }

    const apiKey = options.apiKey ?? this.apiKey;
    const apiSecret = options.apiSecret ?? this.apiSecret;
    if (!apiKey || !apiSecret) {
      throw new Error(
        'LiveKit backend requires either a token or apiKey/apiSecret credentials'
      );
    }

    const { AccessToken } = await this._loadServerSdk();
    const accessToken = new AccessToken(apiKey, apiSecret, {
      identity,
      name: options.participantName ?? options.name ?? this.participantName,
      metadata: 'participantMetadata' in options || 'metadata' in options
        ? normalizeParticipantMetadata(options.participantMetadata ?? options.metadata)
        : this.participantMetadata,
      attributes: 'participantAttributes' in options || 'attributes' in options
        ? normalizeParticipantAttributes(options.participantAttributes ?? options.attributes)
        : this.participantAttributes,
      ttl: options.ttl ?? this.ttl,
    });

    accessToken.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: options.canPublish ?? this.canPublish,
      canSubscribe: options.canSubscribe ?? this.canSubscribe,
      canPublishData: options.canPublishData ?? this.canPublishData,
    });

    const token = await accessToken.toJwt();
    this.token = token;
    return token;
  }

  _resolveRemotePublication(publicationOrSid, participantIdentity) {
    if (publicationOrSid && typeof publicationOrSid.setSubscribed === 'function') {
      return publicationOrSid;
    }

    const sid = typeof publicationOrSid === 'string' ? publicationOrSid : publicationOrSid?.sid;
    if (!sid) {
      throw new Error('LiveKit track subscription requires a publication or track SID');
    }

    const participants = participantIdentity
      ? [this.getRemoteParticipant(participantIdentity)].filter(Boolean)
      : Array.from(this.room?.remoteParticipants?.values?.() ?? []);

    for (const participant of participants) {
      const publication = participant?.trackPublications?.get?.(sid);
      if (publication) return publication;
    }

    throw new Error(`Unknown LiveKit track publication: ${sid}`);
  }

  async _closeLocalAudio() {
    await this.localAudioTrack?.close?.();
    await this.localAudioSource?.close?.();
    this.localAudioPublication = null;
    this.localAudioTrack = null;
    this.localAudioSource = null;
  }

  _bindRoomEvents(room, rtc) {
    room.on(rtc.RoomEvent.Connected, () => {
      this.connected = true;
      this.emit('status', `Connected to LiveKit room ${this.roomName ?? room.name ?? '(unnamed room)'}`);
      this.emit('connected', room);
    });

    room.on(rtc.RoomEvent.ConnectionStateChanged, (state) => {
      this.emit('connectionStateChanged', state);
    });

    room.on(rtc.RoomEvent.Reconnecting, () => {
      this.emit('status', 'LiveKit reconnecting...');
    });

    room.on(rtc.RoomEvent.Reconnected, () => {
      this.connected = true;
      this.emit('status', 'LiveKit reconnected');
      this.emit('reconnected', room);
    });

    room.on(rtc.RoomEvent.Disconnected, (reason) => {
      this.connected = false;
      this.emit('status', `LiveKit disconnected${reason ? ` (${reason})` : ''}`);
      this.emit('close', reason);
    });

    room.on(rtc.RoomEvent.ParticipantConnected, (participant) => {
      this.emit('participantConnected', participant);
    });

    room.on(rtc.RoomEvent.ParticipantDisconnected, (participant) => {
      this.emit('participantDisconnected', participant);
    });

    room.on(rtc.RoomEvent.TrackPublished, (publication, participant) => {
      this.emit('trackPublished', { publication, participant });
    });

    room.on(rtc.RoomEvent.TrackSubscribed, (track, publication, participant) => {
      this.emit('trackSubscribed', { track, publication, participant });
    });

    room.on(rtc.RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
      this.emit('trackUnsubscribed', { track, publication, participant });
    });

    room.on(rtc.RoomEvent.DataReceived, (payload, participant, kind, topic, encryptionType) => {
      this.emit('data', { payload, participant, kind, topic, encryptionType });
    });

    room.on(rtc.RoomEvent.ChatMessage, (message, participant) => {
      this.emit('chatMessage', { message, participant });
    });
  }
}

export class LiveKitVoiceSession extends LiveKitRoomClient {
  constructor(options = {}) {
    super(options);
    this.running = false;
    this.testMode = options.testMode ?? false;
    this.bridgeToPersonaplex = options.bridgeToPersonaplex ?? false;
    this.enableMicrophone = options.enableMicrophone ?? (!this.testMode && !this.bridgeToPersonaplex);
    this.enablePlayback = options.enablePlayback ?? (!this.testMode && !this.bridgeToPersonaplex);
    this.frameSizeMs = options.frameSizeMs ?? DEFAULT_FRAME_SIZE_MS;
    this.agentTurnHandler = options.agentTurnHandler ?? null;
    this.inputTopics = new Set(options.inputTopics ?? DEFAULT_INPUT_TOPICS);
    this.acceptUntypedData = options.acceptUntypedData ?? true;
    this.outputTopic = options.outputTopic ?? DEFAULT_OUTPUT_TOPIC;
    this.publishResponseData = options.publishResponseData ?? true;
    this.sendChatResponses = options.sendChatResponses ?? true;
    this.model = options.model ?? null;
    this.agentName = options.agentName ?? options.agent ?? null;
    this.sessionId = options.sessionId ?? options.session ?? null;
    this.personaplexFactory = options.personaplexFactory ?? null;
    this.personaplexHost = options.personaplexHost;
    this.personaplexPort = options.personaplexPort;
    this.personaplexTextPrompt = options.personaplexTextPrompt ?? options.textPrompt;
    this.personaplexVoicePrompt = options.personaplexVoicePrompt ?? options.voicePrompt;
    this.personaplexSession = options.personaplexSession ?? null;

    this.mic = null;
    this.micBuf = Buffer.alloc(0);
    this._micPublishQueue = Promise.resolve();
    this._personaplexPublishQueue = Promise.resolve();
    this.player = null;
    this.playerSampleRate = null;
    this.playerChannels = null;
    this.remoteAudioReaders = new Map();
    this.turnQueue = Promise.resolve();

    this.on('trackSubscribed', ({ track, publication, participant }) => {
      void this._handleTrackSubscribed(track, publication, participant);
    });
    this.on('trackUnsubscribed', ({ track, publication, participant }) => {
      void this._handleTrackUnsubscribed(track, publication, participant);
    });
    this.on('data', (event) => {
      void this._handleDataReceived(event);
    });
    this.on('chatMessage', (event) => {
      void this._handleChatMessage(event);
    });
  }

  async start(options = {}) {
    const room = await super.start(options);
    this.running = true;
    if (this.bridgeToPersonaplex) {
      await this._startPersonaplexBridge(options);
    }
    if (this.enableMicrophone) {
      this._startMic();
    }
    await this._bindExistingRemoteAudio();
    if (this.agentTurnHandler) {
      this.emit('status', 'LiveKit room loop is listening for chat and data prompts');
    } else {
      this.emit('status', 'LiveKit audio transport is active');
    }
    return room;
  }

  async stop() {
    this.running = false;
    await this._stopPersonaplexBridge();
    await this._stopMic();
    await this._stopRemoteAudio();
    this._stopPlayer();
    await super.stop();
  }

  async _startPersonaplexBridge(options = {}) {
    if (this.personaplexSession?.running) return this.personaplexSession;
    if (!this.personaplexSession) {
      if (typeof this.personaplexFactory !== 'function') {
        throw new Error('LiveKit PersonaPlex bridge requires a personaplexFactory');
      }
      this.personaplexSession = this.personaplexFactory({
        host: options.personaplexHost ?? this.personaplexHost,
        port: options.personaplexPort ?? this.personaplexPort,
        textPrompt: options.personaplexTextPrompt ?? this.personaplexTextPrompt,
        voicePrompt: options.personaplexVoicePrompt ?? this.personaplexVoicePrompt,
        enableMicrophone: false,
        enablePlayback: false,
        emitAudio: true,
      });
    }

    this.personaplexSession.on?.('status', (message) => {
      this.emit('status', `PersonaPlex bridge: ${message}`);
    });
    this.personaplexSession.on?.('text', (text) => {
      this.emit('text', text);
      void this._publishPersonaplexText(text);
    });
    this.personaplexSession.on?.('audio', ({ pcm, sampleRate, channels }) => {
      this._personaplexPublishQueue = this._personaplexPublishQueue
        .then(() => this._publishPersonaplexAudio(pcm, sampleRate, channels))
        .catch((error) => this.emit('error', error));
    });
    this.personaplexSession.on?.('error', (error) => {
      this.emit('error', new Error(`PersonaPlex bridge failed: ${error.message}`));
    });

    await this.personaplexSession.start();
    this.emit('status', 'LiveKit audio is bridged to PersonaPlex/Moshi');
    return this.personaplexSession;
  }

  async _stopPersonaplexBridge() {
    const session = this.personaplexSession;
    this.personaplexSession = null;
    await this._personaplexPublishQueue.catch(() => {});
    session?.stop?.();
  }

  async _publishPersonaplexText(text) {
    const content = String(text ?? '').trim();
    if (!content || !this.room?.localParticipant) return;
    await this.publishData(JSON.stringify({
      type: 'personaplex_text',
      content,
      room: this.roomName ?? null,
      session: this.sessionId ?? null,
      model: this.model ?? null,
      agent: this.agentName ?? null,
    }), {
      reliable: true,
      topic: this.outputTopic,
    });
  }

  async _publishPersonaplexAudio(pcm, sampleRate, channels) {
    if (!this.running || !pcm) return;
    await this.publishAudioFrame({
      data: pcm,
      sampleRate: sampleRate ?? this.sampleRate,
      channels: channels ?? this.channels,
    }, {
      sampleRate: sampleRate ?? this.sampleRate,
      channels: channels ?? this.channels,
      trackName: 'nemo-personaplex-audio',
    });
  }

  _sendRemoteAudioToPersonaplex(frame) {
    if (!this.personaplexSession?.writePcm || !frame?.data) return;
    this.personaplexSession.writePcm(frame.data);
  }

  _remoteTrackKey(publication, track, participant) {
    return publication?.sid ?? track?.sid ?? `${participant?.identity ?? 'remote'}:audio`;
  }

  async _bindExistingRemoteAudio() {
    for (const participant of this.room?.remoteParticipants?.values?.() ?? []) {
      for (const publication of participant.trackPublications?.values?.() ?? []) {
        if (publication?.track) {
          await this._handleTrackSubscribed(publication.track, publication, participant);
        }
      }
    }
  }

  _startMic() {
    if (this.mic || !this.running) return;
    this.emit('status', 'Publishing microphone audio to LiveKit');
    this.mic = spawn('arecord', [
      '--device=default',
      '--format=S16_LE',
      `--rate=${this.sampleRate}`,
      `--channels=${this.channels}`,
      '--file-type=raw',
    ]);
    this.mic.stderr.on('data', () => {});
    this.mic.on('error', (error) => {
      this.emit('error', new Error(`LiveKit microphone capture failed: ${error.message}`));
    });
    this.mic.stdout.on('data', (chunk) => {
      if (!this.running) return;
      this.micBuf = Buffer.concat([this.micBuf, chunk]);
      this._micPublishQueue = this._micPublishQueue
        .then(() => this._flushMicFrames())
        .catch((error) => this.emit('error', error));
    });
  }

  async _flushMicFrames() {
    const samplesPerChannel = Math.round(this.sampleRate * (this.frameSizeMs / 1000));
    const frameBytes = samplesPerChannel * this.channels * 2;

    while (this.running && this.micBuf.length >= frameBytes) {
      const frame = this.micBuf.subarray(0, frameBytes);
      this.micBuf = this.micBuf.subarray(frameBytes);
      const pcm = new Int16Array(
        frame.buffer.slice(frame.byteOffset, frame.byteOffset + frameBytes)
      );
      await this.publishAudioFrame(pcm, {
        sampleRate: this.sampleRate,
        channels: this.channels,
        samplesPerChannel,
      });
    }
  }

  async _stopMic() {
    const mic = this.mic;
    this.mic = null;
    this.micBuf = Buffer.alloc(0);
    await this._micPublishQueue.catch(() => {});
    if (mic && mic.exitCode == null) {
      mic.kill('SIGTERM');
    }
  }

  _ensurePlayer(sampleRate = this.sampleRate, channels = this.channels) {
    if (
      this.player &&
      this.playerSampleRate === sampleRate &&
      this.playerChannels === channels
    ) {
      return;
    }

    this._stopPlayer();
    this.playerSampleRate = sampleRate;
    this.playerChannels = channels;
    this.player = spawn('aplay', [
      '--device=default',
      '--format=S16_LE',
      `--rate=${sampleRate}`,
      `--channels=${channels}`,
      '--file-type=raw',
    ]);
    this.player.stderr.on('data', () => {});
    this.player.on('error', (error) => {
      this.emit('error', new Error(`LiveKit audio playback failed: ${error.message}`));
    });
  }

  _stopPlayer() {
    if (this.player?.stdin?.writable) {
      this.player.stdin.end();
    }
    if (this.player && this.player.exitCode == null) {
      this.player.kill('SIGTERM');
    }
    this.player = null;
    this.playerSampleRate = null;
    this.playerChannels = null;
  }

  async _handleTrackSubscribed(track, publication, participant) {
    if (!this.enablePlayback && !this.bridgeToPersonaplex) return;
    if (publication?.kind && String(publication.kind).toLowerCase() !== 'audio') return;

    const key = this._remoteTrackKey(publication, track, participant);
    if (this.remoteAudioReaders.has(key)) return;

    try {
      const stream = await this.createAudioStream(track, {
        sampleRate: this.sampleRate,
        numChannels: this.channels,
        frameSizeMs: this.frameSizeMs,
      });
      const reader = stream.getReader();
      this.remoteAudioReaders.set(key, reader);
      void this._pumpRemoteAudio(key, reader);
    } catch (error) {
      this.emit('error', new Error(`LiveKit remote audio setup failed: ${error.message}`));
    }
  }

  async _pumpRemoteAudio(key, reader) {
    try {
      while (this.running) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        if (this.bridgeToPersonaplex) {
          this._sendRemoteAudioToPersonaplex(value);
        }
        if (!this.enablePlayback) continue;
        this._ensurePlayer(this.sampleRate, this.channels);
        if (this.player?.stdin?.writable) {
          this.player.stdin.write(toBuffer(value.data));
        }
      }
    } catch (error) {
      if (this.running) {
        this.emit('error', new Error(`LiveKit remote audio playback failed: ${error.message}`));
      }
    } finally {
      this.remoteAudioReaders.delete(key);
    }
  }

  async _handleTrackUnsubscribed(track, publication, participant) {
    const key = this._remoteTrackKey(publication, track, participant);
    const reader = this.remoteAudioReaders.get(key);
    if (!reader) return;
    this.remoteAudioReaders.delete(key);
    await reader.cancel?.();
  }

  async _stopRemoteAudio() {
    const readers = [...this.remoteAudioReaders.values()];
    this.remoteAudioReaders.clear();
    await Promise.allSettled(readers.map((reader) => reader.cancel?.()));
  }

  _isLocalParticipant(participant) {
    const localIdentity = this.room?.localParticipant?.identity ?? this.participantIdentity;
    return Boolean(participant?.identity && localIdentity && participant.identity === localIdentity);
  }

  _shouldHandleDataTopic(topic) {
    if (topic == null || topic === '') {
      return this.acceptUntypedData;
    }
    if (topic === this.outputTopic) return false;
    return this.inputTopics.has(topic);
  }

  _queueTurn(message, metadata) {
    if (!this.agentTurnHandler || !message) return;
    this.turnQueue = this.turnQueue
      .then(() => this._runAgentTurn(message, metadata))
      .catch((error) => this.emit('error', error));
  }

  async _handleDataReceived({ payload, participant, topic, kind }) {
    if (!this.agentTurnHandler) return;
    if (this._isLocalParticipant(participant)) return;
    if (!this._shouldHandleDataTopic(topic)) return;

    const message = parseIncomingDataPayload(payload);
    if (!message) return;
    this._queueTurn(message, { participant, topic, kind, transport: 'data' });
  }

  async _handleChatMessage({ message, participant }) {
    if (!this.agentTurnHandler) return;
    if (this._isLocalParticipant(participant)) return;

    const text = String(message?.message ?? '').trim();
    if (!text) return;
    this._queueTurn(text, { participant, transport: 'chat' });
  }

  async _runAgentTurn(message, metadata) {
    let streamedResponse = '';
    this.emit('status', `Processing LiveKit prompt${metadata.participant?.identity ? ` from ${metadata.participant.identity}` : ''}`);

    const response = await this.agentTurnHandler({
      ...metadata,
      message,
      roomName: this.roomName,
      sessionId: this.sessionId,
      model: this.model,
      agentName: this.agentName,
      emitText: (chunk) => {
        if (!chunk) return;
        streamedResponse += chunk;
        this.emit('text', chunk);
      },
    });

    const finalResponse = String(response ?? streamedResponse).trim();
    if (!finalResponse) return;

    if (this.sendChatResponses) {
      await this.sendChatMessage(finalResponse);
    }
    if (this.publishResponseData) {
      await this.publishData(JSON.stringify({
        type: 'assistant_message',
        content: finalResponse,
        room: this.roomName ?? null,
        session: this.sessionId ?? null,
        model: this.model ?? null,
        agent: this.agentName ?? null,
      }), {
        reliable: true,
        topic: this.outputTopic,
      });
    }
  }
}

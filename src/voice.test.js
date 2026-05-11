import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import {
  createVoiceSession,
  DEFAULT_VOICE_BACKEND,
  LiveKitVoiceSession,
  listVoiceBackends,
  PersonaPlexVoiceSession,
  resolveVoiceBackend,
  VoiceLiveSession,
} from './voice.js';

function createFakeRtcModule() {
  const state = {
    rooms: [],
    publishedData: [],
    sentText: [],
    chatMessages: [],
    publications: [],
    audioSources: [],
    audioTracks: [],
    audioStreams: [],
    closedTracks: 0,
  };

  const RoomEvent = {
    Connected: 'connected',
    ConnectionStateChanged: 'connectionStateChanged',
    Reconnecting: 'reconnecting',
    Reconnected: 'reconnected',
    Disconnected: 'disconnected',
    ParticipantConnected: 'participantConnected',
    ParticipantDisconnected: 'participantDisconnected',
    TrackPublished: 'trackPublished',
    TrackSubscribed: 'trackSubscribed',
    TrackUnsubscribed: 'trackUnsubscribed',
    DataReceived: 'dataReceived',
    ChatMessage: 'chatMessage',
  };

  class FakeRoom extends EventEmitter {
    constructor() {
      super();
      this.name = 'test-room';
      this.connectCalls = [];
      this.disconnectCalls = 0;
      this.remoteParticipants = new Map();
      this.localParticipant = {
        publishData: async (data, options) => {
          state.publishedData.push({ data, options });
        },
        sendText: async (text, options) => {
          const result = { id: `TXT${state.sentText.length + 1}` };
          state.sentText.push({ text, options, result });
          return result;
        },
        sendChatMessage: async (text, destinationIdentities, senderIdentity) => {
          const message = {
            id: `MSG${state.chatMessages.length + 1}`,
            message: text,
            destinationIdentities,
            senderIdentity,
          };
          state.chatMessages.push(message);
          return message;
        },
        publishTrack: async (track, options) => {
          const publication = { sid: `LP${state.publications.length + 1}`, track, options };
          state.publications.push(publication);
          return publication;
        },
      };

      state.rooms.push(this);
    }

    async connect(url, token, options) {
      this.connectCalls.push({ url, token, options });
      this.isConnected = true;
      this.emit(RoomEvent.Connected);
    }

    async disconnect() {
      this.disconnectCalls += 1;
      this.isConnected = false;
      this.emit(RoomEvent.Disconnected, 'client');
    }
  }

  class FakeTrackPublishOptions {
    constructor() {
      this.source = undefined;
    }
  }

  class FakeAudioSource {
    constructor(sampleRate, numChannels) {
      this.sampleRate = sampleRate;
      this.numChannels = numChannels;
      this.capturedFrames = [];
      this.closed = false;
      state.audioSources.push(this);
    }

    async captureFrame(frame) {
      this.capturedFrames.push(frame);
    }

    async close() {
      this.closed = true;
    }
  }

  class FakeAudioFrame {
    constructor(data, sampleRate, channels, samplesPerChannel) {
      this.data = data;
      this.sampleRate = sampleRate;
      this.channels = channels;
      this.samplesPerChannel = samplesPerChannel;
    }
  }

  const LocalAudioTrack = {
    createAudioTrack(name, source) {
      const track = {
        name,
        source,
        closed: false,
        async close() {
          this.closed = true;
          state.closedTracks += 1;
        },
      };
      state.audioTracks.push(track);
      return track;
    },
  };

  class FakeAudioStream {
    constructor(track, options) {
      this.track = track;
      this.options = options;
      this.frames = [...(track.frames ?? [])];
      state.audioStreams.push(this);
    }

    getReader() {
      const stream = this;
      return {
        cancelled: false,
        async read() {
          if (this.cancelled || !stream.frames.length) return { done: true };
          return { value: stream.frames.shift(), done: false };
        },
        async cancel() {
          this.cancelled = true;
        },
      };
    }
  }

  return {
    RoomEvent,
    Room: FakeRoom,
    TrackPublishOptions: FakeTrackPublishOptions,
    TrackSource: {
      SOURCE_MICROPHONE: 'microphone',
    },
    AudioSource: FakeAudioSource,
    AudioFrame: FakeAudioFrame,
    AudioStream: FakeAudioStream,
    LocalAudioTrack,
    __state: state,
  };
}

function createFakeServerSdkModule() {
  const state = {
    tokens: [],
  };

  class FakeAccessToken {
    constructor(apiKey, apiSecret, options) {
      this.apiKey = apiKey;
      this.apiSecret = apiSecret;
      this.options = options;
      this.grants = [];
      state.tokens.push(this);
    }

    addGrant(grant) {
      this.grants.push(grant);
    }

    async toJwt() {
      return 'generated-livekit-token';
    }
  }

  return {
    AccessToken: FakeAccessToken,
    __state: state,
  };
}

describe('voice backend registry', () => {
  it('defaults to the PersonaPlex backend', () => {
    const backend = resolveVoiceBackend();
    assert.equal(backend.name, DEFAULT_VOICE_BACKEND);
    assert.equal(backend.label, 'PersonaPlex');
  });

  it('supports backend aliases', () => {
    assert.equal(resolveVoiceBackend('moshi').name, DEFAULT_VOICE_BACKEND);
    assert.equal(resolveVoiceBackend('lk').name, 'livekit');
    assert.equal(resolveVoiceBackend('voicelive').name, 'livekit');
  });

  it('lists the registered backends', () => {
    const backends = listVoiceBackends();
    assert.equal(backends.length, 2);
    assert.deepEqual(backends.map(({ name }) => name), [DEFAULT_VOICE_BACKEND, 'livekit']);
  });

  it('creates a PersonaPlex session through the backend factory', () => {
    const session = createVoiceSession({
      host: '127.0.0.1',
      port: 9001,
      textPrompt: 'test prompt',
      voicePrompt: 'TEST.pt',
    });

    assert.ok(session instanceof PersonaPlexVoiceSession);
    assert.equal(session.host, '127.0.0.1');
    assert.equal(session.port, 9001);
    assert.equal(session.textPrompt, 'test prompt');
    assert.equal(session.voicePrompt, 'TEST.pt');
  });

  it('creates a LiveKit session through the backend factory', () => {
    const session = createVoiceSession({
      backend: 'livekit',
      url: 'wss://livekit.example.test',
      roomName: 'nemo-room',
      participantIdentity: 'nemo',
    });

    assert.ok(session instanceof LiveKitVoiceSession);
    assert.ok(session instanceof VoiceLiveSession);
    assert.equal(session.url, 'wss://livekit.example.test');
    assert.equal(session.roomName, 'nemo-room');
    assert.equal(session.participantIdentity, 'nemo');
    assert.equal(session.personaHost, '10.1.0.4');
    assert.equal(session.personaPort, 8998);
  });

  it('treats non-url LiveKit factory hosts as PersonaPlex audio targets', () => {
    const session = createVoiceSession({
      backend: 'voicelive',
      host: '10.1.0.5',
      port: 8998,
      url: 'wss://livekit.example.test',
      roomName: 'nemo-room',
      participantIdentity: 'nemo',
    });

    assert.ok(session instanceof VoiceLiveSession);
    assert.equal(session.url, 'wss://livekit.example.test');
    assert.equal(session.host, undefined);
    assert.equal(session.port, undefined);
    assert.equal(session.personaHost, '10.1.0.5');
    assert.equal(session.personaPort, 8998);
  });

  it('generates a LiveKit access token before connecting when api credentials are provided', async () => {
    const rtc = createFakeRtcModule();
    const serverSdk = createFakeServerSdkModule();

    const session = new LiveKitVoiceSession({
      url: 'wss://livekit.example.test',
      roomName: 'nemo-room',
      participantIdentity: 'nemo',
      participantName: 'Nemo',
      participantMetadata: { role: 'assistant' },
      participantAttributes: { model: 'nemotron' },
      apiKey: 'key',
      apiSecret: 'secret',
      rtcLoader: async () => rtc,
      serverSdkLoader: async () => serverSdk,
    });

    await session.connect();

    assert.equal(serverSdk.__state.tokens.length, 1);
    assert.equal(serverSdk.__state.tokens[0].apiKey, 'key');
    assert.equal(serverSdk.__state.tokens[0].apiSecret, 'secret');
    assert.deepEqual(serverSdk.__state.tokens[0].options, {
      identity: 'nemo',
      name: 'Nemo',
      metadata: '{"role":"assistant"}',
      attributes: { model: 'nemotron' },
      ttl: undefined,
    });
    assert.deepEqual(serverSdk.__state.tokens[0].grants[0], {
      roomJoin: true,
      room: 'nemo-room',
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
    assert.deepEqual(rtc.__state.rooms[0].connectCalls[0], {
      url: 'wss://livekit.example.test',
      token: 'generated-livekit-token',
      options: {
        autoSubscribe: true,
        dynacast: true,
      },
    });

    await session.disconnect();
  });

  it('publishes LiveKit audio and data and exposes remote subscription helpers', async () => {
    const rtc = createFakeRtcModule();
    const session = new LiveKitVoiceSession({
      url: 'wss://livekit.example.test',
      roomName: 'nemo-room',
      participantIdentity: 'nemo',
      token: 'provided-token',
      rtcLoader: async () => rtc,
    });

    await session.connect();
    await session.publishData('hello world', {
      reliable: false,
      destinationIdentities: ['listener'],
      topic: 'control',
    });
    await session.sendText('hello transcript', {
      topic: 'transcript',
    });
    await session.sendChatMessage('hello chat', {
      destinationIdentities: ['listener'],
      senderIdentity: 'nemo',
    });
    await session.publishAudioFrame(new Int16Array([1, -1, 2, -2]), {
      sampleRate: 24_000,
      channels: 1,
      samplesPerChannel: 4,
    });

    assert.equal(rtc.__state.publishedData.length, 1);
    assert.equal(Buffer.from(rtc.__state.publishedData[0].data).toString('utf8'), 'hello world');
    assert.deepEqual(rtc.__state.publishedData[0].options, {
      reliable: false,
      destination_identities: ['listener'],
      topic: 'control',
    });
    assert.deepEqual(rtc.__state.sentText[0], {
      text: 'hello transcript',
      options: {
        topic: 'transcript',
        attributes: undefined,
        destinationIdentities: undefined,
        streamId: undefined,
      },
      result: { id: 'TXT1' },
    });
    assert.deepEqual(rtc.__state.chatMessages[0], {
      id: 'MSG1',
      message: 'hello chat',
      destinationIdentities: ['listener'],
      senderIdentity: 'nemo',
    });
    assert.equal(rtc.__state.audioSources.length, 1);
    assert.equal(rtc.__state.audioSources[0].capturedFrames.length, 1);
    assert.equal(rtc.__state.publications.length, 1);
    assert.equal(rtc.__state.publications[0].options.source, rtc.TrackSource.SOURCE_MICROPHONE);

    const remotePublication = {
      sid: 'TR1',
      subscribed: false,
      track: { sid: 'track-1' },
      setSubscribed(value) {
        this.subscribed = value;
      },
    };
    rtc.__state.rooms[0].remoteParticipants.set('listener', {
      identity: 'listener',
      trackPublications: new Map([[remotePublication.sid, remotePublication]]),
    });

    session.subscribeToTrack('TR1');
    assert.equal(remotePublication.subscribed, true);
    session.unsubscribeFromTrack('TR1');
    assert.equal(remotePublication.subscribed, false);

    const stream = await session.createAudioStream(remotePublication, {
      sampleRate: 16_000,
      numChannels: 1,
    });
    assert.equal(stream.track, remotePublication.track);
    assert.deepEqual(stream.options, {
      sampleRate: 16_000,
      numChannels: 1,
    });

    const dataEvent = new Promise((resolve) => session.once('data', resolve));
    rtc.__state.rooms[0].emit(
      rtc.RoomEvent.DataReceived,
      new Uint8Array([7, 8]),
      { identity: 'listener' },
      'reliable',
      'control'
    );
    assert.deepEqual(await dataEvent, {
      payload: new Uint8Array([7, 8]),
      participant: { identity: 'listener' },
      kind: 'reliable',
      topic: 'control',
      encryptionType: undefined,
    });

    await session.disconnect();
    assert.equal(rtc.__state.closedTracks, 1);
    assert.equal(rtc.__state.audioSources[0].closed, true);
  });

  it('routes LiveKit room prompts through the in-process agent handler', async () => {
    const rtc = createFakeRtcModule();
    const session = new LiveKitVoiceSession({
      url: 'wss://livekit.example.test',
      roomName: 'nemo-room',
      participantIdentity: 'nemo',
      token: 'provided-token',
      model: 'nemotron',
      agentName: 'reviewer',
      sessionId: 'daily',
      enableMicrophone: false,
      enablePlayback: false,
      rtcLoader: async () => rtc,
      agentTurnHandler: async ({ message, participant, transport, emitText }) => {
        assert.equal(message, 'Need an update');
        assert.equal(participant.identity, 'listener');
        assert.equal(transport, 'chat');
        emitText('Hello ');
        emitText('room');
        return 'Hello room';
      },
    });

    const tokens = [];
    session.on('text', (token) => tokens.push(token));

    await session.start();
    rtc.__state.rooms[0].emit(
      rtc.RoomEvent.ChatMessage,
      { id: 'chat-1', message: 'Need an update' },
      { identity: 'listener' }
    );
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(tokens, ['Hello ', 'room']);
    assert.equal(rtc.__state.chatMessages.length, 1);
    assert.equal(rtc.__state.chatMessages[0].message, 'Hello room');
    assert.equal(rtc.__state.publishedData.length, 1);
    assert.deepEqual(
      JSON.parse(Buffer.from(rtc.__state.publishedData[0].data).toString('utf8')),
      {
        type: 'assistant_message',
        content: 'Hello room',
        room: 'nemo-room',
        session: 'daily',
        model: 'nemotron',
        agent: 'reviewer',
      }
    );
    assert.equal(rtc.__state.publishedData[0].options.topic, 'nemo.assistant');

    await session.stop();
  });

  it('bridges LiveKit room audio through PersonaPlex while keeping room prompts on the agent handler', async () => {
    const rtc = createFakeRtcModule();
    const persona = new EventEmitter();
    persona.receivedFrames = [];
    persona.started = false;
    persona.stopped = false;
    persona.start = async () => {
      persona.started = true;
    };
    persona.stop = () => {
      persona.stopped = true;
    };
    persona.sendPcmAudioFrame = (data, options) => {
      persona.receivedFrames.push({ data, options });
      return true;
    };

    const session = new VoiceLiveSession({
      url: 'wss://livekit.example.test',
      roomName: 'nemo-room',
      participantIdentity: 'nemo',
      token: 'provided-token',
      enableMicrophone: false,
      enablePlayback: false,
      rtcLoader: async () => rtc,
      personaSessionFactory: () => persona,
      agentTurnHandler: async ({ message, emitText }) => {
        assert.equal(message, 'Need a text update');
        emitText('Handled ');
        emitText('by Nemo');
        return 'Handled by Nemo';
      },
    });

    const tokens = [];
    session.on('text', (token) => tokens.push(token));

    await session.start();
    assert.equal(persona.started, true);

    rtc.__state.rooms[0].emit(
      rtc.RoomEvent.TrackSubscribed,
      {
        sid: 'track-voice',
        frames: [{
          data: new Int16Array([1, 2, 3, 4]),
          sampleRate: 24_000,
          channels: 1,
          samplesPerChannel: 4,
        }],
      },
      { sid: 'TR-voice', kind: 'audio' },
      { identity: 'speaker' }
    );
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    persona.emit('audioFrame', {
      data: new Int16Array([5, 6, 7, 8]),
      sampleRate: 48_000,
      channels: 1,
      samplesPerChannel: 4,
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    rtc.__state.rooms[0].emit(
      rtc.RoomEvent.ChatMessage,
      { id: 'chat-1', message: 'Need a text update' },
      { identity: 'listener' }
    );
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(persona.receivedFrames.length, 1);
    assert.deepEqual(Array.from(persona.receivedFrames[0].data), [1, 2, 3, 4]);
    assert.deepEqual(persona.receivedFrames[0].options, {
      sampleRate: 24_000,
      channels: 1,
      samplesPerChannel: 4,
    });
    assert.equal(rtc.__state.audioSources.length, 1);
    assert.equal(rtc.__state.audioSources[0].sampleRate, 48_000);
    assert.equal(rtc.__state.audioSources[0].capturedFrames.length, 1);
    assert.deepEqual(tokens, ['Handled ', 'by Nemo']);
    assert.equal(rtc.__state.chatMessages[0].message, 'Handled by Nemo');

    await session.stop();
    assert.equal(persona.stopped, true);
  });

  it('throws on an unknown backend', () => {
    assert.throws(() => createVoiceSession({ backend: 'unknown-backend' }), /Unknown voice backend/);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { VoiceLiveSession } from './voice.js';
import { VOICE_COMMAND_DESCS, executeCommand, parseVoiceCommandArgs } from './commands.js';
import { Session } from './session.js';

describe('voice command parsing', () => {
  it('preserves PersonaPlex shorthand defaults', () => {
    const parsed = parseVoiceCommandArgs('antonjr1 natm0');

    assert.equal(parsed.action, 'start');
    assert.equal(parsed.backend.name, 'personaplex');
    assert.equal(parsed.nodeName, 'antonjr1');
    assert.equal(parsed.host, '10.1.0.5');
    assert.equal(parsed.port, 8998);
    assert.equal(parsed.voiceKey, 'natm0');
    assert.equal(parsed.voicePrompt, 'NATM0.pt');
  });

  it('supports explicit PersonaPlex backend selection', () => {
    const parsed = parseVoiceCommandArgs('personaplex antonjr1 natm0');

    assert.equal(parsed.action, 'start');
    assert.equal(parsed.backend.name, 'personaplex');
    assert.equal(parsed.nodeName, 'antonjr1');
    assert.equal(parsed.host, '10.1.0.5');
    assert.equal(parsed.port, 8998);
    assert.equal(parsed.voiceKey, 'natm0');
    assert.equal(parsed.voicePrompt, 'NATM0.pt');
  });

  it('supports explicit LiveKit routing fields', () => {
    const parsed = parseVoiceCommandArgs(
      'backend livekit room standup session daily identity nemo agent reviewer model audio host ws://127.0.0.1:7880'
    );

    assert.equal(parsed.action, 'start');
    assert.equal(parsed.backend.name, 'livekit');
    assert.equal(parsed.room, 'standup');
    assert.equal(parsed.session, 'daily');
    assert.equal(parsed.identity, 'nemo');
    assert.equal(parsed.agent, 'reviewer');
    assert.equal(parsed.model, 'audio');
    assert.equal(parsed.host, 'ws://127.0.0.1:7880');
    assert.equal(parsed.port, null);
    assert.equal(parsed.livekitUrl, 'ws://127.0.0.1:7880');
    assert.equal(parsed.personaHost, '10.1.0.4');
    assert.equal(parsed.personaPort, 8998);
    assert.equal(parsed.voiceKey, 'natf0');
    assert.equal(parsed.voicePrompt, 'NATF0.pt');
  });

  it('separates the LiveKit transport URL from the PersonaPlex audio node', () => {
    const parsed = parseVoiceCommandArgs(
      'livekit node antonjr1 voice natm0 room ops host ws://127.0.0.1:7880'
    );

    assert.equal(parsed.action, 'start');
    assert.equal(parsed.backend.name, 'livekit');
    assert.equal(parsed.livekitUrl, 'ws://127.0.0.1:7880');
    assert.equal(parsed.personaHost, '10.1.0.5');
    assert.equal(parsed.personaPort, 8998);
    assert.equal(parsed.voiceKey, 'natm0');
    assert.equal(parsed.voicePrompt, 'NATM0.pt');
    assert.equal(parsed.room, 'ops');
  });

  it('infers LiveKit room shorthand after backend selection', () => {
    const parsed = parseVoiceCommandArgs('livekit standup session=sprint-review --identity nemo');

    assert.equal(parsed.action, 'start');
    assert.equal(parsed.backend.name, 'livekit');
    assert.equal(parsed.room, 'standup');
    assert.equal(parsed.session, 'sprint-review');
    assert.equal(parsed.identity, 'nemo');
  });

  it('accepts VoiceLive as an alias for the LiveKit transport stack', () => {
    const parsed = parseVoiceCommandArgs('voicelive room ops');

    assert.equal(parsed.action, 'start');
    assert.equal(parsed.backend.name, 'livekit');
    assert.equal(parsed.backend.label, 'VoiceLive');
    assert.equal(parsed.room, 'ops');
    assert.equal(parsed.personaHost, '10.1.0.4');
  });

  it('rejects unknown explicit backends', () => {
    const parsed = parseVoiceCommandArgs('backend unknown');

    assert.equal(parsed.action, 'error');
    assert.match(parsed.error, /Unknown voice backend: unknown/);
  });

  it('advertises LiveKit and help completions', () => {
    const triggers = VOICE_COMMAND_DESCS.map((item) => item.trigger);

    assert.ok(triggers.includes('/voice help'));
    assert.ok(triggers.includes('/voice personaplex'));
    assert.ok(triggers.includes('/voice livekit'));
    assert.ok(triggers.includes('/voice antonjr1'));
  });

  it('passes LiveKit routing into the runtime session', async () => {
    const snapshot = {};
    const errors = [];
    const originalStart = VoiceLiveSession.prototype.start;
    const originalStop = VoiceLiveSession.prototype.stop;
    const originalLog = console.log;
    const session = new Session({
      systemPrompt: 'base prompt',
      maxHistory: 100,
      cwd: '/workspace/project',
    });

    VoiceLiveSession.prototype.start = async function () {
      snapshot.host = this.host;
      snapshot.port = this.port;
      snapshot.url = this.url;
      snapshot.personaHost = this.personaHost;
      snapshot.personaPort = this.personaPort;
      snapshot.roomName = this.roomName;
      snapshot.participantIdentity = this.participantIdentity;
      snapshot.participantAttributes = this.participantAttributes;
      snapshot.participantMetadata = this.participantMetadata;
      snapshot.hasAgentTurnHandler = typeof this.agentTurnHandler === 'function';
      snapshot.apiKey = this.apiKey;
      snapshot.apiSecret = this.apiSecret;
    };
    VoiceLiveSession.prototype.stop = async function () {};
    console.log = () => {};

    try {
      await executeCommand(
        '/voice livekit room standup session daily identity nemo agent reviewer model audio host ws://127.0.0.1:7880',
        {
          config: {
            model: 'default-model',
            agentName: 'default-agent',
            baseUrl: 'http://127.0.0.1:30000',
            systemPrompt: 'base prompt',
            maxHistory: 100,
            livekitUrl: 'ws://127.0.0.1:7880',
            livekitTokenStrategy: 'mint',
            livekitApiKey: 'key',
            livekitApiSecret: 'secret',
          },
          session,
          agent: {
            streamEnabled: true,
            swarmExecutor: null,
          },
          permissions: {
            availableTools: null,
          },
          mcpClient: null,
          agentSystem: {
            applyAgent(name, config) {
              return {
                ...config,
                agentName: name,
                agentDisplayName: name,
                systemPrompt: `${name} prompt`,
              };
            },
          },
          ui: {
            pauseForVoice: async () => {},
            printError: (message) => errors.push(message),
          },
        }
      );
    } finally {
      VoiceLiveSession.prototype.start = originalStart;
      VoiceLiveSession.prototype.stop = originalStop;
      console.log = originalLog;
    }

    assert.deepEqual(errors, []);
    assert.equal(snapshot.url, 'ws://127.0.0.1:7880');
    assert.equal(snapshot.host, undefined);
    assert.equal(snapshot.port, undefined);
    assert.equal(snapshot.personaHost, '10.1.0.4');
    assert.equal(snapshot.personaPort, 8998);
    assert.equal(snapshot.roomName, 'standup');
    assert.equal(snapshot.participantIdentity, 'nemo');
    assert.equal(snapshot.hasAgentTurnHandler, true);
    assert.equal(snapshot.apiKey, 'key');
    assert.equal(snapshot.apiSecret, 'secret');
    assert.deepEqual(snapshot.participantAttributes, {
      backend: 'livekit',
      session: 'daily',
      model: 'audio',
      agent: 'reviewer',
    });
    assert.match(snapshot.participantMetadata, /"session":"daily"/);
    assert.match(snapshot.participantMetadata, /"model":"audio"/);
    assert.match(snapshot.participantMetadata, /"agent":"reviewer"/);
  });

  it('uses configured LiveKit defaults when the command omits host and identity flags', async () => {
    const snapshot = {};
    const errors = [];
    const originalStart = VoiceLiveSession.prototype.start;
    const originalStop = VoiceLiveSession.prototype.stop;
    const originalLog = console.log;
    const session = new Session({
      systemPrompt: 'base prompt',
      maxHistory: 100,
      cwd: '/workspace/project',
    });

    VoiceLiveSession.prototype.start = async function () {
      snapshot.host = this.host;
      snapshot.port = this.port;
      snapshot.url = this.url;
      snapshot.personaHost = this.personaHost;
      snapshot.personaPort = this.personaPort;
      snapshot.roomName = this.roomName;
      snapshot.participantIdentity = this.participantIdentity;
      snapshot.apiKey = this.apiKey;
      snapshot.apiSecret = this.apiSecret;
    };
    VoiceLiveSession.prototype.stop = async function () {};
    console.log = () => {};

    try {
      await executeCommand('/voice livekit room standup', {
        config: {
          model: 'default-model',
          agentName: 'default-agent',
          baseUrl: 'http://127.0.0.1:30000',
          systemPrompt: 'base prompt',
          maxHistory: 100,
          livekitUrl: 'ws://127.0.0.1:7880',
          livekitTokenStrategy: 'mint',
          livekitApiKey: 'key',
          livekitApiSecret: 'secret',
          identity: 'config-identity',
          sessionId: 'config-session',
        },
        session,
        agent: {
          streamEnabled: true,
          swarmExecutor: null,
        },
        permissions: {
          availableTools: null,
        },
        mcpClient: null,
        ui: {
          pauseForVoice: async () => {},
          printError: (message) => errors.push(message),
        },
      });
    } finally {
      VoiceLiveSession.prototype.start = originalStart;
      VoiceLiveSession.prototype.stop = originalStop;
      console.log = originalLog;
    }

    assert.deepEqual(errors, []);
    assert.equal(snapshot.url, 'ws://127.0.0.1:7880');
    assert.equal(snapshot.host, undefined);
    assert.equal(snapshot.port, undefined);
    assert.equal(snapshot.personaHost, '10.1.0.4');
    assert.equal(snapshot.personaPort, 8998);
    assert.equal(snapshot.roomName, 'standup');
    assert.equal(snapshot.participantIdentity, 'config-identity');
    assert.equal(snapshot.apiKey, 'key');
    assert.equal(snapshot.apiSecret, 'secret');
  });
});

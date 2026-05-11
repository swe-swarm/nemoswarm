import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentSystem } from './agents.js';
import { DEFAULTS } from './config.js';

describe('AgentSystem routing overrides', () => {
  it('applies nested backend and livekit routing overrides', () => {
    const system = new AgentSystem();
    system.agents.set('voice-router', {
      name: 'voice-router',
      displayName: 'Voice Router',
      description: 'Routes voice work into LiveKit.',
      model: 'nemo-livekit',
      baseUrl: 'http://127.0.0.1:31000',
      routing: {
        backend: 'livekit',
        host: 'voice-node',
        room: 'ops-room',
        identity: 'router-agent',
        session: 'session-99',
      },
      livekit: {
        url: 'wss://livekit.example.com',
        tokenStrategy: 'token',
        token: 'override-token',
      },
      tools: ['view'],
      prompt: 'Routing from {{cwd}} on {{platform}}',
    });

    const baseConfig = {
      ...DEFAULTS,
      cwd: '/workspace/project',
      systemPrompt: 'base prompt',
    };

    const applied = system.applyAgent('voice-router', baseConfig);

    assert.ok(applied);
    assert.notEqual(applied, baseConfig);
    assert.equal(applied.model, 'nemo-livekit');
    assert.equal(applied.baseUrl, 'http://127.0.0.1:31000');
    assert.equal(applied.backend, 'livekit');
    assert.equal(applied.host, 'voice-node');
    assert.equal(applied.room, 'ops-room');
    assert.equal(applied.identity, 'router-agent');
    assert.equal(applied.sessionId, 'session-99');
    assert.equal(applied.livekitUrl, 'wss://livekit.example.com');
    assert.equal(applied.livekitTokenStrategy, 'token');
    assert.equal(applied.livekitToken, 'override-token');
    assert.deepEqual([...applied.availableTools], ['view']);
    assert.equal(applied.agentName, 'voice-router');
    assert.equal(applied.agentDisplayName, 'Voice Router');
    assert.match(applied.systemPrompt, /Routing from \/workspace\/project on/);

    assert.equal(baseConfig.backend, 'personaplex');
    assert.equal(baseConfig.livekitTokenStrategy, 'mint');
  });

  it('keeps the current config when agent routing overrides are invalid', () => {
    const system = new AgentSystem();
    system.agents.set('broken-router', {
      name: 'broken-router',
      baseUrl: 'notaurl',
      routing: {
        backend: 'invalid-backend',
      },
      livekit: {
        tokenStrategy: 'invalid-strategy',
      },
    });

    const baseConfig = {
      ...DEFAULTS,
      backend: 'livekit',
      baseUrl: 'http://127.0.0.1:32000',
      livekitTokenStrategy: 'token',
      livekitToken: 'base-token',
      systemPrompt: 'base prompt',
    };

    const applied = system.applyAgent('broken-router', baseConfig);

    assert.equal(applied.baseUrl, 'http://127.0.0.1:32000');
    assert.equal(applied.backend, 'livekit');
    assert.equal(applied.livekitTokenStrategy, 'token');
    assert.equal(applied.livekitToken, 'base-token');
  });

  it('lists agent routing metadata without exposing token overrides', () => {
    const system = new AgentSystem();
    system.agents.set('metadata-router', {
      name: 'metadata-router',
      model: 'router-model',
      routing: {
        backend: 'livekit',
        room: 'planning-room',
      },
      livekit: {
        url: 'wss://routing.example.com',
        tokenStrategy: 'token',
        token: 'secret-token',
      },
    });

    const listed = system.listAgents().find((agent) => agent.name === 'metadata-router');

    assert.equal(listed.backend, 'livekit');
    assert.equal(listed.room, 'planning-room');
    assert.equal(listed.livekitUrl, 'wss://routing.example.com');
    assert.equal(listed.livekitTokenStrategy, 'token');
    assert.ok(!Object.hasOwn(listed, 'livekitToken'));
  });
});

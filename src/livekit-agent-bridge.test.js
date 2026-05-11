import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createLiveKitNemoBridge } from './livekit-agent-bridge.js';
import { Session } from './session.js';

describe('createLiveKitNemoBridge', () => {
  it('applies routed agent context to room turns and restores session state', async () => {
    const session = new Session({
      systemPrompt: 'base prompt',
      maxHistory: 20,
      cwd: '/workspace/project',
    });
    const permissions = {
      availableTools: new Set(['view', 'bash']),
    };
    const ctx = {
      config: {
        baseUrl: 'http://127.0.0.1:30000',
        model: 'nemotron',
        systemPrompt: 'base prompt',
        maxHistory: 20,
      },
      session,
      ui: {},
      permissions,
      mcpClient: null,
      agentSystem: {
        applyAgent(name, config) {
          assert.equal(name, 'reviewer');
          return {
            ...config,
            model: 'reviewer-model',
            systemPrompt: 'reviewer prompt',
            maxHistory: 40,
            availableTools: new Set(['view']),
            agentName: 'reviewer',
            agentDisplayName: 'Reviewer',
          };
        },
      },
      agent: {
        streamEnabled: true,
        swarmExecutor: null,
      },
      persistSession() {
        ctx.persistCount += 1;
      },
      persistCount: 0,
    };

    const runs = [];
    const bridge = createLiveKitNemoBridge(
      ctx,
      {
        agent: 'reviewer',
        model: 'route-model',
        room: 'standup',
        session: 'daily',
      },
      {
        clientFactory(config) {
          return { config };
        },
        agentFactory(client, roomSession, ui, roomConfig, agentOptions) {
          return {
            onEvent: null,
            async run(prompt) {
              runs.push({ prompt, client, roomSession, ui, roomConfig, agentOptions });
              this.onEvent?.({
                type: 'assistant.message_delta',
                data: { content: 'Hello ' },
              });
              this.onEvent?.({
                type: 'assistant.message_delta',
                data: { content: 'world' },
              });
              return 'Hello world';
            },
          };
        },
      }
    );

    const streamed = [];
    const response = await bridge.sessionOptions.agentTurnHandler({
      message: 'Need a status update',
      participant: { identity: 'alice' },
      transport: 'chat',
      emitText: (chunk) => streamed.push(chunk),
    });

    assert.equal(response, 'Hello world');
    assert.deepEqual(streamed, ['Hello ', 'world']);
    assert.match(runs[0].prompt, /\[LiveKit input \| from alice \| room standup \| session daily \| transport chat\]/);
    assert.match(runs[0].prompt, /Need a status update/);
    assert.equal(runs[0].roomConfig.model, 'route-model');
    assert.equal(session.baseSystemPrompt, 'reviewer prompt');
    assert.equal(session.maxHistory, 40);
    assert.deepEqual([...permissions.availableTools], ['view']);
    assert.equal(ctx.persistCount, 1);

    await bridge.dispose();

    assert.equal(session.baseSystemPrompt, 'base prompt');
    assert.equal(session.maxHistory, 20);
    assert.deepEqual([...permissions.availableTools], ['view', 'bash']);
    assert.equal(ctx.persistCount, 2);
  });

  it('fails fast when a routed agent is unknown', () => {
    const session = new Session({ systemPrompt: 'base prompt' });

    assert.throws(
      () => createLiveKitNemoBridge(
        {
          config: {
            baseUrl: 'http://127.0.0.1:30000',
            model: 'nemotron',
            systemPrompt: 'base prompt',
            maxHistory: 20,
          },
          session,
          ui: {},
          agentSystem: {
            applyAgent() {
              return null;
            },
          },
        },
        { agent: 'missing-agent' }
      ),
      /Unknown agent: missing-agent/
    );
  });
});

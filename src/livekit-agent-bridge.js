import { Agent } from './agent.js';
import { NemotronClient } from './client.js';

function mergeAvailableTools(current, requested) {
  if (!requested) return current ?? null;
  if (!current) return new Set(requested);
  return new Set([...current].filter((tool) => requested.has(tool)));
}

function formatLiveKitTurnPrompt({ route, message, participant, transport, topic }) {
  const header = [
    'LiveKit input',
    participant?.identity ? `from ${participant.identity}` : null,
    route.room ? `room ${route.room}` : null,
    route.session ? `session ${route.session}` : null,
    transport ? `transport ${transport}` : null,
    topic ? `topic ${topic}` : null,
  ].filter(Boolean).join(' | ');
  return `[${header}]\n${message}`;
}

function resolveRoomConfig(ctx, route) {
  const cwd = ctx.session?.cwd || ctx.config?.cwd || process.cwd();
  let config = {
    ...ctx.config,
    cwd,
  };

  if (route.agent) {
    if (!ctx.agentSystem?.applyAgent) {
      throw new Error(`LiveKit routing requested agent "${route.agent}", but no agent system is available`);
    }
    const agentConfig = ctx.agentSystem.applyAgent(route.agent, config);
    if (!agentConfig) {
      throw new Error(`Unknown agent: ${route.agent}`);
    }
    config = {
      ...config,
      ...agentConfig,
    };
  }

  if (route.model) {
    config.model = route.model;
  }

  return config;
}

export function createLiveKitNemoBridge(ctx, route, options = {}) {
  if (!ctx?.session) throw new Error('LiveKit runtime requires an active Nemo session');
  if (!ctx?.config) throw new Error('LiveKit runtime requires loaded Nemo config');
  if (!ctx?.ui) throw new Error('LiveKit runtime requires a UI context');

  const effectiveConfig = resolveRoomConfig(ctx, route);
  const previousSystemPrompt = ctx.session.baseSystemPrompt;
  const previousMaxHistory = ctx.session.maxHistory;
  const previousAvailableTools = ctx.permissions?.availableTools ?? null;

  ctx.session.maxHistory = effectiveConfig.maxHistory ?? ctx.session.maxHistory;
  ctx.session.setSystem(effectiveConfig.systemPrompt ?? previousSystemPrompt);
  if (ctx.permissions) {
    ctx.permissions.availableTools = mergeAvailableTools(
      previousAvailableTools,
      effectiveConfig.availableTools
    );
  }

  const roomConfig = {
    ...effectiveConfig,
    backend: 'livekit',
    room: route.room ?? effectiveConfig.room ?? null,
    sessionId: route.session ?? effectiveConfig.sessionId ?? null,
    identity: route.identity ?? effectiveConfig.identity ?? null,
    agentName: route.agent ?? effectiveConfig.agentName ?? null,
  };

  const clientFactory = options.clientFactory ?? ((config) => new NemotronClient(config));
  const agentFactory = options.agentFactory ?? (
    (client, session, ui, config, agentOptions) => new Agent(client, session, ui, config, agentOptions)
  );

  const client = clientFactory(roomConfig);
  const agent = agentFactory(client, ctx.session, ctx.ui, roomConfig, {
    permissions: ctx.permissions ?? null,
    mcpClient: ctx.mcpClient ?? null,
    stream: ctx.agent?.streamEnabled !== false,
    outputFormat: 'stream-json',
    silent: true,
    swarmExecutor: ctx.agent?.swarmExecutor ?? null,
  });

  let disposed = false;

  return {
    sessionOptions: {
      agentTurnHandler: async ({ message, participant, transport, topic, emitText }) => {
        let streamedResponse = '';
        agent.onEvent = (event) => {
          if (event.type === 'assistant.message_delta' && event.data?.content) {
            streamedResponse += event.data.content;
            emitText?.(event.data.content);
          }
        };

        const prompt = formatLiveKitTurnPrompt({
          route,
          message,
          participant,
          transport,
          topic,
        });
        const response = await agent.run(prompt);
        ctx.persistSession?.();
        return String(response ?? streamedResponse).trim();
      },
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      if (ctx.permissions) {
        ctx.permissions.availableTools = previousAvailableTools;
      }
      ctx.session.maxHistory = previousMaxHistory;
      ctx.session.setSystem(previousSystemPrompt);
      ctx.persistSession?.();
    },
  };
}

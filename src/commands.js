// Slash commands — /help, /clear, /model, /exit, /compact, /status, /skills, /agents, /voice
// Also handles dynamic skill dispatch: /commit, /review, /fix, etc.
import chalk from 'chalk';
import { existsSync, statSync } from 'fs';
import { resolve } from 'path';
import {
  createVoiceSession,
  DEFAULT_VOICE_BACKEND,
  FLEET_NODES,
  listVoiceBackends,
  resolveVoiceBackend,
  VOICE_PROMPTS,
} from './voice.js';
import { createLiveKitNemoBridge } from './livekit-agent-bridge.js';

const DEFAULT_PERSONAPLEX_VOICE = 'natf0';

const VOICE_BACKEND_HINTS = Object.freeze({
  [DEFAULT_VOICE_BACKEND]: Object.freeze({
    name: DEFAULT_VOICE_BACKEND,
    label: 'PersonaPlex',
    description: 'Full-duplex voice over the existing PersonaPlex Moshi websocket flow.',
    aliases: ['moshi'],
    routeFields: ['node', 'host', 'port', 'voice'],
    examples: [
      '/voice antonjr1 natm0',
      '/voice personaplex antonjr1 natm0',
      '/voice backend personaplex node anton voice natm1',
    ],
  }),
  livekit: Object.freeze({
    name: 'livekit',
    label: 'VoiceLive',
    description: 'LiveKit room transport with PersonaPlex/Moshi as the audio conversation engine.',
    aliases: ['lk'],
    routeFields: ['node', 'host', 'port', 'voice', 'room', 'session', 'identity', 'model', 'agent'],
    examples: [
      '/voice livekit node anton room standup host ws://127.0.0.1:7880',
      '/voice --backend livekit --node antonjr1 --voice natm0 --room ops --session daily --identity nemo --agent reviewer --model audio',
    ],
  }),
});

const VOICE_OPTION_ALIASES = Object.freeze({
  backend: 'backend',
  host: 'host',
  server: 'host',
  port: 'port',
  node: 'node',
  room: 'room',
  session: 'session',
  'session-id': 'session',
  identity: 'identity',
  user: 'identity',
  model: 'model',
  agent: 'agent',
  voice: 'voice',
  'voice-prompt': 'voice',
});

function uniqueValues(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function mergeVoiceBackendMeta(backend = {}, hint = {}) {
  return {
    ...hint,
    ...backend,
    aliases: uniqueValues([...(hint.aliases || []), ...(backend.aliases || [])]),
    routeFields: backend.routeFields || hint.routeFields || [],
    examples: backend.examples || hint.examples || [],
    nodes: backend.nodes || hint.nodes || [],
    defaultNode: backend.defaultNode || hint.defaultNode,
  };
}

function listVoiceCommandBackends() {
  const actualBackends = new Map(listVoiceBackends().map((backend) => [backend.name, backend]));
  const backendNames = new Set([
    ...Object.keys(VOICE_BACKEND_HINTS),
    ...actualBackends.keys(),
  ]);

  return Array.from(backendNames, (name) =>
    mergeVoiceBackendMeta(actualBackends.get(name), VOICE_BACKEND_HINTS[name] || {})
  );
}

function resolveVoiceCommandBackend(name = DEFAULT_VOICE_BACKEND, backends = listVoiceCommandBackends()) {
  const backendNames = new Map();
  for (const backend of backends) {
    backendNames.set(String(backend.name).toLowerCase(), backend.name);
    for (const alias of backend.aliases || []) {
      backendNames.set(String(alias).toLowerCase(), backend.name);
    }
  }

  const resolvedName = backendNames.get(String(name).toLowerCase());
  if (!resolvedName) throw new Error(`Unknown voice backend: ${name}`);
  return backends.find((backend) => backend.name === resolvedName);
}

function tryResolveRuntimeVoiceBackend(name) {
  try {
    return resolveVoiceBackend(name);
  } catch {
    return null;
  }
}

function normalizeVoiceOptionName(token) {
  const normalized = String(token || '').replace(/^-+/, '').toLowerCase();
  return VOICE_OPTION_ALIASES[normalized] || null;
}

function extractInlineVoiceOption(token) {
  const separator = token.indexOf('=');
  if (separator === -1) return null;
  const key = normalizeVoiceOptionName(token.slice(0, separator));
  if (!key) return null;
  return {
    key,
    value: token.slice(separator + 1),
  };
}

function splitHostPort(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.includes('://')) return { host: raw };

  const bracketedIpv6 = raw.match(/^\[([0-9a-f:]+)\](?::(\d+))?$/i);
  if (bracketedIpv6) {
    return {
      host: bracketedIpv6[1],
      port: bracketedIpv6[2] ? Number.parseInt(bracketedIpv6[2], 10) : undefined,
    };
  }

  const hostPort = raw.match(/^([^:]+):(\d+)$/);
  if (hostPort) {
    return {
      host: hostPort[1],
      port: Number.parseInt(hostPort[2], 10),
    };
  }

  return { host: raw };
}

function formatVoiceEndpoint(host, port) {
  if (!host) return null;
  if (String(host).includes('://') || port == null) return String(host);
  return `${host}:${port}`;
}

function findVoiceNode(token, backend) {
  const needle = String(token || '').toLowerCase();
  return (backend.nodes || []).find((node) =>
    String(node.name).toLowerCase() === needle ||
    String(node.host).toLowerCase() === needle ||
    formatVoiceEndpoint(node.host, node.port)?.toLowerCase() === needle
  );
}

function looksLikeVoiceHost(token) {
  const value = String(token || '');
  return (
    value.includes('://') ||
    value === 'localhost' ||
    /^\d+\.\d+\.\d+\.\d+$/.test(value) ||
    /^\[[0-9a-f:]+\](?::\d+)?$/i.test(value) ||
    /^[a-z0-9][a-z0-9.-]*:\d+$/i.test(value) ||
    /^[a-z0-9][a-z0-9.-]*\.[a-z0-9-]+$/i.test(value)
  );
}

function setVoiceRouteValue(route, key, value) {
  if (!String(value || '').trim()) {
    return `Missing value for ${key}`;
  }

  switch (key) {
    case 'host': {
      const endpoint = splitHostPort(value);
      route.host = endpoint.host;
      if (endpoint.port != null) route.port = endpoint.port;
      return null;
    }
    case 'port': {
      const port = Number.parseInt(String(value), 10);
      if (!Number.isInteger(port) || port < 1) {
        return `Invalid voice port: ${value}`;
      }
      route.port = port;
      return null;
    }
    case 'node':
      route.nodeName = String(value);
      return null;
    case 'backend':
      route.backend = String(value);
      return null;
    case 'voice':
      route.voice = String(value);
      return null;
    case 'room':
    case 'session':
    case 'identity':
    case 'model':
    case 'agent':
      route[key] = String(value);
      return null;
    default:
      return `Unknown voice option: ${key}`;
  }
}

function detectVoiceBackendSelection(parts, backends) {
  const consumed = new Set();
  let backend = null;

  if (parts[0]) {
    try {
      backend = resolveVoiceCommandBackend(parts[0], backends);
      consumed.add(0);
    } catch {}
  }

  for (let i = 0; i < parts.length; i++) {
    const inlineOption = extractInlineVoiceOption(parts[i]);
    if (inlineOption?.key === 'backend') {
      try {
        backend = resolveVoiceCommandBackend(inlineOption.value, backends);
      } catch (error) {
        return { error: error.message };
      }
      consumed.add(i);
      continue;
    }

    if (normalizeVoiceOptionName(parts[i]) === 'backend') {
      const value = parts[i + 1];
      if (!value) return { error: 'Missing value for backend' };
      try {
        backend = resolveVoiceCommandBackend(value, backends);
      } catch (error) {
        return { error: error.message };
      }
      consumed.add(i);
      consumed.add(i + 1);
      i += 1;
    }
  }

  return {
    backend: backend || resolveVoiceCommandBackend(DEFAULT_VOICE_BACKEND, backends),
    consumed,
  };
}

function inferVoiceRouteValue(route, token, backend) {
  const lower = String(token).toLowerCase();
  const node = findVoiceNode(token, backend);
  if (node) {
    route.nodeName = node.name;
    return true;
  }

  if (VOICE_PROMPTS[lower]) {
    route.voice = lower;
    return true;
  }

  if (/\.pt$/i.test(token)) {
    route.voice = token;
    return true;
  }

  if (!route.host && (looksLikeVoiceHost(token) || backend.name === DEFAULT_VOICE_BACKEND)) {
    const endpoint = splitHostPort(token);
    route.host = endpoint.host;
    if (endpoint.port != null) route.port = endpoint.port;
    return true;
  }

  if (backend.name !== DEFAULT_VOICE_BACKEND) {
    if (!route.room) {
      route.room = token;
      return true;
    }
    if (!route.session) {
      route.session = token;
      return true;
    }
  }

  return false;
}

function finalizeVoiceRoute(route, backends) {
  const backend = resolveVoiceCommandBackend(route.backend, backends);
  const node = route.nodeName ? findVoiceNode(route.nodeName, backend) : null;
  if (route.nodeName && !node) {
    return {
      action: 'error',
      error: `Unknown ${backend.label} node: ${route.nodeName}`,
      backends,
    };
  }

  let host = route.host || node?.host || backend.defaultNode?.host;
  let port = route.port;
  let nodeName = route.nodeName || node?.name || backend.defaultNode?.name;

  if (port == null && node?.port != null) {
    port = node.port;
  } else if (port == null && backend.defaultNode?.port != null && host && !String(host).includes('://')) {
    port = backend.defaultNode.port;
  }

  let voiceKey = null;
  let voicePrompt = null;
  if (route.voice) {
    const loweredVoice = String(route.voice).toLowerCase();
    if (VOICE_PROMPTS[loweredVoice]) {
      voiceKey = loweredVoice;
      voicePrompt = VOICE_PROMPTS[loweredVoice];
    } else if (/\.pt$/i.test(route.voice)) {
      voiceKey = route.voice;
      voicePrompt = route.voice;
    } else if (backend.name === DEFAULT_VOICE_BACKEND || backend.name === 'livekit') {
      return {
        action: 'error',
        error: `Unknown voice prompt: ${route.voice}. Try /voice list to see available voices.`,
        backends,
      };
    } else {
      voiceKey = route.voice;
    }
  } else if (backend.name === DEFAULT_VOICE_BACKEND || backend.name === 'livekit') {
    voiceKey = DEFAULT_PERSONAPLEX_VOICE;
    voicePrompt = VOICE_PROMPTS[voiceKey];
  }

  const explicitLivekitUrl = backend.name === 'livekit' && String(host || '').includes('://')
    ? host
    : null;
  const personaHost = backend.name === 'livekit'
    ? (node?.host ?? (explicitLivekitUrl ? backend.defaultNode?.host : host))
    : null;
  const personaPort = backend.name === 'livekit'
    ? (node?.port ?? (explicitLivekitUrl ? backend.defaultNode?.port : port))
    : null;

  return {
    action: 'start',
    backends,
    backend,
    host,
    port,
    nodeName,
    room: route.room,
    session: route.session,
    identity: route.identity,
    model: route.model,
    agent: route.agent,
    voice: route.voice,
    voiceKey,
    voicePrompt,
    livekitUrl: explicitLivekitUrl,
    personaHost,
    personaPort,
  };
}

function formatVoiceExamples(backends) {
  const examples = [
    ['/voice', 'Start the default voice backend'],
    ['/voice help', 'Show routing help and examples'],
    ['/voice list', 'List backends, nodes, and prompts'],
  ];

  for (const backend of backends) {
    for (const example of backend.examples || []) {
      examples.push([example, backend.label]);
    }
  }

  return uniqueValues(examples.map(([command, detail]) => `${command}\u0000${detail}`))
    .map((entry) => entry.split('\u0000'));
}

function printVoiceUsage(backends) {
  console.log(chalk.bold('\n  Voice usage:\n'));
  console.log(chalk.dim('  Use positional shorthand, key=value, or --key value routing:\n'));
  for (const [command, detail] of formatVoiceExamples(backends)) {
    console.log(`  ${chalk.cyan(command.padEnd(62))} ${chalk.dim(detail)}`);
  }
  console.log(chalk.dim('\n  Routing keys: backend, node, host, port, voice, room, session, identity, model, agent\n'));
}

function printVoiceBackends(backends) {
  console.log(chalk.bold('\n  Voice backends:\n'));
  for (const backend of backends) {
    const isDefault = backend.name === DEFAULT_VOICE_BACKEND ? chalk.green(' (default)') : '';
    const runtimeState = tryResolveRuntimeVoiceBackend(backend.name)
      ? ''
      : chalk.yellow(' (routing staged)');
    console.log(`  ${chalk.cyan(backend.name.padEnd(12))} ${chalk.dim(backend.description || backend.label)}${isDefault}${runtimeState}`);
    if (backend.aliases?.length) {
      console.log(`  ${' '.repeat(12)} ${chalk.dim('aliases: ' + backend.aliases.join(', '))}`);
    }
    if (backend.routeFields?.length) {
      console.log(`  ${' '.repeat(12)} ${chalk.dim('routing: ' + backend.routeFields.join(', '))}`);
    }
  }
}

function printVoiceInventory(backends) {
  printVoiceBackends(backends);

  const defaultBackend = resolveVoiceCommandBackend(DEFAULT_VOICE_BACKEND, backends);
  if (defaultBackend.nodes?.length) {
    console.log(chalk.bold('\n  PersonaPlex nodes:\n'));
    for (const node of defaultBackend.nodes) {
      const active = node.name === defaultBackend.defaultNode?.name ? chalk.green(' (default)') : '';
      console.log(`  ${chalk.cyan(node.name.padEnd(12))} ${chalk.dim(formatVoiceEndpoint(node.host, node.port))}${active}`);
    }
  }

  console.log(chalk.bold('\n  Voice prompts:\n'));
  const groups = { 'Natural Female': [], 'Natural Male': [], 'Varied Female': [], 'Varied Male': [] };
  for (const key of Object.keys(VOICE_PROMPTS)) {
    if (key.startsWith('natf')) groups['Natural Female'].push(key);
    else if (key.startsWith('natm')) groups['Natural Male'].push(key);
    else if (key.startsWith('varf')) groups['Varied Female'].push(key);
    else if (key.startsWith('varm')) groups['Varied Male'].push(key);
  }
  for (const [group, keys] of Object.entries(groups)) {
    console.log(`  ${chalk.dim(group + ':')} ${keys.map((key) => chalk.green(key)).join('  ')}`);
  }

  printVoiceUsage(backends);

  if (backends.some((backend) => !tryResolveRuntimeVoiceBackend(backend.name))) {
    console.log(chalk.dim('  "routing staged" means the CLI already accepts those route options while the runtime loop lands.\n'));
  }
}

function buildVoiceSessionOptions(route, ctx) {
  const agentName = route.agent ?? ctx.config.agentName;
  const model = route.model ?? ctx.config.model;
  const explicitLivekitUrl = route.backend.name === 'livekit' && route.livekitUrl
    ? route.livekitUrl
    : undefined;
  const livekitUrl = route.backend.name === 'livekit'
    ? (explicitLivekitUrl ?? ctx.config.livekitUrl)
    : undefined;
  const targetHost = route.backend.name === 'livekit'
    ? undefined
    : route.host;
  const targetPort = route.backend.name === 'livekit'
    ? undefined
    : route.port;
  const identity = route.identity ?? ctx.config.identity ?? agentName ?? 'nemo';
  const roomName = route.room ?? ctx.config.room ?? null;
  const sessionId = route.session ?? ctx.config.sessionId ?? null;
  const routeAttributes = {
    backend: route.backend.name,
    ...(sessionId ? { session: sessionId } : {}),
    ...(model ? { model } : {}),
    ...(agentName ? { agent: agentName } : {}),
  };
  const hasRouteAttributes = Object.keys(routeAttributes).length > 0;
  const usesStaticToken = ctx.config.livekitTokenStrategy === 'token';

  return {
    backend: route.backend.name,
    host: targetHost,
    port: targetPort,
    personaHost: route.backend.name === 'livekit' ? route.personaHost : undefined,
    personaPort: route.backend.name === 'livekit' ? route.personaPort : undefined,
    url: livekitUrl,
    textPrompt: 'You are Nemo, a helpful AI voice assistant with a friendly personality.',
    voicePrompt: route.voicePrompt,
    room: roomName,
    roomName,
    session: sessionId,
    sessionId,
    identity,
    participantIdentity: identity,
    model,
    agent: agentName,
    agentName,
    token: route.backend.name === 'livekit' && usesStaticToken ? ctx.config.livekitToken : undefined,
    apiKey: route.backend.name === 'livekit' && !usesStaticToken ? ctx.config.livekitApiKey : undefined,
    apiSecret: route.backend.name === 'livekit' && !usesStaticToken ? ctx.config.livekitApiSecret : undefined,
    participantAttributes: hasRouteAttributes ? routeAttributes : undefined,
    participantMetadata: hasRouteAttributes ? routeAttributes : undefined,
  };
}

function printVoiceRouteSummary(route, ctx) {
  const endpoint = route.backend.name === 'livekit'
    ? (route.livekitUrl || ctx.config.livekitUrl || null)
    : formatVoiceEndpoint(route.host, route.port);
  const routeBits = [];
  const effectiveModel = route.model ?? ctx.config.model;
  const effectiveAgent = route.agent ?? ctx.config.agentName;

  console.log(chalk.bold.magenta('\n  ◆ Voice Mode'));
  console.log(chalk.dim(`  Backend: ${route.backend.label} (${route.backend.name})`));

  if (route.backend.name === DEFAULT_VOICE_BACKEND) {
    const nodeLabel = route.nodeName ? `${route.nodeName} → ` : '';
    const voiceLabel = route.voicePrompt ? `  Voice: ${route.voiceKey} (${route.voicePrompt})` : '';
    console.log(chalk.dim(`  Node: ${nodeLabel}${endpoint || 'default'}${voiceLabel}`));
    if (route.room) routeBits.push(`room ${route.room}`);
    if (route.session) routeBits.push(`session ${route.session}`);
    if (route.identity) routeBits.push(`identity ${route.identity}`);
    if (route.model) routeBits.push(`model ${effectiveModel}`);
    if (route.agent) routeBits.push(`agent ${effectiveAgent}`);
    if (routeBits.length) {
      console.log(chalk.dim(`  Route: ${routeBits.join('  ')}`));
    }
  } else {
    if (endpoint) console.log(chalk.dim(`  LiveKit: ${endpoint}`));
    if (route.personaHost) {
      const nodeLabel = route.nodeName ? `${route.nodeName} → ` : '';
      console.log(chalk.dim(`  Audio Engine: ${nodeLabel}${formatVoiceEndpoint(route.personaHost, route.personaPort)}`));
    }
    if (route.room) routeBits.push(`room ${route.room}`);
    if (route.session) routeBits.push(`session ${route.session}`);
    if (route.identity) routeBits.push(`identity ${route.identity}`);
    if (effectiveModel) routeBits.push(`model ${effectiveModel}`);
    if (effectiveAgent) routeBits.push(`agent ${effectiveAgent}`);
    if (route.voiceKey && route.voicePrompt) routeBits.push(`voice ${route.voiceKey}`);
    if (routeBits.length) {
      console.log(chalk.dim(`  Route: ${routeBits.join('  ')}`));
    }
  }
}

function printVoiceRuntimePending(route, ctx, reason = null) {
  printVoiceRouteSummary(route, ctx);
  const suffix = reason ? ` (${reason})` : '';
  console.log(chalk.yellow(`\n  Routing is ready, but ${route.backend.label} startup is still pending in the local runtime${suffix}.`));
  console.log(chalk.dim('  The in-process session loop can reuse these parsed options when the backend wiring lands.\n'));
}

export function parseVoiceCommandArgs(args, options = {}) {
  const parts = (args || '').trim().split(/\s+/).filter(Boolean);
  const backends = options.backends || listVoiceCommandBackends();

  if (!parts.length) {
    return finalizeVoiceRoute({ backend: DEFAULT_VOICE_BACKEND }, backends);
  }

  const first = parts[0].toLowerCase();
  if (first === 'help' || first === '--help' || first === '-h') {
    return { action: 'help', backends };
  }
  if (first === 'list') {
    return { action: 'list', backends };
  }

  const backendSelection = detectVoiceBackendSelection(parts, backends);
  if (backendSelection.error) {
    return { action: 'error', error: backendSelection.error, backends };
  }

  const route = {
    backend: backendSelection.backend.name,
    host: null,
    port: null,
    nodeName: null,
    voice: null,
    room: null,
    session: null,
    identity: null,
    model: null,
    agent: null,
  };

  const unknownParts = [];
  for (let i = 0; i < parts.length; i++) {
    if (backendSelection.consumed.has(i)) continue;

    const part = parts[i];
    if (part === '--help' || part === '-h') {
      return { action: 'help', backends };
    }

    const inlineOption = extractInlineVoiceOption(part);
    if (inlineOption) {
      const error = setVoiceRouteValue(route, inlineOption.key, inlineOption.value);
      if (error) return { action: 'error', error, backends };
      continue;
    }

    const optionKey = normalizeVoiceOptionName(part);
    if (optionKey) {
      const value = parts[i + 1];
      if (!value) {
        return { action: 'error', error: `Missing value for ${optionKey}`, backends };
      }
      const error = setVoiceRouteValue(route, optionKey, value);
      if (error) return { action: 'error', error, backends };
      i += 1;
      continue;
    }

    if (!inferVoiceRouteValue(route, part, backendSelection.backend)) {
      unknownParts.push(part);
    }
  }

  if (unknownParts.length) {
    return {
      action: 'error',
      error: `Unknown voice argument${unknownParts.length > 1 ? 's' : ''}: ${unknownParts.join(', ')}`,
      backends,
    };
  }

  return finalizeVoiceRoute(route, backends);
}

function buildVoiceCommandDescs() {
  const backends = listVoiceCommandBackends();
  const items = [
    { trigger: '/voice help', description: 'Show multi-backend voice routing help', category: 'voice' },
    { trigger: '/voice list', description: 'List voice backends, nodes, and prompts', category: 'voice' },
  ];

  for (const backend of backends) {
    items.push({
      trigger: `/voice ${backend.name}`,
      description: `Start ${backend.label} voice mode`,
      category: 'voice',
    });
  }

  const defaultBackend = resolveVoiceCommandBackend(DEFAULT_VOICE_BACKEND, backends);
  for (const node of defaultBackend.nodes || FLEET_NODES) {
    items.push({
      trigger: `/voice ${node.name}`,
      description: `Connect to ${node.name} (${formatVoiceEndpoint(node.host, node.port)})`,
      category: 'voice',
    });
  }

  items.push({
    trigger: '/voice livekit room demo',
    description: 'Route voice mode to a LiveKit room',
    category: 'voice',
  });

  return Object.freeze(items.filter((item, index, all) =>
    all.findIndex((candidate) => candidate.trigger === item.trigger) === index
  ));
}

const COMMANDS = {
  '/help': {
    description: 'Show available commands and skills',
    handler: (ctx) => {
      console.log(chalk.bold('\n  Built-in commands:\n'));
      for (const [cmd, info] of Object.entries(COMMANDS)) {
        console.log(`  ${chalk.cyan(cmd.padEnd(16))} ${chalk.dim(info.description)}`);
      }

      if (ctx.skillSystem) {
        const skills = ctx.skillSystem.list();
        if (skills.length > 0) {
          console.log(chalk.bold('\n  Skills (type /<name> [args]):\n'));
          for (const s of skills) {
            const tag = s.source === 'user' ? chalk.dim(' [user]') : '';
            console.log(`  ${chalk.green(('/' + s.name).padEnd(16))} ${chalk.dim(s.description)}${tag}`);
          }
        }
      }

      const agents = ctx.agentSystem?.listAgents() || [];
      if (agents.length > 0) {
        console.log(chalk.bold('\n  Agents (use --agent <name> or /agent <name>):\n'));
        for (const a of agents) {
          console.log(`  ${chalk.magenta(a.name.padEnd(16))} ${chalk.dim(a.description.trim())}`);
        }
      }

      console.log('');
    },
  },

  '/clear': {
    description: 'Clear conversation history',
    handler: (ctx) => {
      ctx.session.clear();
      console.clear();
      ctx.ui.splash();
      ctx.ui.statusBar(ctx.config);
      ctx.ui.printInfo('Conversation cleared.');
    },
  },

  '/exit': {
    description: 'Exit Nemo CLI',
    handler: (ctx) => {
      ctx.ui.printInfo('Goodbye!');
      ctx.ui.close();
      process.exit(0);
    },
  },

  '/model': {
    description: 'Show or change the current model',
    handler: async (ctx, args) => {
      if (args) {
        ctx.config.model = args;
        ctx.client.model = args;
        ctx.ui.printInfo(`Model changed to: ${args}`);
      } else {
        ctx.ui.printInfo(`Current model: ${ctx.config.model}`);
        ctx.ui.printInfo(`Server: ${ctx.config.baseUrl}`);
      }
    },
  },

  '/pwd': {
    description: 'Show the current working directory',
    handler: (ctx) => {
      ctx.ui.printInfo(`Working directory: ${ctx.session?.cwd || ctx.config.cwd || process.cwd()}`);
    },
  },

  '/cd': {
    description: 'Change the working directory for this Nemo session',
    handler: (ctx, args) => {
      const currentCwd = ctx.session?.cwd || ctx.config.cwd || process.cwd();
      if (!args) {
        ctx.ui.printInfo(`Working directory: ${currentCwd}`);
        return;
      }

      const target = resolve(currentCwd, args);
      if (!existsSync(target)) {
        ctx.ui.printError(`Path does not exist: ${target}`);
        return;
      }

      if (!statSync(target).isDirectory()) {
        ctx.ui.printError(`Not a directory: ${target}`);
        return;
      }

      ctx.session?.setCwd(target);
      ctx.config.cwd = target;
      if (ctx.refreshSessionMemory) ctx.refreshSessionMemory();
      ctx.ui.printInfo(`Working directory changed to: ${target}`);
    },
  },

  '/agents': {
    description: 'List all available agents (alias for /agent)',
    handler: (ctx, args) => COMMANDS['/agent'].handler(ctx, args),
  },

  '/agent': {
    description: 'List agents or switch: /agent <name>',
    handler: (ctx, args) => {
      if (!args) {
        const agents = ctx.agentSystem?.listAgents() || [];
        console.log(chalk.bold('\n  Available agents:\n'));
        for (const a of agents) {
          const active = ctx.config.agentName === a.name ? chalk.green(' (active)') : '';
          console.log(`  ${chalk.magenta(a.name.padEnd(16))} ${chalk.dim(a.description.trim())}${active}`);
        }
        console.log('');
        return;
      }
      ctx.config.cwd = ctx.session?.cwd || ctx.config.cwd || process.cwd();
      const agentConfig = ctx.agentSystem?.applyAgent(args, ctx.config);
      if (!agentConfig) {
        ctx.ui.printError(`Unknown agent: ${args}`);
        return;
      }
      Object.assign(ctx.config, agentConfig);
      ctx.client.model = ctx.config.model;
      if (ctx.session) {
        ctx.session.maxHistory = ctx.config.maxHistory || ctx.session.maxHistory;
        ctx.session.setSystem(ctx.config.systemPrompt);
        if (ctx.refreshSessionMemory) ctx.refreshSessionMemory();
      }
      ctx.ui.printInfo(`Switched to agent: ${ctx.config.agentDisplayName || args}`);
    },
  },

  '/skills': {
    description: 'List, install, or manage skills',
    handler: (ctx, args) => {
      if (!ctx.skillSystem) {
        ctx.ui.printError('Skill system not available');
        return;
      }

      const [sub, ...rest] = (args || '').split(' ').filter(Boolean);

      if (!sub || sub === 'list') {
        const skills = ctx.skillSystem.list();
        if (skills.length === 0) {
          ctx.ui.printInfo('No skills available.');
          return;
        }
        console.log(chalk.bold('\n  Available skills:\n'));
        const builtin = skills.filter(s => s.source === 'builtin');
        const user = skills.filter(s => s.source === 'user');

        if (builtin.length > 0) {
          console.log(chalk.dim('  Built-in:'));
          for (const s of builtin) {
            console.log(`    ${chalk.green(('/' + s.name).padEnd(14))} ${chalk.dim(s.description)}`);
          }
        }
        if (user.length > 0) {
          console.log(chalk.dim('\n  User-installed:'));
          for (const s of user) {
            console.log(`    ${chalk.green(('/' + s.name).padEnd(14))} ${chalk.dim(s.description)}`);
          }
        }
        console.log(chalk.dim('\n  Install a skill: /skills install <path-to-skill.yaml>'));
        console.log(chalk.dim('  User skills dir:  ~/.nemo-cli/skills/\n'));
        return;
      }

      if (sub === 'install') {
        const target = rest.join(' ');
        if (!target) {
          ctx.ui.printError('Usage: /skills install <path-to-skill.yaml>');
          return;
        }
        try {
          const skill = ctx.skillSystem.install(target);
          ctx.ui.printInfo(`Installed skill: /${skill.name} — ${skill.description || ''}`);
        } catch (err) {
          ctx.ui.printError(`Install failed: ${err.message}`);
        }
        return;
      }

      if (sub === 'uninstall') {
        const name = rest[0];
        if (!name) {
          ctx.ui.printError('Usage: /skills uninstall <name>');
          return;
        }
        try {
          ctx.skillSystem.uninstall(name);
          ctx.ui.printInfo(`Uninstalled skill: ${name}`);
        } catch (err) {
          ctx.ui.printError(`Uninstall failed: ${err.message}`);
        }
        return;
      }

      ctx.ui.printError(`Unknown subcommand: ${sub}. Try: /skills list | install | uninstall`);
    },
  },

  '/swarm': {
    description: 'Run a multi-agent swarm: /swarm <name> [task] or /swarm list',
    handler: async (ctx, args) => {
      if (!ctx.swarmSystem || !ctx.swarmRunner) {
        ctx.ui.printError('Swarm system not available');
        return;
      }

      const parts = (args || '').trim().split(/\s+/);
      const sub = parts[0];

      if (!sub || sub === 'list') {
        const swarms = ctx.swarmSystem.list();
        if (!swarms.length) { ctx.ui.printInfo('No swarms available.'); return; }
        console.log(chalk.bold('\n  Available swarms:\n'));
        for (const s of swarms) {
          const roles = (s.agents || []).map(a => a.role).join(', ');
          console.log(`  ${chalk.magenta((s.name || '').padEnd(16))} ${chalk.dim((s.description || '').trim().split('\n')[0])}`);
          console.log(`  ${' '.repeat(16)} ${chalk.dim('agents: ' + roles)}`);
        }
        console.log(chalk.dim('\n  Usage: /swarm <name> [task description]\n'));
        return;
      }

      const swarmDef = ctx.swarmSystem.get(sub);
      if (!swarmDef) {
        ctx.ui.printError(`Unknown swarm: "${sub}". Use /swarm list to see available swarms.`);
        return;
      }

      const task = parts.slice(1).join(' ') ||
        `Analyze and report on the codebase in ${ctx.session?.cwd || ctx.config.cwd || process.cwd()}`;
      if (ctx.persistSession) ctx.persistSession();
      await ctx.swarmRunner.run(swarmDef, task, ctx.ui, { rootSession: ctx.session });
      if (ctx.refreshSessionMemory) ctx.refreshSessionMemory();
    },
  },

  '/status': {
    description: 'Show server and session status',
    handler: async (ctx) => {
      const [healthy, slots] = await Promise.all([ctx.client.health(), ctx.client.slots()]);
      console.log(chalk.bold('\n  Status:\n'));
      console.log(`  ${chalk.dim('Health:')}    ${healthy ? chalk.green('✓ OK') : chalk.red('✗ Unreachable')}`);
      console.log(`  ${chalk.dim('Server:')}    ${ctx.config.baseUrl}`);
      console.log(`  ${chalk.dim('Model:')}     ${ctx.config.model}`);
      console.log(`  ${chalk.dim('CWD:')}       ${ctx.session?.cwd || ctx.config.cwd || process.cwd()}`);
      if (ctx.config.agentName) {
        console.log(`  ${chalk.dim('Agent:')}     ${ctx.config.agentDisplayName || ctx.config.agentName}`);
      }
      console.log(`  ${chalk.dim('Turns:')}     ${ctx.session.turnCount}`);
      console.log(`  ${chalk.dim('Messages:')}  ${ctx.session.messages.length}`);
      console.log(`  ${chalk.dim('~Tokens:')}   ${ctx.session.tokenEstimate.toLocaleString()}`);
      if (slots?.[0]) {
        const s = slots[0];
        console.log(`  ${chalk.dim('Slot:')}      ${s.is_processing ? chalk.yellow('processing') : chalk.green('idle')}`);
      }
      const skillCount = ctx.skillSystem?.list().length || 0;
      const agentCount = ctx.agentSystem?.listAgents().length || 0;
      console.log(`  ${chalk.dim('Skills:')}    ${skillCount} loaded`);
      console.log(`  ${chalk.dim('Agents:')}    ${agentCount} available`);
      console.log('');
    },
  },

  '/compact': {
    description: 'Summarize and compact conversation history',
    handler: async (ctx) => {
      ctx.ui.printInfo('Compacting conversation...');
      const msgs = ctx.session.getMessages();
      const summaryPrompt = [
        { role: 'system', content: 'Summarize the following conversation in 2-3 sentences. Focus on key decisions, code changes, and outcomes.' },
        { role: 'user', content: msgs.map(m => `${m.role}: ${(m.content || '').slice(0, 500)}`).join('\n') },
      ];
      try {
        const resp = await ctx.client.chat(summaryPrompt, null, { maxTokens: 256 });
        const summary = resp.choices[0].message.content;
        ctx.session.compact(summary);
        ctx.ui.printInfo(`Compacted to summary: "${summary.slice(0, 150)}..."`);
      } catch (err) {
        ctx.ui.printError(`Compact failed: ${err.message}`);
      }
    },
  },

  '/cluster': {
    description: 'Show cluster node status and health',
    handler: async (ctx) => {
      const { ClusterManager } = await import('./cluster.js');
      const cm = ctx.cluster || new ClusterManager();
      const status = await cm.status();
      console.log(chalk.bold('\n  Cluster Status:\n'));
      for (const n of status.nodes) {
        const sym = n.healthy && n.voiceHealthy ? chalk.green('OK') : chalk.yellow('WARN');
        const llm = n.healthy ? chalk.green('llm:OK') : chalk.red('llm:DOWN');
        const voice = n.voiceHealthy ? chalk.green('voice:OK') : chalk.red('voice:DOWN');
        const local = n.isLocal ? chalk.cyan(' (local)') : '';
        const label = (n.name + ' ').padEnd(14);
        console.log('  ' + sym + ' ' + label + n.host + ':' + n.port + '  ' + llm + '  ' + voice + ':' + n.voicePort + '  ' + n.role + local);
      }
      console.log(
        '\n  Local: ' + status.local +
        ' | LLM remotes: ' + status.healthyRemotes + '/' + (status.total - 1) +
        ' | Voice remotes: ' + status.voiceHealthyRemotes + '/' + (status.total - 1) +
        '\n'
      );
    },
  },

  '/temp': {
    description: 'Set temperature (e.g. /temp 0.3)',
    handler: (ctx, args) => {
      const t = parseFloat(args);
      if (isNaN(t) || t < 0 || t > 2) {
        ctx.ui.printError('Temperature must be between 0 and 2');
        return;
      }
      ctx.config.temperature = t;
      ctx.client.temperature = t;
      ctx.ui.printInfo(`Temperature set to ${t}`);
    },
  },

  '/tokens': {
    description: 'Set max output tokens (e.g. /tokens 8192)',
    handler: (ctx, args) => {
      const n = parseInt(args);
      if (isNaN(n) || n < 1) {
        ctx.ui.printError('Invalid token count');
        return;
      }
      ctx.config.maxTokens = n;
      ctx.client.maxTokens = n;
      ctx.ui.printInfo(`Max tokens set to ${n}`);
    },
  },

  '/voice': {
    description: 'Start voice mode or show voice routing help',
    handler: async (ctx, args) => {
      const route = parseVoiceCommandArgs(args);

      if (route.action === 'help') {
        printVoiceUsage(route.backends);
        return;
      }

      if (route.action === 'list') {
        printVoiceInventory(route.backends);
        return;
      }

      if (route.action === 'error') {
        ctx.ui.printError(route.error);
        printVoiceUsage(route.backends || listVoiceCommandBackends());
        return;
      }

      if (!tryResolveRuntimeVoiceBackend(route.backend.name)) {
        printVoiceRuntimePending(route, ctx);
        return;
      }

      let session;
      let livekitBridge;
      try {
        if (route.backend.name === 'livekit') {
          livekitBridge = createLiveKitNemoBridge(ctx, route);
        }
        session = createVoiceSession({
          ...buildVoiceSessionOptions(route, ctx),
          ...(livekitBridge?.sessionOptions ?? {}),
        });
      } catch (error) {
        await livekitBridge?.dispose?.();
        if (/Unknown voice backend|not implemented/i.test(error.message)) {
          printVoiceRuntimePending(route, ctx, error.message);
          return;
        }
        console.log(chalk.red(`\n  ✗ Voice setup failed: ${error.message}\n`));
        return;
      }

      printVoiceRouteSummary(route, ctx);

      session.on('status', (msg) => console.log(chalk.dim(`  ${msg}`)));
      session.on('error', (e) => console.log(chalk.red(`\n  Voice error: ${e.message}`)));
      session.on('close', () => console.log(chalk.dim('\n  Session closed.')));

      let transcriptLine = false;
      session.on('text', (token) => {
        if (!transcriptLine) {
          process.stdout.write(chalk.dim('\n  ') + chalk.cyan.bold('Nemo: '));
          transcriptLine = true;
        }
        process.stdout.write(chalk.cyan(token));
        if (/[.!?]$/.test(token.trim())) {
          process.stdout.write('\n');
          transcriptLine = false;
        }
      });

      try {
        await session.start();
        console.log(chalk.green('\n  ✓ Ready. Speak naturally — full duplex audio active.'));
        console.log(chalk.dim('  Press Enter to exit voice mode.\n'));

        await ctx.ui.pauseForVoice();
        await session.stop();
        console.log(chalk.dim('\n  Voice mode ended.\n'));
      } catch (error) {
        await session.stop();
        console.log(chalk.red(`\n  ✗ Connection failed: ${error.message}`));
        const endpoint = formatVoiceEndpoint(route.host, route.port);
        if (endpoint) {
          console.log(chalk.dim(`  Check that ${route.backend.label} is running on ${endpoint}\n`));
        } else {
          console.log(chalk.dim(`  Check that ${route.backend.label} is reachable with the requested route.\n`));
        }
        console.log(chalk.dim('  Tip: /voice list  to review routing options\n'));
      } finally {
        await livekitBridge?.dispose?.();
      }
    },
  },
};

export const VOICE_COMMAND_DESCS = buildVoiceCommandDescs();

// Export flat list of command descriptors for autocomplete
export const COMMAND_DESCS = Object.entries(COMMANDS).map(([trigger, info]) => ({
  trigger,
  description: info.description,
  category: 'commands',
}));

export function isCommand(input) {
  return input.startsWith('/');
}

export async function executeCommand(input, ctx) {
  const firstSpace = input.indexOf(' ');
  const cmd = firstSpace === -1 ? input : input.slice(0, firstSpace);
  const args = firstSpace === -1 ? '' : input.slice(firstSpace + 1).trim();

  // Built-in commands
  if (COMMANDS[cmd]) {
    await COMMANDS[cmd].handler(ctx, args);
    return;
  }

  // Dynamic skill dispatch — /commit, /review, /fix, etc.
  const skillName = cmd.slice(1); // strip leading /
  if (ctx.skillSystem?.has(skillName)) {
    const expanded = ctx.skillSystem.expand(skillName, args);
    if (expanded) {
      // Apply skill tool restrictions if defined
      let oldAvailable = null;
      if (expanded.tools && ctx.permissions) {
        oldAvailable = ctx.permissions.availableTools;
        ctx.permissions.availableTools = new Set(expanded.tools);
      }
      try {
        await ctx.agent.run(expanded.prompt);
      } finally {
        if (oldAvailable !== null && ctx.permissions) {
          ctx.permissions.availableTools = oldAvailable;
        }
      }
      return;
    }
  }

  ctx.ui.printError(`Unknown command: ${cmd}. Type /help for available commands and skills.`);
}

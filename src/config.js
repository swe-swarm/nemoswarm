// Configuration defaults and loader
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';

const DEFAULT_CLUSTER_PROMPT = `## This Machine (Peer Orchestrator)
- Hostname: anton
- IP: 10.1.0.4
- Role: Independent orchestrator/coordinator/processor/validator
- OS: Ubuntu 24.04.4 LTS | Kernel: 6.8.0-101-generic
- CPU: AMD Ryzen Threadripper 3990X 64-Core (128 threads)
- RAM: 251 Gi
- GPU: NVIDIA GeForce RTX 5090 (32607 MiB / ~32 GB VRAM)
- Disk: 5.4 TB root filesystem
- Services: darbotlm-node (:9000/:9443), node-exporter (:9100), Prometheus (:9090)

## Cluster Nodes

### antonjr1 (10.1.0.5) — Peer Orchestrator
- CPU: AMD Ryzen Threadripper 3970X 32-Core (64 threads)
- RAM: 251 Gi
- GPU: 2x NVIDIA RTX A4000 (16376 MiB each, ~32 GB total)
- Disk: 5.8 TB root filesystem
- Services: darbotlm-node (:9000/:9443), node-exporter (Docker, :9100), Prometheus (:9090)
- Nemo CLI: /home/darbot/nemo-cli/bin/nemo.js
- User: darbot

### antonjr2 (10.1.0.6) — Peer Orchestrator
- CPU: AMD Ryzen Threadripper 3970X 32-Core (64 threads)
- RAM: 125 Gi
- GPU: NVIDIA GeForce RTX 4090 (24564 MiB / ~24 GB VRAM)
- Disk: 3.6 TB root filesystem
- Services: darbotlm-node (no exposed ports), node-exporter (systemd, :9100), Prometheus (:9090), keepalived (HA failover)
- Nemo CLI: /home/darbot/nemo-cli/bin/nemo.js
- User: darbot

## Orchestration

You have passwordless SSH access to both peer orchestrators as user darbot:
  ssh darbot@10.1.0.5 "<command>"
  ssh darbot@10.1.0.6 "<command>"

### Remote command execution
Run a command on a peer:
  ssh darbot@10.1.0.5 "hostname && nvidia-smi"

Run a command on ALL nodes (including this one):
  bash -c "<command>" && ssh darbot@10.1.0.5 "<command>" && ssh darbot@10.1.0.6 "<command>"

### Dispatch nemo on a peer
Send a prompt to the nemo agent running on a peer orchestrator:
  ssh darbot@10.1.0.5 "node ~/nemo-cli/bin/nemo.js --prompt '<task>' --allow-all"
  ssh darbot@10.1.0.6 "node ~/nemo-cli/bin/nemo.js --prompt '<task>' --allow-all"

### Docker management on peers
  ssh darbot@10.1.0.5 "docker ps"
  ssh darbot@10.1.0.6 "docker logs darbotlm-node --tail 20"

### Prometheus queries (any node with Prometheus on :9090)
  curl -s 'http://localhost:9090/api/v1/query?query=up'
  curl -s 'http://10.1.0.5:9090/api/v1/query?query=node_cpu_seconds_total'

### Cluster health check pattern
  for ip in 10.1.0.4 10.1.0.5 10.1.0.6; do echo "--- $ip ---"; ssh darbot@$ip "hostname && uptime && docker ps --format '{{.Names}}: {{.Status}}'"; done

### GPU status across cluster
  for ip in 10.1.0.4 10.1.0.5 10.1.0.6; do echo "--- $ip ---"; ssh darbot@$ip "nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader"; done`;

function getClusterPrompt(configDir) {
  const clusterPath = join(configDir, 'cluster-prompt.md');
  if (existsSync(clusterPath)) {
    try {
      return readFileSync(clusterPath, 'utf-8').trim();
    } catch { /* fall through to default */ }
  }
  return DEFAULT_CLUSTER_PROMPT;
}

export const SUPPORTED_BACKENDS = Object.freeze(['personaplex', 'livekit']);
export const LIVEKIT_TOKEN_STRATEGIES = Object.freeze(['mint', 'token']);

function pickFirstDefined(...values) {
  return values.find((value) => value !== undefined);
}

function normalizeOptionalString(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function extractRoutingOverrides(source = {}) {
  if (!source || typeof source !== 'object') return {};

  const routing = source.routing && typeof source.routing === 'object' ? source.routing : {};
  const livekit = source.livekit && typeof source.livekit === 'object' ? source.livekit : {};
  const overrides = {};

  const backend = pickFirstDefined(source.backend, routing.backend);
  if (backend !== undefined) {
    const normalizedBackend = normalizeOptionalString(backend);
    overrides.backend = typeof normalizedBackend === 'string'
      ? normalizedBackend.toLowerCase()
      : normalizedBackend;
  }

  const host = pickFirstDefined(source.host, routing.host);
  if (host !== undefined) overrides.host = normalizeOptionalString(host);

  const room = pickFirstDefined(source.room, routing.room);
  if (room !== undefined) overrides.room = normalizeOptionalString(room);

  const identity = pickFirstDefined(source.identity, routing.identity);
  if (identity !== undefined) overrides.identity = normalizeOptionalString(identity);

  const sessionId = pickFirstDefined(source.sessionId, source.session, routing.sessionId, routing.session);
  if (sessionId !== undefined) overrides.sessionId = normalizeOptionalString(sessionId);

  const livekitUrl = pickFirstDefined(source.livekitUrl, livekit.url);
  if (livekitUrl !== undefined) overrides.livekitUrl = normalizeOptionalString(livekitUrl);

  const livekitTokenStrategy = pickFirstDefined(source.livekitTokenStrategy, livekit.tokenStrategy);
  if (livekitTokenStrategy !== undefined) {
    const normalizedStrategy = normalizeOptionalString(livekitTokenStrategy);
    overrides.livekitTokenStrategy = typeof normalizedStrategy === 'string'
      ? normalizedStrategy.toLowerCase()
      : normalizedStrategy;
  }

  const livekitToken = pickFirstDefined(source.livekitToken, livekit.token);
  if (livekitToken !== undefined) overrides.livekitToken = normalizeOptionalString(livekitToken);

  const livekitApiKey = pickFirstDefined(source.livekitApiKey, livekit.apiKey);
  if (livekitApiKey !== undefined) overrides.livekitApiKey = normalizeOptionalString(livekitApiKey);

  const livekitApiSecret = pickFirstDefined(source.livekitApiSecret, livekit.apiSecret);
  if (livekitApiSecret !== undefined) overrides.livekitApiSecret = normalizeOptionalString(livekitApiSecret);

  return overrides;
}

function normalizeConfigSource(source = {}) {
  if (!source || typeof source !== 'object') return {};
  const normalized = { ...source, ...extractRoutingOverrides(source) };
  delete normalized.routing;
  delete normalized.livekit;
  delete normalized.session;
  return normalized;
}

function validateOptionalString(config, defaults, key, label) {
  if (config[key] === null) return;
  if (typeof config[key] !== 'string') {
    console.error(`Invalid ${label} "${config[key]}" — must be a string when provided. Using default (${defaults[key] ?? 'null'}).`);
    config[key] = defaults[key];
    return;
  }
  const trimmed = config[key].trim();
  config[key] = trimmed === '' ? defaults[key] : trimmed;
}

function validateOptionalSecretString(config, defaults, key, label) {
  if (config[key] === null) return;
  if (typeof config[key] !== 'string') {
    console.error(`Invalid ${label} — must be a string when provided. Using default.`);
    config[key] = defaults[key];
    return;
  }
  const trimmed = config[key].trim();
  config[key] = trimmed === '' ? defaults[key] : trimmed;
}

export function validateConfig(config, defaults) {
  if (typeof config.temperature !== 'number' || config.temperature < 0 || config.temperature > 2) {
    console.error(`Invalid temperature "${config.temperature}" — must be a number between 0 and 2. Using default (${defaults.temperature}).`);
    config.temperature = defaults.temperature;
  }
  if (!Number.isInteger(config.maxTokens) || config.maxTokens <= 0) {
    console.error(`Invalid maxTokens "${config.maxTokens}" — must be a positive integer. Using default (${defaults.maxTokens}).`);
    config.maxTokens = defaults.maxTokens;
  }
  if (!Number.isInteger(config.maxHistory) || config.maxHistory <= 0) {
    console.error(`Invalid maxHistory "${config.maxHistory}" — must be a positive integer. Using default (${defaults.maxHistory}).`);
    config.maxHistory = defaults.maxHistory;
  }
  if (typeof config.baseUrl !== 'string' || !/^https?:\/\//.test(config.baseUrl)) {
    console.error(`Invalid baseUrl "${config.baseUrl}" — must start with http:// or https://. Using default (${defaults.baseUrl}).`);
    config.baseUrl = defaults.baseUrl;
  }
  if (
    typeof config.chatCompletionsPath !== 'string' ||
    config.chatCompletionsPath.trim() === '' ||
    !config.chatCompletionsPath.trim().startsWith('/')
  ) {
    console.error(`Invalid chatCompletionsPath "${config.chatCompletionsPath}" — must be a non-empty path starting with "/". Using default (${defaults.chatCompletionsPath}).`);
    config.chatCompletionsPath = defaults.chatCompletionsPath;
  } else {
    config.chatCompletionsPath = config.chatCompletionsPath.trim();
  }
  validateOptionalString(config, defaults, 'apiVersion', 'apiVersion');
  validateOptionalSecretString(config, defaults, 'bearerToken', 'bearerToken');
  validateOptionalSecretString(config, defaults, 'apimSubscriptionKey', 'apimSubscriptionKey');
  if (!Number.isInteger(config.reasoningBudget) || config.reasoningBudget < 0) {
    console.error(`Invalid reasoningBudget "${config.reasoningBudget}" — must be a non-negative integer. Using default (${defaults.reasoningBudget}).`);
    config.reasoningBudget = defaults.reasoningBudget;
  }
  if (!SUPPORTED_BACKENDS.includes(config.backend)) {
    console.error(`Invalid backend "${config.backend}" — must be one of ${SUPPORTED_BACKENDS.join(', ')}. Using default (${defaults.backend}).`);
    config.backend = defaults.backend;
  }

  validateOptionalString(config, defaults, 'host', 'host');
  validateOptionalString(config, defaults, 'room', 'room');
  validateOptionalString(config, defaults, 'identity', 'identity');
  validateOptionalString(config, defaults, 'sessionId', 'sessionId');

  if (typeof config.livekitUrl !== 'string' || !/^(?:https?|wss?):\/\//.test(config.livekitUrl)) {
    console.error(`Invalid livekitUrl "${config.livekitUrl}" — must start with ws://, wss://, http://, or https://. Using default (${defaults.livekitUrl}).`);
    config.livekitUrl = defaults.livekitUrl;
  }
  if (!LIVEKIT_TOKEN_STRATEGIES.includes(config.livekitTokenStrategy)) {
    console.error(`Invalid livekitTokenStrategy "${config.livekitTokenStrategy}" — must be one of ${LIVEKIT_TOKEN_STRATEGIES.join(', ')}. Using default (${defaults.livekitTokenStrategy}).`);
    config.livekitTokenStrategy = defaults.livekitTokenStrategy;
  }

  validateOptionalString(config, defaults, 'livekitToken', 'livekitToken');
  validateOptionalString(config, defaults, 'livekitApiKey', 'livekitApiKey');
  validateOptionalString(config, defaults, 'livekitApiSecret', 'livekitApiSecret');

  if (config.livekitTokenStrategy === 'token' && !config.livekitToken) {
    console.error(`Invalid livekitTokenStrategy "${config.livekitTokenStrategy}" — livekitToken is required when using the token strategy. Using default (${defaults.livekitTokenStrategy}).`);
    config.livekitTokenStrategy = defaults.livekitTokenStrategy;
    config.livekitToken = defaults.livekitToken;
  }
}

export const DEFAULTS = Object.freeze({
  baseUrl: 'http://127.0.0.1:30000',
  chatCompletionsPath: '/v1/chat/completions',
  apiVersion: null,
  bearerToken: null,
  apimSubscriptionKey: null,
  model: 'nemotron',
  maxTokens: 16384,
  temperature: 0.5,
  reasoningBudget: 256,
  maxHistory: 100,
  backend: 'personaplex',
  host: null,
  room: null,
  identity: null,
  sessionId: null,
  livekitUrl: 'ws://127.0.0.1:7880',
  livekitTokenStrategy: 'mint',
  livekitToken: null,
  livekitApiKey: null,
  livekitApiSecret: null,
  systemPrompt: `You are Nemo, an independent orchestrator/coordinator/processor/validator in the Darbot LM cluster. You run 100% locally on Nemotron. No data leaves this machine.

{{cluster}}

## Behaviors
- Be concise and direct. Use tools proactively.
- Make minimal surgical edits when changing files.
- Always verify your work.
- When asked about the cluster, query all nodes in parallel or sequence as appropriate.
- When dispatching work to peers, use SSH. For complex tasks, dispatch nemo on the remote node.

## Reasoning Discipline
- Keep thinking brief: identify the task, decide the approach, then act.
- Do NOT enumerate alternatives, debate formatting, or over-plan.
- If a bash command is needed, write and execute it immediately.

## Environment
- Working directory: {{cwd}}
- OS: {{platform}}`,
});

export function loadConfig(overrides = {}) {
  const configDir = process.env.NEMO_HOME || join(process.env.HOME || '', '.nemo-cli');

  // 1. Load file config
  let rawFileConfig = {};
  const configPath = join(configDir, 'config.yaml');
  if (existsSync(configPath)) {
    try {
      rawFileConfig = yaml.load(readFileSync(configPath, 'utf-8')) || {};
    } catch { /* ignore bad config */ }
  }
  const fileConfig = normalizeConfigSource(rawFileConfig);

  // 2. Load env var overrides (between file config and CLI overrides)
  const rawEnvConfig = {};
  if (process.env.NEMO_URL) rawEnvConfig.baseUrl = process.env.NEMO_URL;
  else if (process.env.NEMO_PORT) {
    const base = fileConfig.baseUrl || DEFAULTS.baseUrl;
    try {
      const u = new URL(base);
      u.port = process.env.NEMO_PORT;
      rawEnvConfig.baseUrl = u.toString().replace(/\/$/, '');
    } catch { /* ignore invalid base URL for port override */ }
  }
  if (process.env.NEMO_MODEL) rawEnvConfig.model = process.env.NEMO_MODEL;
  if (process.env.NEMO_TEMP) rawEnvConfig.temperature = Number(process.env.NEMO_TEMP);
  if (process.env.NEMO_TOKENS) rawEnvConfig.maxTokens = Number(process.env.NEMO_TOKENS);
  if (process.env.NEMO_CHAT_COMPLETIONS_PATH !== undefined) rawEnvConfig.chatCompletionsPath = process.env.NEMO_CHAT_COMPLETIONS_PATH;
  if (process.env.NEMO_API_VERSION !== undefined) rawEnvConfig.apiVersion = process.env.NEMO_API_VERSION;
  if (process.env.NEMO_BEARER_TOKEN !== undefined) rawEnvConfig.bearerToken = process.env.NEMO_BEARER_TOKEN;
  if (process.env.NEMO_APIM_SUBSCRIPTION_KEY !== undefined) rawEnvConfig.apimSubscriptionKey = process.env.NEMO_APIM_SUBSCRIPTION_KEY;
  if (process.env.NEMO_BACKEND) rawEnvConfig.backend = process.env.NEMO_BACKEND;
  if (process.env.NEMO_HOST) rawEnvConfig.host = process.env.NEMO_HOST;
  if (process.env.NEMO_ROOM) rawEnvConfig.room = process.env.NEMO_ROOM;
  if (process.env.NEMO_IDENTITY) rawEnvConfig.identity = process.env.NEMO_IDENTITY;
  if (process.env.NEMO_SESSION_ID) rawEnvConfig.sessionId = process.env.NEMO_SESSION_ID;
  else if (process.env.NEMO_SESSION) rawEnvConfig.session = process.env.NEMO_SESSION;
  if (process.env.LIVEKIT_URL) rawEnvConfig.livekitUrl = process.env.LIVEKIT_URL;
  if (process.env.LIVEKIT_TOKEN_STRATEGY) rawEnvConfig.livekitTokenStrategy = process.env.LIVEKIT_TOKEN_STRATEGY;
  if (process.env.LIVEKIT_TOKEN) rawEnvConfig.livekitToken = process.env.LIVEKIT_TOKEN;
  if (process.env.LIVEKIT_API_KEY) rawEnvConfig.livekitApiKey = process.env.LIVEKIT_API_KEY;
  if (process.env.LIVEKIT_API_SECRET) rawEnvConfig.livekitApiSecret = process.env.LIVEKIT_API_SECRET;
  const envConfig = normalizeConfigSource(rawEnvConfig);

  // 3. Merge: defaults < file config < env vars < CLI overrides
  const config = { ...DEFAULTS, ...fileConfig, ...envConfig };
  const overrideConfig = normalizeConfigSource(overrides);
  for (const [key, value] of Object.entries(overrideConfig)) {
    if (value !== undefined) config[key] = value;
  }

  // 4. Validate merged config
  validateConfig(config, DEFAULTS);

  // 5. Inject cluster prompt and resolve template placeholders
  config.cwd = config.cwd || process.cwd();
  config.systemPrompt = config.systemPrompt
    .replace('{{cluster}}', getClusterPrompt(configDir))
    .replace('{{cwd}}', config.cwd)
    .replace('{{platform}}', process.platform);

  return config;
}

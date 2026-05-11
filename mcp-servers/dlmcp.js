#!/usr/bin/env node
// DarbotLM DLMCP + Moshi MCP Server
// Exposes the DarbotLM gateway and PersonaPlex voice service as standard MCP tools.
// Transport: JSON-RPC 2.0 over stdio (loaded by nemo via ~/.nemo-cli/mcp-config.json)
//
// Tools exposed:
//   dlmcp_services   — list all services + health
//   dlmcp_nodes      — fleet node status
//   dlmcp_providers  — AI providers + AG2 connectors
//   dlmcp_templates  — GenAI orchestration templates
//   moshi_health     — PersonaPlex voice service health
//   moshi_info       — voice service metadata + WebSocket endpoint
//   moshi_voices     — available voice prompts

import { createInterface } from 'readline';

const DEFAULT_GATEWAYS = ['http://10.1.0.4:9000', 'http://10.1.0.5:9000'];
const GATEWAYS = (process.env.DLMCP_GATEWAYS || process.env.DLMCP_GATEWAY || DEFAULT_GATEWAYS.join(','))
  .split(',')
  .map((item) => item.trim().replace(/\/+$/, ''))
  .filter(Boolean);
const GATEWAY  = GATEWAYS[0];
const TIMEOUT  = 15_000;

const VOICELIVE_NODES = [
  { name: 'anton', host: '10.1.0.4', role: 'primary' },
  { name: 'antonjr1', host: '10.1.0.5', role: 'worker' },
  { name: 'antonjr2', host: '10.1.0.6', role: 'worker' },
];

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function get(path) {
  let lastError = null;
  for (const gateway of GATEWAYS) {
    const url = `${gateway}${path}`;
    let resp;
    try {
      resp = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
    } catch (err) {
      lastError = new Error(`Network error fetching ${url}: ${err.message}`);
      continue;
    }
    if (!resp.ok) {
      lastError = new Error(`HTTP ${resp.status} from ${url}`);
      continue;
    }
    return resp.json();
  }
  throw lastError || new Error(`No DLMCP gateways configured for ${path}`);
}

async function probeHttp(url, timeout = 3000, isHealthyStatus = (status) => status >= 200 && status < 300) {
  const started = Date.now();
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    return {
      ok: isHealthyStatus(resp.status),
      http_status: resp.status,
      latency_ms: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      latency_ms: Date.now() - started,
    };
  }
}

async function getVoiceLiveStatus() {
  const nodes = await Promise.all(VOICELIVE_NODES.map(async (node) => {
    const [llm, moshi, livekit, gateway] = await Promise.all([
      probeHttp(`http://${node.host}:30000/health`),
      probeHttp(`http://${node.host}:8998/`),
      probeHttp(`http://${node.host}:7880/`, 3000, (status) => status < 500),
      probeHttp(`http://${node.host}:9000/moshi/health`),
    ]);
    return {
      ...node,
      llm,
      moshi,
      livekit,
      gateway,
      healthy: Boolean(llm.ok && moshi.ok && livekit.ok),
      endpoints: {
        livekit: `ws://${node.host}:7880`,
        moshi: `ws://${node.host}:8998/api/chat`,
        llm: `http://${node.host}:30000/v1/chat/completions`,
        gateway: `http://${node.host}:9000`,
      },
    };
  }));

  return {
    protocol: 'voicelive',
    generated_at: new Date().toISOString(),
    active_gateway: GATEWAY,
    gateway_fallbacks: GATEWAYS,
    nodes,
    summary: {
      total: nodes.length,
      healthy: nodes.filter((node) => node.healthy).length,
      llm: nodes.filter((node) => node.llm.ok).length,
      moshi: nodes.filter((node) => node.moshi.ok).length,
      livekit: nodes.filter((node) => node.livekit.ok).length,
      gateway: nodes.filter((node) => node.gateway.ok).length,
    },
  };
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtServices(payload) {
  const items = payload.services || payload.items || [];
  const lines = items.map((s) => {
    const sym  = s.status === 'healthy' ? '✓' : s.status === 'degraded' ? '~' : '✗';
    const ms   = s.latency_ms != null ? ` ${s.latency_ms}ms` : '';
    const url  = (s.links || []).find(l => l.rel === 'base')?.href ?? '';
    const desc = s.description ? `\n    ${s.description}` : '';
    return `  ${sym} ${(s.name || s.id).padEnd(22)} [${s.status}]${ms}${url ? '  ' + url : ''}${desc}`;
  });
  const { status_breakdown: sb = {}, avg_latency_ms } = payload.metadata || {};
  const summary = Object.entries(sb).map(([k, v]) => `${v} ${k}`).join(', ');
  return `Services (${items.length}): ${summary}${avg_latency_ms ? `  avg ${avg_latency_ms}ms` : ''}\n\n${lines.join('\n')}`;
}

function fmtNodes(payload) {
  const items = payload.nodes || payload.items || [];
  return items.map((n) => {
    const sym = n.status === 'healthy' ? '✓' : n.status === 'degraded' ? '~' : '✗';
    const url = (n.links || []).find(l => l.rel === 'base')?.href ?? '';
    const meta = n.metadata || {};
    const reach = meta.dlmcp_reachable ? 'DLMCP reachable' : (meta.dlmcp_error ? `unreachable: ${meta.dlmcp_error}` : '');
    return `${sym} ${n.name} [${n.status}]${url ? '  ' + url : ''}\n  ${n.description || ''}\n  ${reach}`;
  }).join('\n\n');
}

function fmtProviders(payload) {
  const items = payload.providers || payload.items || [];
  return items.map((p) => {
    const sym = p.status === 'connected' || p.status === 'healthy' ? '✓' : '○';
    const models = (p.models || []).map(m => m.label || m.id).join(', ');
    return `${sym} ${p.name} [${p.kind}] — ${p.status}${models ? '\n  Models: ' + models : ''}${p.description ? '\n  ' + p.description : ''}`;
  }).join('\n\n');
}

function fmtTemplates(payload) {
  const items = payload.templates || payload.items || [];
  return items.map((t) => {
    const tools = (t.tool_bindings || []).map(b => b.name).join(', ');
    return `• ${t.name}\n  ${t.description || ''}\n  Tools: ${tools || 'none'}\n  Max tokens: ${t.max_tokens}  Temp: ${t.temperature}`;
  }).join('\n\n');
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'dlmcp_services',
    description: 'List all DarbotLM platform services with live health status, latency, and endpoints (Ollama, TXT2KG, portal, APIs, etc.)',
    inputSchema: {
      type: 'object',
      properties: {
        force_refresh: { type: 'boolean', description: 'Bypass cache and re-probe every service', default: false },
      },
    },
  },
  {
    name: 'dlmcp_nodes',
    description: 'List DarbotLM fleet nodes (anton/10.1.0.4, antonjr1/10.1.0.5, antonjr2/10.1.0.6) with federation and DLMCP reachability status.',
    inputSchema: {
      type: 'object',
      properties: {
        force_refresh: { type: 'boolean', default: false },
      },
    },
  },
  {
    name: 'dlmcp_providers',
    description: 'List AI model providers and AG2 connectors configured in DarbotLM (OpenAI, Azure, Ollama, local Nemotron, etc.)',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'dlmcp_templates',
    description: 'List GenAI orchestration templates (HTML delivery pipeline, service cartographer, etc.) with tool bindings and prompt snippets.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'moshi_health',
    description: 'Check health of the PersonaPlex / Moshi real-time voice AI service.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'moshi_info',
    description: 'Get PersonaPlex / Moshi voice AI full service metadata: model, device, capabilities, WebSocket endpoint format.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'moshi_voices',
    description: 'List available PersonaPlex voice prompts (.pt files). Returns voice names and instructions for use with /voice command.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'voicelive_status',
    description: 'Check end-to-end Anton VoiceLive health across LiveKit rooms, Moshi/PersonaPlex voice, Nemotron inference, and DarbotLM gateway endpoints.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ── Tool handlers ─────────────────────────────────────────────────────────────

const KNOWN_VOICES = [
  'NATF0','NATF1','NATF2','NATF3',
  'NATM0','NATM1','NATM2','NATM3',
  'VARF0','VARF1','VARF2','VARF3','VARF4',
  'VARM0','VARM1','VARM2','VARM3','VARM4',
];

async function callTool(name, args = {}) {
  const qs = args.force_refresh ? '?force_refresh=true' : '';
  switch (name) {
    case 'dlmcp_services': {
      const payload = await get(`/dlmcp/services${qs}`);
      return fmtServices(payload);
    }
    case 'dlmcp_nodes': {
      const payload = await get(`/dlmcp/nodes${qs}`);
      return fmtNodes(payload);
    }
    case 'dlmcp_providers': {
      const payload = await get('/dlmcp/providers');
      return `Providers & Connectors (${(payload.providers || payload.items || []).length}):\n\n${fmtProviders(payload)}`;
    }
    case 'dlmcp_templates': {
      const payload = await get('/dlmcp/templates');
      return `GenAI Templates (${(payload.templates || payload.items || []).length}):\n\n${fmtTemplates(payload)}`;
    }
    case 'moshi_health':
      return JSON.stringify(await get('/moshi/health'), null, 2);
    case 'moshi_info':
      return JSON.stringify(await get('/moshi/info'), null, 2);
    case 'moshi_voices': {
      const payload = await get('/moshi/voices');
      const fromGateway = (payload.voices || []).map(v => v.name);
      const list = fromGateway.length > 0 ? fromGateway : KNOWN_VOICES;
      const byType = {
        'Natural Female': list.filter(v => v.startsWith('NATF')),
        'Natural Male':   list.filter(v => v.startsWith('NATM')),
        'Varied Female':  list.filter(v => v.startsWith('VARF')),
        'Varied Male':    list.filter(v => v.startsWith('VARM')),
      };
      const lines = Object.entries(byType)
        .filter(([, vs]) => vs.length)
        .map(([g, vs]) => `  ${g}: ${vs.join(', ')}`);
      return [
        'PersonaPlex Voice Prompts:',
        ...lines,
        '',
        'Fleet nodes: anton (10.1.0.4)  antonjr1 (10.1.0.5)  antonjr2 (10.1.0.6)',
        'WebSocket:   ws://<node>:8998/api/chat?voice_prompt=<FILE>.pt&text_prompt=<PROMPT>',
        'In nemo:     /voice [node] [voice-key]   e.g. /voice antonjr1 natm0',
      ].join('\n');
    }
    case 'voicelive_status':
      return JSON.stringify(await getVoiceLiveStatus(), null, 2);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── MCP JSON-RPC stdio transport ──────────────────────────────────────────────

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }

  const { id, method, params } = msg;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'dlmcp-moshi', version: '1.0.0' },
      },
    });
    return;
  }

  if (method === 'notifications/initialized') return;

  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }

  if (method === 'tools/call') {
    const { name, arguments: toolArgs } = params || {};
    try {
      const text = await callTool(name, toolArgs || {});
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
    } catch (e) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true } });
    }
    return;
  }

  if (id != null) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
});

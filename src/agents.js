// Agent system — load and apply YAML agent definitions
import { readFileSync, existsSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import yaml from 'js-yaml';
import { DEFAULTS, extractRoutingOverrides, validateConfig } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = join(__dirname, '..', 'agents');

function normalizeAgentDefinition(data) {
  if (!data || !data.name) return null;
  return { ...data, ...extractRoutingOverrides(data) };
}

export class AgentSystem {
  constructor() {
    this.agents = new Map();
    this._loadBuiltinAgents();
  }

  _loadBuiltinAgents() {
    const dir = AGENTS_DIR;
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir).filter(f => f.endsWith('.yaml'))) {
      try {
        const data = normalizeAgentDefinition(yaml.load(readFileSync(join(dir, file), 'utf-8')));
        if (data && data.name) {
          this.agents.set(data.name, data);
        }
      } catch (err) {
        console.error('Failed to load agent:', join(dir, file), err.message);
      }
    }
  }

  loadCustomAgent(nameOrPath) {
    // Try loading from path first
    if (existsSync(nameOrPath)) {
      try {
        const data = normalizeAgentDefinition(yaml.load(readFileSync(nameOrPath, 'utf-8')));
        if (data && data.name) {
          this.agents.set(data.name, data);
          return data;
        }
      } catch {}
    }
    // Otherwise look up by name
    return this.agents.get(nameOrPath) || null;
  }

  getAgent(name) {
    return this.agents.get(name) || null;
  }

  listAgents() {
    return Array.from(this.agents.values()).map((a) => {
      const routing = extractRoutingOverrides(a);
      return {
        name: a.name,
        displayName: a.displayName || a.name,
        description: a.description || '',
        model: a.model || 'nemotron',
        baseUrl: a.baseUrl || null,
        backend: routing.backend ?? null,
        host: routing.host ?? null,
        room: routing.room ?? null,
        identity: routing.identity ?? null,
        sessionId: routing.sessionId ?? null,
        livekitUrl: routing.livekitUrl ?? null,
        livekitTokenStrategy: routing.livekitTokenStrategy ?? null,
      };
    });
  }

  // Apply agent to config — modifies system prompt, tool set, etc.
  applyAgent(agentName, config) {
    const agent = this.agents.get(agentName);
    if (!agent) return null;

    const applied = { ...config };
    const cwd = config.cwd || process.cwd();

    if (agent.prompt) {
      applied.systemPrompt = agent.prompt
        .replace(/\{\{cwd\}\}/g, cwd)
        .replace(/\{\{platform\}\}/g, process.platform);
    }

    if (agent.model) {
      applied.model = agent.model;
    }

    if (agent.baseUrl !== undefined) {
      applied.baseUrl = agent.baseUrl;
    }

    const routingOverrides = extractRoutingOverrides(agent);
    for (const [key, value] of Object.entries(routingOverrides)) {
      if (value !== undefined) applied[key] = value;
    }

    validateConfig(applied, { ...DEFAULTS, ...config });

    // Tool restrictions
    if (agent.tools && !agent.tools.includes('*')) {
      applied.availableTools = new Set(agent.tools);
    }

    applied.agentName = agent.name;
    applied.agentDisplayName = agent.displayName || agent.name;
    applied.cwd = cwd;

    return applied;
  }
}

// Cluster-aware dispatch for multi-node swarm orchestration
// Supports: round-robin, specific-node, load-balanced strategies
// Modes: remote-llm (remote GPU, local tools) and remote-agent (full SSH dispatch)
import { execFileSync, execSync } from 'child_process';
import { connect } from 'net';
import { NemotronClient } from './client.js';

const HEALTH_CACHE_TTL = 30_000; // 30s — re-check node health after this interval
const DEFAULT_VOICE_PORT = 8998;

const DEFAULT_NODES = [
  { name: 'anton',    host: '10.1.0.4', port: 30000, voicePort: DEFAULT_VOICE_PORT, user: 'darbot', role: 'orchestrator' },
  { name: 'antonjr1', host: '10.1.0.5', port: 30000, voicePort: DEFAULT_VOICE_PORT, user: 'darbot', role: 'orchestrator' },
  { name: 'antonjr2', host: '10.1.0.6', port: 30000, voicePort: DEFAULT_VOICE_PORT, user: 'darbot', role: 'orchestrator' },
];

export class ClusterManager {
  constructor(nodes, localName) {
    this.nodes = nodes || DEFAULT_NODES;
    this.localName = localName || this._detectLocal();
    this._rrIndex = 0;
    this._healthCache = new Map();
  }

  _detectLocal() {
    try {
      const hostname = execSync('hostname', { encoding: 'utf-8' }).trim();
      const node = this.nodes.find(n => n.name === hostname);
      return node ? node.name : this.nodes[0]?.name;
    } catch {
      return this.nodes[0]?.name;
    }
  }

  async checkNode(node) {
    const cached = this._healthCache.get(`${node.name}:llm`);
    if (cached && (Date.now() - cached.ts) < HEALTH_CACHE_TTL) {
      return cached.healthy;
    }
    try {
      const resp = await fetch(`http://${node.host}:${node.port}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      const data = await resp.json();
      const healthy = data.status === 'ok';
      this._healthCache.set(`${node.name}:llm`, { healthy, ts: Date.now() });
      return healthy;
    } catch {
      this._healthCache.set(`${node.name}:llm`, { healthy: false, ts: Date.now() });
      return false;
    }
  }

  async checkVoice(node) {
    const voicePort = node.voicePort || DEFAULT_VOICE_PORT;
    const cached = this._healthCache.get(`${node.name}:voice`);
    if (cached && (Date.now() - cached.ts) < HEALTH_CACHE_TTL) {
      return cached.healthy;
    }

    const healthy = await new Promise((resolve) => {
      const socket = connect({ host: node.host, port: voicePort });
      const finish = (result) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(result);
      };

      socket.setTimeout(3000);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
    });

    this._healthCache.set(`${node.name}:voice`, { healthy, ts: Date.now() });
    return healthy;
  }

  async healthCheckAll() {
    return Promise.all(
      this.nodes.map(async (n) => {
        const [healthy, voiceHealthy] = await Promise.all([
          this.checkNode(n),
          this.checkVoice(n),
        ]);
        return {
          ...n,
          voicePort: n.voicePort || DEFAULT_VOICE_PORT,
          healthy,
          voiceHealthy,
        };
      })
    );
  }

  async getHealthyRemotes() {
    const all = await this.healthCheckAll();
    return all.filter(n => n.name !== this.localName && n.healthy);
  }

  // Pick target node by strategy
  // strategy: 'local' | 'round-robin' | 'peers-only' | 'workers-only' (legacy alias)
  // preferredNode: pin to a specific node name (overrides strategy)
  async nextNode(strategy = 'round-robin', preferredNode = null) {
    if (preferredNode) {
      const node = this.nodes.find(n => n.name === preferredNode);
      if (node && await this.checkNode(node)) return node;
      // preferred down, fall through to strategy
    }

    if (strategy === 'local') {
      return this.nodes.find(n => n.name === this.localName) || this.nodes[0];
    }

    // For round-robin and peers-only, get eligible nodes.
    const candidates = strategy === 'peers-only' || strategy === 'workers-only'
      ? await this.getHealthyRemotes()
      : (await this.healthCheckAll()).filter(n => n.healthy);

    if (candidates.length === 0) {
      return this.nodes.find(n => n.name === this.localName) || this.nodes[0];
    }

    const node = candidates[this._rrIndex % candidates.length];
    // Modular increment keeps index bounded. Node.js single-thread
    // makes concurrent mutation low-risk, but this avoids unbounded growth.
    this._rrIndex = (this._rrIndex + 1) % candidates.length;
    return node;
  }

  // Create a NemotronClient pointed at a remote node's llama-server
  clientForNode(node) {
    return new NemotronClient({ baseUrl: `http://${node.host}:${node.port}` });
  }

  isLocal(node) {
    return node.name === this.localName;
  }

  _shellQuote(value) {
    let str = String(value ?? '');
    // Strip ASCII control characters (0x00-0x1F, 0x7F) — null bytes, newlines,
    // tabs, etc. — that can break quoting or enable injection across SSH/shell layers.
    str = str.replace(/[\x00-\x1f\x7f]/g, '');
    // Escape single quotes using the standard POSIX idiom:
    // close current quote, add backslash-escaped literal quote, reopen quote.
    return "'" + str.replace(/'/g, "'\\''") + "'";
  }

  _validateSshInput(value, fieldName) {
    if (value == null) return;
    const str = String(value);
    if (/\0/.test(str)) {
      throw new Error(`sshDispatch: ${fieldName} contains null bytes`);
    }
    // Reject inputs with excessive control characters (likely injection attempts)
    const controlCount = (str.match(/[\x01-\x1f\x7f]/g) || []).length;
    if (controlCount > 0 && controlCount / str.length > 0.1) {
      throw new Error(`sshDispatch: ${fieldName} contains suspicious control characters`);
    }
  }

  // Full remote dispatch: SSH to node, run nemo on the remote host using its own tools.
  // The remote nemo has its own tools, swarm system, and can sub-dispatch further.
  async sshDispatch(node, task, opts = {}) {
    this._validateSshInput(task, 'task');
    this._validateSshInput(opts.cwd, 'cwd');
    this._validateSshInput(opts.agent, 'agent');
    this._validateSshInput(opts.systemPrompt, 'systemPrompt');

    const timeout = opts.timeout || 120;
    const cwd = opts.cwd || '~';
    const quotedCwd = this._shellQuote(cwd);
    const args = [
      '--prompt',
      task,
      '--allow-all',
      '--output-format',
      'json',
      '--silent',
      '--no-color',
    ];

    if (opts.agent) {
      args.push('--agent', opts.agent);
    }
    if (opts.systemPrompt) {
      args.push('--system-prompt', opts.systemPrompt);
    }

    const renderedArgs = args.map((arg) => this._shellQuote(arg)).join(' ');
    const remoteCmd = `cd ${quotedCwd} && node "$HOME/nemo-cli/bin/nemo.js" ${renderedArgs}`;

    return new Promise((resolve) => {
      try {
        const output = execFileSync('ssh', [
          '-o', 'ConnectTimeout=10',
          '-o', 'StrictHostKeyChecking=no',
          `${node.user}@${node.host}`,
          remoteCmd,
        ], {
          encoding: 'utf-8',
          timeout: timeout * 1000,
          maxBuffer: 10 * 1024 * 1024,
        });
        try {
          const parsed = JSON.parse(output.trim().split('\n').pop());
          resolve({ output: parsed.content || output.trim(), exitCode: 0, node: node.name });
        } catch {
          resolve({ output: output.trim(), exitCode: 0, node: node.name });
        }
      } catch (err) {
        resolve({
          output: `SSH dispatch to ${node.name} (${node.host}) failed: ${err.message}`,
          exitCode: 1,
          node: node.name,
        });
      }
    });
  }

  async status() {
    const checks = await this.healthCheckAll();
    return {
      local: this.localName,
      nodes: checks.map(n => ({
        name: n.name,
        host: n.host,
        port: n.port,
        voicePort: n.voicePort,
        role: n.role,
        healthy: n.healthy,
        voiceHealthy: n.voiceHealthy,
        isLocal: n.name === this.localName,
      })),
      healthyRemotes: checks.filter(n => n.name !== this.localName && n.healthy).length,
      voiceHealthyRemotes: checks.filter(n => n.name !== this.localName && n.voiceHealthy).length,
      total: checks.length,
    };
  }
}

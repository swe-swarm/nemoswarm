// MCP Client — Model Context Protocol support
// Connects to MCP servers, discovers tools, and proxies tool calls
import { spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { EventEmitter } from 'events';

export class MCPClient extends EventEmitter {
  constructor() {
    super();
    this.servers = new Map(); // name -> { process, tools, config }
    this.allTools = new Map(); // canonicalKey -> { server, tool }
    this.toolAliases = new Map(); // exposedName -> { server, originalName, tool }
  }

  async loadConfig(configPaths = []) {
    const configs = [];

    const defaultPath = join(process.env.HOME || '', '.nemo-cli', 'mcp-config.json');
    if (existsSync(defaultPath)) {
      try { configs.push(JSON.parse(readFileSync(defaultPath, 'utf-8'))); } catch {}
    }

    for (const p of configPaths) {
      try {
        if (p.startsWith('{')) {
          configs.push(JSON.parse(p));
        } else if (p.startsWith('@')) {
          configs.push(JSON.parse(readFileSync(p.slice(1), 'utf-8')));
        } else if (existsSync(p)) {
          configs.push(JSON.parse(readFileSync(p, 'utf-8')));
        }
      } catch {}
    }

    for (const config of configs) {
      const servers = config.mcpServers || config.servers || config;
      for (const [name, spec] of Object.entries(servers)) {
        if (spec.command) {
          await this.startServer(name, spec);
        }
      }
    }
  }

  async startServer(name, spec) {
    const { command, args = [], env = {} } = spec;

    const proc = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const server = {
      process: proc,
      config: spec,
      tools: [],
      pending: new Map(),
      nextId: 1,
      buffer: '',
    };

    proc.on('error', (err) => {
      this.emit('log', `[MCP:${name}] Process error: ${err.message}`);
      for (const { reject } of server.pending.values()) {
        reject(new Error(`MCP server ${name} process error: ${err.message}`));
      }
      server.pending.clear();
      this.servers.delete(name);
      this._rebuildToolIndex();
    });

    proc.on('exit', (code, signal) => {
      if (code !== 0 && code !== null) {
        this.emit('log', `[MCP:${name}] Process crashed with code ${code}`);
      } else if (signal) {
        this.emit('log', `[MCP:${name}] Process killed by signal ${signal}`);
      }
      for (const { reject } of server.pending.values()) {
        reject(new Error(`MCP server ${name} exited unexpectedly (code=${code}, signal=${signal})`));
      }
      server.pending.clear();
    });

    proc.stdout.on('data', (data) => {
      server.buffer += data.toString();
      this._processBuffer(name, server);
    });

    proc.stderr.on('data', (data) => {
      this.emit('log', `[MCP:${name}] ${data.toString().trim()}`);
    });

    proc.on('close', (code) => {
      this.emit('log', `[MCP:${name}] Server exited with code ${code}`);
      this.servers.delete(name);
      this._rebuildToolIndex();
    });

    this.servers.set(name, server);

    await this._sendRequest(name, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'nemo-cli', version: '0.1.0' },
    });

    this._sendNotification(name, 'notifications/initialized', {});

    try {
      const result = await this._sendRequest(name, 'tools/list', {});
      if (!Array.isArray(result?.tools)) {
        this.emit('log', `[MCP:${name}] Invalid tools/list response: expected array`);
        server.tools = [];
      } else {
        server.tools = result.tools;
      }
      this._rebuildToolIndex();
      this.emit('log', `[MCP:${name}] Discovered ${server.tools.length} tools`);
    } catch (err) {
      this.emit('log', `[MCP:${name}] Tool discovery failed: ${err.message}`);
    }
  }

  _processBuffer(name, server) {
    const lines = server.buffer.split('\n');
    server.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && server.pending.has(msg.id)) {
          const { resolve, reject } = server.pending.get(msg.id);
          server.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || 'MCP error'));
          else resolve(msg.result);
        }
      } catch (err) {
        console.error('MCP: malformed message:', line, err.message);
      }
    }
  }

  _sendRequest(name, method, params) {
    const server = this.servers.get(name);
    if (!server) return Promise.reject(new Error(`MCP server ${name} not found`));

    const id = server.nextId++;
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';

    const timeout = server.config.timeout ?? 15_000;

    return new Promise((resolve, reject) => {
      server.pending.set(id, { resolve, reject });

      if (!server.process.stdin.writable) {
        server.pending.delete(id);
        reject(new Error(`MCP server ${name} stdin is not writable`));
        return;
      }

      server.process.stdin.write(msg, (err) => {
        if (err) {
          server.pending.delete(id);
          reject(new Error(`MCP server ${name} write error: ${err.message}`));
        }
      });

      setTimeout(() => {
        if (server.pending.has(id)) {
          server.pending.delete(id);
          reject(new Error(`MCP request timeout: ${method}`));
        }
      }, timeout);
    });
  }

  _sendNotification(name, method, params) {
    const server = this.servers.get(name);
    if (!server) return;
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    if (!server.process.stdin.writable) return;
    server.process.stdin.write(msg, (err) => {
      if (err) this.emit('log', `[MCP:${name}] Notification write error: ${err.message}`);
    });
  }

  _canonicalEntries() {
    const entries = [];
    for (const [server, data] of this.servers) {
      for (const tool of data.tools || []) {
        entries.push({ server, tool });
      }
    }
    return entries;
  }

  _publicToolName(server, toolName, nameCounts) {
    const isUnique = (nameCounts.get(toolName) ?? 0) <= 1;
    return isUnique
      ? toolName
      : `${server}_${toolName}`.replace(/[^a-zA-Z0-9_]/g, '_');
  }

  _rebuildToolIndex() {
    this.allTools.clear();
    this.toolAliases.clear();

    const entries = this._canonicalEntries();
    const nameCounts = new Map();

    for (const { server, tool } of entries) {
      const canonicalKey = `${server}(${tool.name})`;
      this.allTools.set(canonicalKey, { server, tool });
      nameCounts.set(tool.name, (nameCounts.get(tool.name) ?? 0) + 1);
    }

    for (const { server, tool } of entries) {
      const publicName = this._publicToolName(server, tool.name, nameCounts);
      const resolved = { server, originalName: tool.name, tool };

      this.toolAliases.set(publicName, resolved);

      if ((nameCounts.get(tool.name) ?? 0) <= 1) {
        this.toolAliases.set(tool.name, resolved);
      }
    }
  }

  // Get OpenAI-compatible tool definitions for all MCP tools
  getToolDefinitions() {
    const entries = [...this.allTools.values()];
    const nameCounts = new Map();

    for (const { tool } of entries) {
      nameCounts.set(tool.name, (nameCounts.get(tool.name) ?? 0) + 1);
    }

    return entries.map(({ server, tool }) => ({
      type: 'function',
      function: {
        name: this._publicToolName(server, tool.name, nameCounts),
        description: `[${server}] ${tool.description || tool.name}`,
        parameters: tool.inputSchema || { type: 'object', properties: {} },
      },
      _mcp: { server, originalName: tool.name },
    }));
  }

  resolveToolCall(name) {
    if (!name) return null;

    const normalized = String(name).replace(/[^a-zA-Z0-9_]/g, '_');
    if (this.toolAliases.has(name)) return this.toolAliases.get(name);
    if (this.toolAliases.has(normalized)) return this.toolAliases.get(normalized);
    return null;
  }

  // Execute an MCP tool
  async executeTool(serverName, toolName, args) {
    try {
      const result = await this._sendRequest(serverName, 'tools/call', {
        name: toolName,
        arguments: args,
      });
      const text = (result.content || [])
        .map(c => c.text || JSON.stringify(c))
        .join('\n');
      return { output: text };
    } catch (err) {
      return { error: `MCP tool error: ${err.message}` };
    }
  }

  async close() {
    for (const [, server] of this.servers) {
      try {
        server.process.stdin.end();
        server.process.kill('SIGTERM');
      } catch {}
    }
    this.servers.clear();
    this.allTools.clear();
    this.toolAliases.clear();
  }
}

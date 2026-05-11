// Swarm system -- multi-agent orchestration with cluster dispatch
// Pattern: coordinator agent delegates tasks to specialized sub-agents via delegate() tool.
// Sub-agents can run locally or on remote cluster nodes (remote-llm or remote-agent mode).
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import chalk from 'chalk';
import yaml from 'js-yaml';
import { Agent } from './agent.js';
import { Session } from './session.js';
import { SessionStore } from './store.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR = join(__dir, '..', 'swarms');
const USER_DIR = join(process.env.HOME || '', '.nemo-cli', 'swarms');

// -- SwarmSystem -- loads YAML swarm definitions --------------------------------
export class SwarmSystem {
  constructor() {
    this.swarms = new Map();
    this._load(BUILTIN_DIR);
    this._load(USER_DIR);
  }

  _load(dir) {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))) {
      try {
        const d = yaml.load(readFileSync(join(dir, f), 'utf-8'));
        if (d?.name) this.swarms.set(d.name, d);
      } catch (err) {
        console.error('Failed to load swarm:', join(dir, f), err.message);
      }
    }
  }

  has(name) { return this.swarms.has(name); }
  get(name) { return this.swarms.get(name) || null; }
  list() { return [...this.swarms.values()]; }
}

// -- SwarmRunner -- orchestrates a swarm run with optional cluster dispatch ------
export class SwarmRunner {
  constructor(client, baseConfig, agentSystem, permissions, mcpClient, cluster, opts = {}) {
    this.client = client;
    this.baseConfig = baseConfig;
    this.agentSystem = agentSystem;
    this.permissions = permissions;
    this.mcpClient = mcpClient;
    this.cluster = cluster || null; // ClusterManager instance
    this.sessionStore = opts.sessionStore || new SessionStore();
    this.contextWindow = opts.contextWindow || 24;
  }

  async run(swarmDef, task, ui, opts = {}) {
    const roles = {};
    for (const a of swarmDef.agents || []) {
      roles[a.role] = a;
    }

    const rootSession = opts.rootSession || null;
    const workingCwd = rootSession?.cwd || this.baseConfig.cwd || process.cwd();
    const swarmId = opts.swarmId || randomUUID();
    const clusterConfig = swarmDef.cluster || {};
    const globalStrategy = clusterConfig.strategy || 'round-robin';
    const globalDispatch = clusterConfig.dispatch || 'remote-llm';
    const clusterEnabled = this.cluster && globalStrategy !== 'local';

    // Warn if swarm timeout is shorter than any individual agent timeout
    const swarmTimeout = swarmDef.timeout || clusterConfig.timeout || null;
    if (swarmTimeout != null) {
      const maxAgentTimeout = Math.max(
        ...(swarmDef.agents || []).map(a => a.timeout || 0),
      );
      if (maxAgentTimeout > 0 && swarmTimeout < maxAgentTimeout) {
        console.error(
          `Warning: swarm timeout (${swarmTimeout}s) is less than max agent timeout (${maxAgentTimeout}s) — agents may be killed prematurely`,
        );
      }
    }

    ui.swarmHeader(
      swarmDef.displayName || swarmDef.name,
      swarmDef.description || '',
      Object.keys(roles),
    );

    if (clusterEnabled) {
      const status = await this.cluster.status();
      const healthy = status.nodes.filter(n => n.healthy).map(n =>
        `${n.name}${n.isLocal ? '*' : ''}`
      );
      console.log(chalk.dim(`  Cluster: ${healthy.join(', ')} (${status.healthyRemotes} remote) | strategy: ${globalStrategy}\n`));
    }

    const coordPrompt = this._buildCoordPrompt(swarmDef, roles, clusterEnabled, workingCwd);
    const coordConfig = { ...this.baseConfig, cwd: workingCwd, systemPrompt: coordPrompt };
    const coordSession = this._buildSession(
      rootSession,
      coordPrompt,
      coordConfig.maxHistory,
      this.contextWindow,
      { cwd: workingCwd },
    );

    // -- delegate() tool definition --
    const delegateTool = {
      type: 'function',
      function: {
        name: 'delegate',
        description: [
          'Spawn a specialized sub-agent to complete a specific task.',
          'The sub-agent runs with full tool access and returns its complete response.',
          clusterEnabled
            ? 'Sub-agents may execute on remote cluster nodes for distributed compute.'
            : '',
          `Available roles: ${Object.keys(roles).join(', ')}.`,
        ].filter(Boolean).join(' '),
        parameters: {
          type: 'object',
          properties: {
            role: {
              type: 'string',
              enum: Object.keys(roles),
              description: 'The sub-agent role to assign this task to',
            },
            task: {
              type: 'string',
              description: 'Full, detailed task description for the sub-agent. Be specific.',
            },
          },
          required: ['role', 'task'],
        },
      },
      _swarm: true,
    };

    // -- Sub-agent executor with cluster dispatch --
    let delegateIdx = 0;
    const swarmExecutor = async (_toolName, args) => {
      const { role, task: subTask } = args;
      const roleDef = roles[role];
      if (!roleDef) {
        return {
          output: `Unknown role: "${role}". Available: ${Object.keys(roles).join(', ')}`,
          exitCode: 1,
        };
      }

      delegateIdx++;

      let targetNode = null;
      let dispatchMode = 'local';

      if (clusterEnabled) {
        const roleStrategy = roleDef.strategy || globalStrategy;
        const roleDispatch = roleDef.dispatch || globalDispatch;
        const preferredNode = roleDef.node || null;

        targetNode = await this.cluster.nextNode(roleStrategy, preferredNode);

        if (!this.cluster.isLocal(targetNode)) {
          dispatchMode = roleDispatch;
        }
      }

      const nodeLabel = targetNode && !this.cluster?.isLocal(targetNode)
        ? ` [${targetNode.name}]`
        : '';

      ui.subAgentHeader(
        role,
        `${roleDef.displayName || role}${nodeLabel}`,
        delegateIdx,
        Object.keys(roles).length,
      );

      let subConfig = { ...this.baseConfig, cwd: coordSession.cwd || workingCwd };
      if (roleDef.agent && this.agentSystem) {
        const applied = this.agentSystem.applyAgent(roleDef.agent, subConfig);
        if (applied) subConfig = { ...subConfig, ...applied };
      }
      if (roleDef.prompt) {
        subConfig.systemPrompt = roleDef.prompt
          .replace(/\{\{cwd\}\}/g, subConfig.cwd || workingCwd)
          .replace(/\{\{platform\}\}/g, process.platform);
      }

      const subSystemPrompt = this._buildSubAgentPrompt({
        basePrompt: subConfig.systemPrompt,
        swarmDef,
        role,
        roleDef,
        task,
        subTask,
        dispatchMode,
        targetNode,
        delegateIdx,
      });
      subConfig.systemPrompt = subSystemPrompt;

      const subPerms = roleDef.tools
        ? new AutoPermissions(new Set(roleDef.tools))
        : new AutoPermissions(null);

      // -- MODE: remote-agent (full SSH dispatch) --
      if (dispatchMode === 'remote-agent' && targetNode) {
        const remoteTimeout = roleDef.timeout || clusterConfig.timeout || 180;
        const shadowSession = this._buildSession(
          coordSession,
          subSystemPrompt,
          subConfig.maxHistory,
          this.contextWindow,
          { cwd: subConfig.cwd || coordSession.cwd || workingCwd },
        );

        shadowSession.addUser(subTask);

        const result = await this.cluster.sshDispatch(targetNode, subTask, {
          cwd: shadowSession.cwd || subConfig.cwd || workingCwd,
          timeout: remoteTimeout,
          agent: roleDef.agent || null,
          systemPrompt: roleDef.prompt ? subConfig.systemPrompt : null,
        });

        shadowSession.addAssistant(result?.output || result?.error || '(sub-agent returned no output)');
        this._persistSession(shadowSession, {
          kind: 'swarm-agent',
          swarmId,
          swarmName: swarmDef.name,
          role,
          node: targetNode.name,
          dispatchMode,
          model: subConfig.model,
        });

        ui.subAgentFooter(role, targetNode.name);
        return result;
      }

      // -- MODE: remote-llm (remote GPU, local tools) or local --
      const client = (dispatchMode === 'remote-llm' && targetNode)
        ? this.cluster.clientForNode(targetNode)
        : this.client;

      const subSession = this._buildSession(
        coordSession,
        subSystemPrompt,
        subConfig.maxHistory,
        this.contextWindow,
        { cwd: subConfig.cwd || coordSession.cwd || workingCwd },
      );

      const subUI = new SubAgentUI(ui, role, targetNode?.name);

      const subAgent = new Agent(client, subSession, subUI, subConfig, {
        permissions: subPerms,
        mcpClient: this.mcpClient,
        stream: true,
        silent: false,
      });

      let result;
      try {
        result = await subAgent.run(subTask);
      } catch (err) {
        result = `Sub-agent error: ${err.message}`;
      }

      this._persistSession(subSession, {
        kind: 'swarm-agent',
        swarmId,
        swarmName: swarmDef.name,
        role,
        node: targetNode?.name || 'local',
        dispatchMode,
        model: subConfig.model,
      });

      ui.subAgentFooter(role, targetNode?.name);
      return { output: result || '(sub-agent returned no output)', exitCode: 0, node: targetNode?.name };
    };

    if (Array.isArray(swarmDef.workflow) && swarmDef.workflow.length > 0) {
      return this._runWorkflow({
        swarmDef,
        task,
        ui,
        coordSession,
        coordConfig,
        swarmId,
        swarmExecutor,
        clusterEnabled,
        globalDispatch,
      });
    }

    const coordPermissions = Array.isArray(swarmDef.coordinator_tools)
      ? new AutoPermissions(new Set(swarmDef.coordinator_tools))
      : this.permissions;

    const coordAgent = new Agent(this.client, coordSession, ui, coordConfig, {
      permissions: coordPermissions,
      mcpClient: this.mcpClient,
      stream: true,
      silent: false,
      swarmExecutor,
    });

    const origGetTools = coordAgent.getToolDefinitions.bind(coordAgent);
    coordAgent.getToolDefinitions = () => [delegateTool, ...origGetTools()];

    let result;
    try {
      result = await coordAgent.run(task);
    } finally {
      this._persistSession(coordSession, {
        kind: 'swarm-coordinator',
        swarmId,
        swarmName: swarmDef.name,
        node: 'local',
        dispatchMode: clusterEnabled ? globalDispatch : 'local',
        model: coordConfig.model,
      });
    }

    return result;
  }

  _buildSession(sourceSession, systemPrompt, maxHistory, tailCount, options = {}) {
    const cwd = options.cwd || sourceSession?.cwd || this.baseConfig.cwd || process.cwd();
    const sharedMemory = options.sharedMemory !== undefined
      ? options.sharedMemory
      : (this.sessionStore?.buildMemoryContext({
        cwd,
        limit: 10,
        excludeIds: options.excludeIds || [],
      }) || sourceSession?.sharedMemory || '');

    if (sourceSession?.fork) {
      return sourceSession.fork({
        systemPrompt,
        sharedMemory,
        cwd,
        maxHistory: maxHistory || sourceSession.maxHistory,
        tailCount,
        includeMessages: true,
      });
    }

    const session = new Session({
      ...this.baseConfig,
      maxHistory,
      cwd,
      systemPrompt,
      sharedMemory,
    });
    session.setSystem(systemPrompt);
    if (sharedMemory) {
      session.setSharedMemory(sharedMemory);
    }
    return session;
  }

  _persistSession(session, metadata) {
    if (!this.sessionStore?.save) return null;
    try {
      return this.sessionStore.save(session, metadata);
    } catch {
      return null;
    }
  }

  async _runWorkflow({
    swarmDef,
    task,
    coordSession,
    coordConfig,
    swarmId,
    swarmExecutor,
    clusterEnabled,
    globalDispatch,
  }) {
    const outputs = {};
    coordSession.addUser(task);

    try {
      for (const step of swarmDef.workflow) {
        const renderedTask = this._renderTemplate(step.task || '', {
          task,
          cwd: coordSession.cwd || this.baseConfig.cwd || process.cwd(),
          platform: process.platform,
          ...outputs,
        });

        const result = await swarmExecutor('delegate', {
          role: step.role,
          task: renderedTask,
        });

        const output = result?.output || result?.error || '(sub-agent returned no output)';
        outputs[step.role] = {
          output,
          node: result?.node || 'local',
        };
        coordSession.addAssistant(`[${step.role}] ${output}`);
      }

      const finalRole = swarmDef.workflow[swarmDef.workflow.length - 1]?.role;
      return outputs[finalRole]?.output || '';
    } finally {
      this._persistSession(coordSession, {
        kind: 'swarm-coordinator',
        swarmId,
        swarmName: swarmDef.name,
        node: 'local',
        dispatchMode: clusterEnabled ? globalDispatch : 'local',
        model: coordConfig.model,
      });
    }
  }

  _buildSubAgentPrompt({ basePrompt, swarmDef, role, roleDef, task, subTask, dispatchMode, targetNode, delegateIdx }) {
    const parts = [
      basePrompt || this.baseConfig.systemPrompt,
      this._buildSwarmContextBlock({
        swarmDef,
        role,
        roleDef,
        task,
        subTask,
        dispatchMode,
        targetNode,
        delegateIdx,
      }),
    ].filter(Boolean);

    return parts.join('\n\n');
  }

  _renderTemplate(template, context) {
    return String(template || '').replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, expr) => {
      const path = expr.trim().split('.');
      let value = context;
      for (const key of path) {
        value = value?.[key];
      }
      return value == null ? '' : String(value);
    });
  }

  _buildSwarmContextBlock({ swarmDef, role, roleDef, task, subTask, dispatchMode, targetNode, delegateIdx }) {
    const lines = [
      'Swarm execution context:',
      `Swarm: ${swarmDef.displayName || swarmDef.name}`,
      `Role: ${role}`,
      `Role description: ${roleDef.description || role}`,
      `Delegate index: ${delegateIdx}`,
      `Dispatch mode: ${dispatchMode}`,
      `Target node: ${targetNode?.name || 'local'}`,
      '',
      'Top-level swarm task:',
      task,
      '',
      'Assigned sub-task:',
      subTask,
      '',
      'Use the inherited conversation context from the coordinator when relevant.',
    ];

    return lines.join('\n');
  }

  _buildCoordPrompt(swarmDef, roles, clusterEnabled, cwd) {
    const roleList = Object.entries(roles)
      .map(([role, def]) => {
        const nodeHint = def.node ? ` (pinned: ${def.node})` : '';
        return `  - ${role}: ${def.description || role}${nodeHint}`;
      })
      .join('\n');

    const clusterNote = clusterEnabled
      ? '\nSub-agents are distributed across the cluster automatically. Each delegate() call may run on a different node.'
      : '';

    const base = swarmDef.coordinator_prompt || `\
You are a swarm coordinator. Orchestrate specialized sub-agents to complete the task.

Process:
1. Analyze the task and decide which sub-agents are needed
2. Call delegate() for each relevant sub-agent with a precise, detailed task
3. After all delegations complete, synthesize a concise final response

Delegate work to specialists -- do not do their jobs yourself.`;

    return `${base}
${clusterNote}
Working directory: ${cwd || this.baseConfig.cwd || process.cwd()}
Platform: ${process.platform}

Available sub-agents:
${roleList}

Use delegate() to spawn sub-agents. Each call blocks until the sub-agent completes and returns its full response.`;
  }
}

// -- AutoPermissions -- always allows, filters by tool list ----------------------
class AutoPermissions {
  constructor(allowedTools) {
    this.availableTools = allowedTools;
  }
  isExcluded(name) { return this.availableTools ? !this.availableTools.has(name) : false; }
  isDenied() { return false; }
  isAllowed() { return true; }
  async checkPermission() { return { allowed: true }; }
  filterTools(tools) {
    if (!this.availableTools) return tools;
    return tools.filter(t => {
      const n = t.function?.name || t.name;
      return this.availableTools.has(n);
    });
  }
}

// -- SubAgentUI -- proxied UI for sub-agents ------------------------------------
class SubAgentUI {
  constructor(mainUI, role, nodeName) {
    this.mainUI = mainUI;
    this.role = role;
    this.nodeName = nodeName || null;
  }

  startSpinner() {}
  stopSpinner() {}
  startThinking() {}
  streamThinkToken() {}
  stopThinking() {}

  streamToken(token) {
    process.stdout.write(chalk.white(token));
  }

  toolStart(name, args) {
    const a = typeof args === 'string' ? args : JSON.stringify(args);
    const preview = a.length > 100 ? a.slice(0, 100) + '...' : a;
    const node = this.nodeName ? chalk.dim(` @${this.nodeName}`) : '';
    console.log(chalk.dim(`    ${chalk.yellow(name)} ${preview}${node}`));
  }

  toolResult(name, result) {
    if (result.error) {
      console.log(chalk.dim(`    ${chalk.red('X')} ${name}: ${result.error.slice(0, 150)}`));
    } else {
      const lines = (result.output || '').split('\n').length;
      console.log(chalk.dim(`    ${chalk.green('OK')} ${name} (${lines} lines)`));
    }
  }

  printError(msg) { console.log(chalk.red(`    X [${this.role}] ${msg}`)); }
  printInfo() {}
  printWarning(msg) { console.log(chalk.yellow(`    WARN [${this.role}] ${msg}`)); }
}

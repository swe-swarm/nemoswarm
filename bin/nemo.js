#!/usr/bin/env node
// Nemo CLI — Nemotron-powered terminal agent
// Mirrors GitHub Copilot CLI flags, powered by local Nemotron
import { NemotronClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { Session } from '../src/session.js';
import { TerminalUI } from '../src/ui/renderer.js';
import { Agent } from '../src/agent.js';
import { isCommand, executeCommand, COMMAND_DESCS, VOICE_COMMAND_DESCS } from '../src/commands.js';
import { ToolPermissions } from '../src/permissions.js';
import { MCPClient } from '../src/mcp.js';
import { SessionStore, restoreSession, refreshSessionMemory } from '../src/store.js';
import { AgentSystem } from '../src/agents.js';
import { SkillSystem } from '../src/skills.js';
import { SwarmSystem, SwarmRunner } from '../src/swarm.js';
import { ClusterManager } from '../src/cluster.js';
import chalk from 'chalk';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const VERSION = '0.1.0';

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    allowedTools: [],
    deniedTools: [],
    excludedTools: [],
    availableTools: [],
    allowedUrls: [],
    deniedUrls: [],
    addDirs: [],
    mcpConfigs: [],
    disabledMcpServers: [],
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      // === Server / Model ===
      case '--port': case '-p':
        if (args[i + 1] && !args[i + 1].startsWith('-')) {
          opts.baseUrl = `http://127.0.0.1:${args[++i]}`;
        }
        break;
      case '--url': case '-u':
        opts.baseUrl = args[++i];
        break;
      case '--model':
        opts.model = args[++i];
        break;

      // === Permissions ===
      case '--allow-all':
        opts.allowAllTools = true;
        opts.allowAllPaths = true;
        opts.allowAllUrls = true;
        break;
      case '--yolo':
        opts.allowAllTools = true;
        opts.allowAllPaths = true;
        opts.allowAllUrls = true;
        break;
      case '--allow-all-tools':
        opts.allowAllTools = true;
        break;
      case '--allow-all-paths':
        opts.allowAllPaths = true;
        break;
      case '--allow-all-urls':
        opts.allowAllUrls = true;
        break;
      case '--allow-tool':
        while (args[i + 1] && !args[i + 1].startsWith('-')) {
          opts.allowedTools.push(args[++i]);
        }
        break;
      case '--deny-tool':
        while (args[i + 1] && !args[i + 1].startsWith('-')) {
          opts.deniedTools.push(args[++i]);
        }
        break;
      case '--excluded-tools':
        while (args[i + 1] && !args[i + 1].startsWith('-')) {
          opts.excludedTools.push(args[++i]);
        }
        break;
      case '--available-tools':
        while (args[i + 1] && !args[i + 1].startsWith('-')) {
          opts.availableTools.push(args[++i]);
        }
        break;

      // === Directory Access ===
      case '--add-dir':
        opts.addDirs.push(args[++i]);
        break;
      case '--disallow-temp-dir':
        opts.disallowTempDir = true;
        break;

      // === Session ===
      case '--continue': case '-c':
        opts.continueSession = true;
        break;
      case '--resume': case '-r':
        opts.resumeSession = args[i + 1] && !args[i + 1].startsWith('-') ? args[++i] : true;
        break;

      // === Prompt / Output ===
      case '--prompt':
        opts.prompt = args[++i];
        break;
      case '-i': case '--interactive':
        opts.interactivePrompt = args[++i];
        break;
      case '-s': case '--silent':
        opts.silent = true;
        break;
      case '--stream':
        opts.stream = args[++i] === 'on';
        break;
      case '--no-color':
        opts.noColor = true;
        break;
      case '--output-format':
        opts.outputFormat = args[++i];
        break;

      // === Agent ===
      case '--agent':
        opts.agent = args[++i];
        break;
      case '--system-prompt':
        opts.systemPrompt = args[++i];
        break;
      case '--no-custom-instructions':
        opts.noCustomInstructions = true;
        break;

      // === MCP ===
      case '--mcp-config': case '--additional-mcp-config':
        opts.mcpConfigs.push(args[++i]);
        break;
      case '--disable-builtin-mcps':
        opts.disableBuiltinMcps = true;
        break;
      case '--disable-mcp-server':
        opts.disabledMcpServers.push(args[++i]);
        break;

      // === URLs ===
      case '--allow-url':
        while (args[i + 1] && !args[i + 1].startsWith('-')) {
          opts.allowedUrls.push(args[++i]);
        }
        break;
      case '--deny-url':
        while (args[i + 1] && !args[i + 1].startsWith('-')) {
          opts.deniedUrls.push(args[++i]);
        }
        break;

      // === Display ===
      case '--banner':
        opts.showBanner = true;
        break;
      case '--alt-screen':
        opts.altScreen = args[i + 1] === 'on' ? (i++, true) : true;
        break;
      case '--no-alt-screen':
        opts.altScreen = false;
        break;
      case '--screen-reader':
        opts.screenReader = true;
        break;
      case '--plain-diff':
        opts.plainDiff = true;
        break;

      // === Logging ===
      case '--log-level':
        opts.logLevel = args[++i];
        break;
      case '--log-dir':
        opts.logDir = args[++i];
        break;

      // === Misc ===
      case '--experimental':
        opts.experimental = true;
        break;
      case '--no-experimental':
        opts.experimental = false;
        break;
      case '--no-ask-user':
        opts.noAskUser = true;
        break;
      case '--autopilot':
        opts.autopilot = true;
        break;
      case '--max-autopilot-continues':
        opts.maxAutopilotContinues = parseInt(args[++i]);
        break;
      case '--disable-parallel-tools-execution':
        opts.disableParallelTools = true;
        break;
      case '--config-dir':
        opts.configDir = args[++i];
        break;
      case '--temp': case '-t':
        opts.temperature = parseFloat(args[++i]);
        break;
      case '--tokens':
        opts.maxTokens = parseInt(args[++i]);
        break;

      // === Listing ===
      case '--list':
        if (args[i + 1] && !args[i + 1].startsWith('-')) {
          opts.list = args[++i];
        }
        break;

      // === Version / Help ===
      case '-v': case '--version':
        console.log(`nemo v${VERSION}`);
        process.exit(0);
      case '-h': case '--help':
        printHelp();
        process.exit(0);

      // === Subcommands ===
      default:
        if (args[i] === 'help') {
          const topic = args[i + 1];
          printHelp(topic);
          process.exit(0);
        } else if (args[i] === 'version') {
          console.log(`nemo v${VERSION}`);
          process.exit(0);
        } else if (!args[i].startsWith('-')) {
          // Treat remaining as one-shot prompt
          opts.prompt = args.slice(i).join(' ');
          i = args.length;
        }
    }
  }
  return opts;
}

function printHelp(topic) {
  if (topic === 'config') {
    console.log(`
${chalk.bold('Configuration Settings')}

  Config file: ~/.nemo-cli/config.yaml

  ${chalk.dim('baseUrl:')}         Nemotron server URL (default: http://127.0.0.1:30000)
  ${chalk.dim('model:')}           Model name (default: nemotron)
  ${chalk.dim('maxTokens:')}       Max output tokens (default: 4096)
  ${chalk.dim('temperature:')}     Sampling temperature (default: 0.7)
  ${chalk.dim('maxHistory:')}      Max conversation messages to keep (default: 100)
  ${chalk.dim('systemPrompt:')}    Custom system prompt
`);
    return;
  }
  if (topic === 'commands') {
    console.log(`
${chalk.bold('Interactive Mode Commands')}

  ${chalk.cyan('/help')}             Show available commands
  ${chalk.cyan('/status')}           Server and session status
  ${chalk.cyan('/clear')}            Clear conversation history
  ${chalk.cyan('/compact')}          Summarize and shrink history
  ${chalk.cyan('/model [name]')}     Show or change model
  ${chalk.cyan('/temp <value>')}     Set temperature
  ${chalk.cyan('/tokens <value>')}   Set max output tokens
  ${chalk.cyan('/exit')}             Quit
`);
    return;
  }
  if (topic === 'permissions') {
    console.log(`
${chalk.bold('Permissions')}

  By default, nemo prompts before executing tools.

  ${chalk.dim('--allow-all')}              Enable all permissions
  ${chalk.dim('--allow-all-tools')}        Auto-approve all tools
  ${chalk.dim('--allow-tool <tools>')}     Auto-approve specific tools
  ${chalk.dim('--deny-tool <tools>')}      Block specific tools
  ${chalk.dim('--excluded-tools <tools>')} Remove tools from model entirely

  ${chalk.bold('Examples:')}
  nemo --allow-tool bash view grep    # Allow read + shell
  nemo --deny-tool edit create         # Block writes
  nemo --allow-all                     # YOLO mode
`);
    return;
  }

  console.log(getHelpText());
}

function getHelpText() {
  return `
${chalk.bold.green('Usage:')} nemo [options] [command]

${chalk.bold('Nemo CLI')} — Nemotron-powered terminal agent (v${VERSION})
Running 100% locally on your Nemotron server.

${chalk.bold('Options:')}
  ${chalk.dim('Server:')}
    --port <port>                    Nemotron server port (default: 30000)
    --url <url>                      Full server URL
    --model <model>                  Model name (default: nemotron)
    --temp <float>                   Temperature 0-2 (default: 0.7)
    --tokens <int>                   Max output tokens (default: 4096)

  ${chalk.dim('Permissions:')}
    --allow-all                      Enable all permissions (--yolo)
    --allow-all-tools                Allow all tools without confirmation
    --allow-all-paths                Allow access to any file path
    --allow-all-urls                 Allow access to all URLs
    --allow-tool [tools...]          Auto-approve specific tools
    --deny-tool [tools...]           Block specific tools
    --excluded-tools [tools...]      Hide tools from model entirely
    --available-tools [tools...]     Only these tools are available

  ${chalk.dim('Session:')}
    -c, --continue                   Resume most recent session
    -r, --resume [sessionId]         Resume a previous session
    -i, --interactive <prompt>       Start interactive mode with initial prompt
    --prompt <text>                  Execute prompt non-interactively (exits after)

  ${chalk.dim('Output:')}
    -s, --silent                     Output only agent response (for scripting)
    --stream <mode>                  Enable/disable streaming (on|off)
    --output-format <format>         Output format: text, json, stream-json
    --no-color                       Disable color output
    --banner                         Show startup banner

  ${chalk.dim('Agent:')}
    --agent <agent>                  Use a specific agent (explore, task, code-review, plan)
    --system-prompt <prompt>         Override system prompt
    --no-custom-instructions         Disable loading AGENTS.md

  ${chalk.dim('MCP:')}
    --mcp-config <json|path>         Load MCP servers from config (repeatable)
    --additional-mcp-config <json>   Additional MCP config (augments default)
    --disable-builtin-mcps           Disable built-in MCP servers
    --disable-mcp-server <name>      Disable a specific MCP server

  ${chalk.dim('Directories:')}
    --add-dir <directory>            Add directory to allowed list (repeatable)
    --disallow-temp-dir              Prevent temp directory access

  ${chalk.dim('Advanced:')}
    --autopilot                      Enable autopilot continuation
    --max-autopilot-continues <n>    Max autopilot continuations
    --no-ask-user                    Disable interactive questions
    --disable-parallel-tools-execution  Run tools sequentially
    --experimental                   Enable experimental features
    --config-dir <dir>               Set config directory
    --log-level <level>              Log level: none, error, info, debug
    --log-dir <dir>                  Log directory
    --share [path]                   Export session to markdown
    --share-gist                     Export session to gist
    --screen-reader                  Screen reader optimizations
    --plain-diff                     Disable rich diff rendering
    --alt-screen [on|off]            Alternate screen buffer

  ${chalk.dim('Listing:')}
    --list <type>                    List agents, skills, or swarms and exit

  ${chalk.dim('Info:')}
    -v, --version                    Show version
    -h, --help                       Show this help

${chalk.bold('Commands:')}
  help [topic]                       Display help (topics: config, commands, permissions)
  version                            Show version info

${chalk.bold('Examples:')}
  ${chalk.dim('# Start interactive mode')}
  $ nemo

  ${chalk.dim('# Execute a prompt non-interactively')}
  $ nemo --prompt "Fix the bug in main.js" --allow-all-tools

  ${chalk.dim('# YOLO mode')}
  $ nemo --yolo --prompt "Refactor the auth module"

  ${chalk.dim('# Start with a specific agent')}
  $ nemo --agent code-review

  ${chalk.dim('# Resume most recent session')}
  $ nemo --continue

  ${chalk.dim('# Resume a specific session')}
  $ nemo --resume <session-id>

  ${chalk.dim('# Interactive mode with initial prompt')}
  $ nemo -i "Explain this codebase"

  ${chalk.dim('# Allow specific tools only')}
  $ nemo --allow-tool bash view grep --deny-tool edit create

  ${chalk.dim('# With MCP servers')}
  $ nemo --mcp-config ./mcp-servers.json

  ${chalk.dim('# Silent mode for scripting')}
  $ nemo -s --prompt "What port is the server on?" --allow-all

  ${chalk.dim('# JSON output format')}
  $ nemo --output-format json --prompt "List all TODO items"
`;
}

function setupPermissions(cliOpts, { isNonInteractive }) {
  return new ToolPermissions({
    allowAll: cliOpts.allowAllTools,
    allowedTools: cliOpts.allowedTools,
    deniedTools: cliOpts.deniedTools,
    excludedTools: cliOpts.excludedTools,
    availableTools: cliOpts.availableTools.length > 0 ? new Set(cliOpts.availableTools) : null,
    interactive: !isNonInteractive,
  });
}

function handleListCommand(listType, { agentSystem, skillSystem, swarmSystem }) {
  const type = listType.toLowerCase();
  if (type === 'agents') {
    const agents = agentSystem.listAgents();
    console.log(chalk.bold('\n  Agents:\n'));
    for (const a of agents) {
      const desc = (a.description || '').trim().split('\n')[0];
      console.log(`  ${a.name.padEnd(20)} ${chalk.dim(desc)}`);
    }
    console.log('');
  } else if (type === 'skills') {
    const skills = skillSystem.list();
    console.log(chalk.bold('\n  Skills:\n'));
    for (const s of skills) {
      const desc = (s.description || '').trim().split('\n')[0];
      console.log(`  ${s.name.padEnd(20)} ${chalk.dim(desc)}`);
    }
    console.log('');
  } else if (type === 'swarms') {
    const swarms = swarmSystem.list();
    console.log(chalk.bold('\n  Swarms:\n'));
    for (const s of swarms) {
      const desc = (s.description || '').trim().split('\n')[0];
      console.log(`  ${s.name.padEnd(20)} ${chalk.dim(desc)}`);
    }
    console.log('');
  } else {
    console.error(chalk.red(`Unknown list type: ${listType}`));
    console.error(chalk.dim('Available: agents, skills, swarms'));
    process.exit(1);
  }
  process.exit(0);
}

function initSession({ cliOpts, config, session, store, sessionState, ui }) {
  // Session restore
  if (cliOpts.continueSession) {
    const recent = store.getMostRecent(config.cwd || process.cwd());
    if (recent) {
      restoreSession(session, recent);
      sessionState.id = recent.id;
      config.cwd = session.cwd || config.cwd;
      if (!cliOpts.silent) ui.printInfo(`Resumed session ${recent.id.slice(0, 8)}... (${recent.turnCount} turns)`);
    } else {
      if (!cliOpts.silent) ui.printInfo('No previous session found. Starting fresh.');
    }
  } else if (cliOpts.resumeSession) {
    const id = typeof cliOpts.resumeSession === 'string' ? cliOpts.resumeSession : null;
    if (id) {
      const saved = store.load(id);
      if (saved) {
        restoreSession(session, saved);
        sessionState.id = saved.id;
        config.cwd = session.cwd || config.cwd;
        if (!cliOpts.silent) ui.printInfo(`Resumed session ${id.slice(0, 8)}...`);
      } else {
        console.error(chalk.red(`Session not found: ${id}`));
        process.exit(1);
      }
    } else {
      // Session picker
      const sessions = store.list();
      if (sessions.length === 0) {
        if (!cliOpts.silent) ui.printInfo('No saved sessions.');
      } else {
        console.log(chalk.bold('\n  Recent sessions:\n'));
        for (const s of sessions.slice(0, 10)) {
          console.log(`  ${chalk.cyan(s.id.slice(0, 8))}  ${chalk.dim(s.updatedAt || '')}  ${s.summary || ''}`);
        }
        console.log('');
      }
    }
  }

  // Initialize system prompt
  if (session.messages.length === 0 || session.messages[0].role !== 'system') {
    session.setSystem(config.systemPrompt);
  }

  const refreshMainSessionMemory = () => refreshSessionMemory(session, store, {
    cwd: session.cwd || config.cwd || process.cwd(),
    limit: 10,
    excludeIds: sessionState.id ? [sessionState.id] : [],
  });

  const persistMainSession = () => {
    if (session.turnCount <= 0) {
      refreshMainSessionMemory();
      return sessionState.id;
    }

    sessionState.id = store.save(session, {
      id: sessionState.id || undefined,
      cwd: session.cwd || config.cwd || process.cwd(),
      model: config.model,
      kind: cliOpts.prompt ? 'oneshot-session' : 'interactive-session',
      agentName: config.agentName || null,
      agentDisplayName: config.agentDisplayName || null,
    });
    config.cwd = session.cwd || config.cwd;
    refreshMainSessionMemory();
    return sessionState.id;
  };

  refreshMainSessionMemory();

  return { persistSession: persistMainSession, refreshSessionMemory: refreshMainSessionMemory };
}

async function runOneshot({ agent, cliOpts, config, session, persistSession, refreshSessionMemory }) {
  refreshSessionMemory();
  const response = await agent.run(cliOpts.prompt);
  const sessionId = persistSession();
  if (cliOpts.outputFormat === 'json') {
    console.log(JSON.stringify({ content: response, model: config.model, turns: session.turnCount, sessionId }));
  } else if (cliOpts.silent && response) {
    // In silent mode, still output the response text (just no UI chrome)
    process.stdout.write(response + '\n');
  }
  process.exit(0);
}

async function runInteractive({ ctx, cliOpts, config, agent, ui, skillSystem, agentSystem, swarmSystem, persistSession, refreshSessionMemory }) {
  // Build autocomplete items: commands + skills + agents
  const cachedSkills = skillSystem.list();
  const cachedAgents = agentSystem.listAgents();
  const cachedSwarms = swarmSystem.list();
  const slashItems = [
    ...COMMAND_DESCS,
    ...cachedSkills.map(s => ({
      trigger: '/' + s.name,
      description: s.description,
      category: 'skills',
    })),
    // Individual agent switch completions: /agent <name>
    ...cachedAgents.map(a => ({
      trigger: '/agent ' + a.name,
      description: a.description.trim().split('\n')[0],
      category: 'agents',
    })),
    // Swarm completions: /swarm <name>
    { trigger: '/swarm', description: 'Run a multi-agent swarm or list swarms', category: 'swarms' },
    ...cachedSwarms.map(s => ({
      trigger: '/swarm ' + s.name,
      description: (s.description || '').trim().split('\n')[0],
      category: 'swarms',
    })),
    ...VOICE_COMMAND_DESCS,
  ];
  ui.setSlashItems(slashItems);

  if (!cliOpts.silent) {
    if (cliOpts.showBanner !== false) ui.splash();
    ui.statusBar(config);
    if (cliOpts.agent) {
      ui.printInfo(`Agent: ${config.agentDisplayName || cliOpts.agent}`);
    }
    const skillCount = cachedSkills.length;
    const agentCount = cachedAgents.length;
    const swarmCount = cachedSwarms.length;
    ui.printInfo(`${skillCount} skills · ${agentCount} agents · ${swarmCount} swarms · voice  — type / for completions`);
  }

  ui.init();

  // Execute initial prompt if provided via -i
  if (cliOpts.interactivePrompt) {
    refreshSessionMemory();
    await agent.run(cliOpts.interactivePrompt);
    persistSession();
  }

  while (true) {
    try {
      const input = await ui.prompt();
      if (!input) continue;

      if (isCommand(input)) {
        refreshSessionMemory();
        await executeCommand(input, ctx);
        persistSession();
        continue;
      }

      refreshSessionMemory();
      await agent.run(input);
      persistSession();
    } catch (err) {
      if (err.code === 'ERR_USE_AFTER_CLOSE') break;
      ui.printError(err.message);
    }
  }
}

async function main() {
  const cliOpts = parseArgs();

  // No-color mode
  if (cliOpts.noColor) {
    chalk.level = 0;
  }

  const config = loadConfig({
    baseUrl: cliOpts.baseUrl,
    model: cliOpts.model,
    temperature: cliOpts.temperature,
    maxTokens: cliOpts.maxTokens,
    systemPrompt: cliOpts.systemPrompt,
    cwd: process.cwd(),
  });

  const client = new NemotronClient(config);
  const session = new Session(config);
  const ui = new TerminalUI();
  const store = new SessionStore();
  const sessionState = { id: null };
  const agentSystem = new AgentSystem();
  const skillSystem = new SkillSystem();
  const swarmSystem = new SwarmSystem();

  // Handle --list
  if (cliOpts.list) {
    handleListCommand(cliOpts.list, { agentSystem, skillSystem, swarmSystem });
  }

  const isNonInteractive = !!(cliOpts.prompt && !cliOpts.interactivePrompt);

  // Apply agent if specified
  if (cliOpts.agent) {
    config.cwd = config.cwd || process.cwd();
    const agentConfig = agentSystem.applyAgent(cliOpts.agent, config);
    if (agentConfig) {
      Object.assign(config, agentConfig);
      if (cliOpts.systemPrompt) {
        config.systemPrompt = cliOpts.systemPrompt;
      }
      client.model = config.model;
    } else {
      console.error(chalk.red(`Unknown agent: ${cliOpts.agent}`));
      console.error(chalk.dim(`Available: ${agentSystem.listAgents().map(a => a.name).join(', ')}`));
      process.exit(1);
    }
  }

  const permissions = setupPermissions(cliOpts, { isNonInteractive });

  // Setup MCP
  const mcpClient = new MCPClient();
  mcpClient.on('log', (msg) => {
    if (!cliOpts.silent) ui.printInfo(msg);
  });

  // Always try loading MCP config (default ~/.nemo-cli/mcp-config.json + any --mcp-config flags)
  await mcpClient.loadConfig(cliOpts.mcpConfigs);
  const mcpToolCount = mcpClient.getToolDefinitions().length;
  if (mcpToolCount > 0 && !cliOpts.silent) {
    ui.printInfo(`MCP: ${mcpToolCount} tools from ${mcpClient.servers.size} server(s) — auto-loaded`);
  }

  // Check server health
  const healthy = await client.health();
  if (!healthy) {
    console.error(chalk.red(`\n  ✗ Cannot reach Nemotron server at ${config.baseUrl}`));
    console.error(chalk.dim(`  Make sure llama-server is running. Try: curl ${config.baseUrl}/health\n`));
    process.exit(1);
  }

  // Session init
  const { persistSession, refreshSessionMemory } = initSession({ cliOpts, config, session, store, sessionState, ui });

  // Create agent
  const agent = new Agent(client, session, ui, config, {
    permissions,
    mcpClient,
    stream: cliOpts.stream !== false,
    outputFormat: cliOpts.outputFormat || 'text',
    silent: cliOpts.silent,
    onEvent: cliOpts.outputFormat === 'stream-json' ? (evt) => {
      process.stdout.write(JSON.stringify(evt) + '\n');
    } : null,
  });

  const cluster = new ClusterManager();
  const swarmRunner = new SwarmRunner(client, config, agentSystem, permissions, mcpClient, cluster, {
    sessionStore: store,
  });
  const ctx = {
    client,
    session,
    ui,
    config,
    agent,
    store,
    agentSystem,
    skillSystem,
    swarmSystem,
    swarmRunner,
    permissions,
    mcpClient,
    cluster,
    sessionState,
    persistSession,
    refreshSessionMemory,
  };

  // Auto-save on exit
  const saveOnExit = () => {
    try { persistSession(); } catch (err) { console.error('Failed to save session:', err.message); }
    mcpClient.close().catch(() => {});
  };
  process.on('exit', saveOnExit);
  process.on('SIGINT', () => { saveOnExit(); process.exit(0); });

  // Run
  if (isNonInteractive) {
    await runOneshot({ agent, cliOpts, config, session, persistSession, refreshSessionMemory });
  } else {
    await runInteractive({ ctx, cliOpts, config, agent, ui, skillSystem, agentSystem, swarmSystem, persistSession, refreshSessionMemory });
  }
}

main().catch((err) => {
  console.error(chalk.red(`Fatal: ${err.message}`));
  process.exit(1);
});

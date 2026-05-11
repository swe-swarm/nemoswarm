# Nemoswarm

**Multi-node Nemotron reasoning swarm** — LiveKit-based orchestration across the anton cluster (anton · antonjr1 · antonjr2) with a full-featured terminal agent CLI, voice modes, and framer-hosted agent containers.

> Part of the [swe-swarm](https://github.com/swe-swarm) org. Author: darbot · License: MIT

## Repo layout

| Path | What's here |
|------|-------------|
| `src/` | nemo-cli core: client, agent, swarm, cluster, voice, MCP, permissions |
| `bin/` | `nemo` CLI entry point |
| `agents/` | YAML agent personas (coder, critic, architect, explorer, …) |
| `swarms/` | YAML swarm definitions (consensus, full-pipeline, cluster-review, …) |
| `skills/` | Slash-command macros (`/commit`, `/review`, `/fix`, …) |
| `mcp-servers/` | Built-in MCP server (`dlmcp.js`) |
| `orchestrator/` | `nemoswarm_orchestrator.py` — Python cluster health + chain-of-thought swarm runner; `livekit.yaml.example` |
| `framer/` | `personaplex_bridge.py` — Moshi WS ↔ LiveKit audio bridge; `nemotron_agent.py` — per-node LiveKit agent |
| `infra/` | APIM / deployment configs |

## Cluster topology

```
anton (10.1.0.4)     RTX 5090 32 GB   coordinator   :30000 LLM  :8998 Moshi  :7880 LK
antonjr1 (10.1.0.5)  2× RTX A4000     processor     :30000 LLM  :8998 Moshi  :7880 LK
antonjr2 (10.1.0.6)  RTX 4090 24 GB   validator     :30000 LLM  :8998 Moshi  :7880 LK
framer (10.1.8.66)   no GPU           hub            LiveKit :7880  swarm-web :8888
```

Chain-of-thought execution order: **validator → processor → coordinator** (jr2 → jr1 → anton). Each node's response is passed as context to the next.

## Voice backends (nemo-cli)

| Backend | Alias | Transport | Model |
|---------|-------|-----------|-------|
| `personaplex` (default) | `moshi` | Direct WebSocket to `:8998` | PersonaPlex-7B (Moshi) |
| `voicelive` | `lk`, `liveai`, `liveagents` | LiveKit room via framer | PersonaPlex-7B via personaplex-bridge |

# Nemo CLI

**Nemotron-powered terminal agent** — a local AI coding & operations CLI with tool calling, MCP support, multi-agent swarms, full-duplex voice, and cluster-aware dispatch. Mirrors the ergonomics of GitHub Copilot CLI but runs 100% against your own Nemotron / OpenAI-compatible inference server.

> Author: darbot · License: MIT · Node ≥ 20

---

## Highlights

- **OpenAI-compatible client** (`src/client.js`) with streaming, `<think>` block parsing, and tool-calling against any `/v1/chat/completions` endpoint (llama-server, vLLM, APIM gateway, etc.).
- **Built-in tools**: `bash`, `view`, `edit`, `create`, `grep`, `glob` (`src/tools/`).
- **Permissions system** with allow/deny lists, glob patterns, interactive approval, and YOLO mode (`src/permissions.js`).
- **Sessions** — persistent, resumable, with shared memory across recent runs in the same `cwd` (`src/store.js`, `src/session.js`).
- **Agents** — YAML-defined personas with custom prompts, model overrides, tool restrictions, and routing (`agents/`, `src/agents.js`).
- **Skills** — slash-command macros that expand into rich prompts (`skills/`, `src/skills.js`). Built-ins: `/commit`, `/review`, `/fix`, `/refactor`, `/test`, `/docs`, `/explain`, `/scaffold`, `/migrate`, `/pr`, `/changelog`, `/security-audit`, `/dependency-audit`, `/test-coverage`, `/debug`.
- **Swarms** — coordinator + delegate multi-agent orchestration with optional cluster dispatch (`swarms/`, `src/swarm.js`).
- **Cluster manager** — round-robin / specific-node / load-balanced dispatch over SSH or remote LLM endpoints (`src/cluster.js`).
- **MCP client** — speaks Model Context Protocol over stdio; auto-discovers tools and proxies calls (`src/mcp.js`). Includes a built-in DarbotLM/PersonaPlex MCP server (`mcp-servers/dlmcp.js`).
- **Voice mode** — full-duplex speech via PersonaPlex Moshi WebSocket *or* LiveKit room sessions (`src/voice.js`, `src/livekit-room-client.js`, `src/livekit-agent-bridge.js`).

---

## Install

```bash
git clone <this-repo> nemo-cli
cd nemo-cli
npm install
npm link            # makes `nemo` available on PATH
# or run directly:
node bin/nemo.js
```

Requires Node ≥ 20 and a reachable Nemotron-style OpenAI-compatible server.

---

## Quick start

```bash
# Interactive REPL
nemo

# One-shot prompt (auto-approve all tools)
nemo --prompt "Fix the failing test in src/foo.test.js" --allow-all

# YOLO everything
nemo --yolo --prompt "Refactor the auth module"

# Use a specific agent
nemo --agent code-review

# Resume a session
nemo --continue
nemo --resume <session-id>

# Allow only read tools
nemo --allow-tool view grep glob --deny-tool edit create bash

# List bundled agents / skills / swarms
nemo --list agents
nemo --list skills
nemo --list swarms
```

---

## Configuration

### Precedence
`defaults` < `~/.nemo-cli/config.yaml` < env vars < CLI flags.

### `~/.nemo-cli/config.yaml`
```yaml
baseUrl: http://127.0.0.1:30000
model: nemotron
maxTokens: 4096
temperature: 0.7
maxHistory: 100
reasoningBudget: 1024
systemPrompt: |
  Custom system prompt; supports {{cluster}}, {{cwd}}, {{platform}}.
backend: personaplex          # or "livekit"
livekitUrl: wss://...         # when using LiveKit voice
livekitTokenStrategy: mint    # or "token"
```

### Environment variables
| Var | Effect |
| --- | --- |
| `NEMO_HOME` | Override config dir (default `~/.nemo-cli`) |
| `NEMO_BASE_URL` / `NEMO_URL` / `NEMO_PORT` | Server endpoint |
| `NEMO_MODEL` | Model name |
| `NEMO_TEMP`, `NEMO_TOKENS` | Sampling overrides |
| `NEMO_BACKEND` | `personaplex` \| `livekit` |
| `NEMO_HOST`, `NEMO_ROOM`, `NEMO_IDENTITY`, `NEMO_SESSION_ID` | Voice routing |
| `LIVEKIT_URL`, `LIVEKIT_TOKEN`, `LIVEKIT_TOKEN_STRATEGY`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | LiveKit credentials |

### Cluster system prompt
By default Nemo injects a description of a 3-node Darbot LM cluster (`anton`, `antonjr1`, `antonjr2`) into the system prompt, including SSH dispatch patterns and Prometheus query examples. Override by writing your own `~/.nemo-cli/cluster-prompt.md`.

---

## CLI reference (selected)

| Category | Flags |
| --- | --- |
| **Server / Model** | `--port/-p`, `--url/-u`, `--model`, `--temp/-t`, `--tokens` |
| **Permissions** | `--allow-all` / `--yolo`, `--allow-all-tools`, `--allow-all-paths`, `--allow-all-urls`, `--allow-tool`, `--deny-tool`, `--excluded-tools`, `--available-tools` |
| **Session** | `-c/--continue`, `-r/--resume [id]`, `-i/--interactive <prompt>`, `--prompt <text>` |
| **Output** | `-s/--silent`, `--stream on\|off`, `--output-format text\|json\|stream-json`, `--no-color`, `--banner` |
| **Agent** | `--agent <name>`, `--system-prompt <text>`, `--no-custom-instructions` |
| **MCP** | `--mcp-config <json\|@path>`, `--additional-mcp-config`, `--disable-builtin-mcps`, `--disable-mcp-server <name>` |
| **Directories** | `--add-dir <dir>`, `--disallow-temp-dir` |
| **URLs** | `--allow-url`, `--deny-url`, `--allow-all-urls` |
| **Advanced** | `--autopilot`, `--max-autopilot-continues`, `--no-ask-user`, `--disable-parallel-tools-execution`, `--experimental`, `--config-dir`, `--log-level`, `--log-dir`, `--screen-reader`, `--plain-diff`, `--alt-screen` |
| **Listing** | `--list agents\|skills\|swarms` |
| **Info** | `-v/--version`, `-h/--help`, `help [config\|commands\|permissions]` |

---

## Slash commands (interactive mode)

| Command | Purpose |
| --- | --- |
| `/help`, `/status`, `/exit` | Basics |
| `/clear`, `/compact` | History reset / summarize-and-shrink |
| `/model [name]`, `/temp <v>`, `/tokens <v>` | Live config |
| `/agents`, `/agent <name>` | Switch persona |
| `/skills`, `/<skill> [args]` | Run a skill macro (e.g. `/commit`, `/review src/foo.js`) |
| `/swarm <name> <task>` | Launch a multi-agent swarm |
| `/voice [backend] [route…]` | Start voice session (PersonaPlex or LiveKit) |

---

## Tools

| Tool | Description |
| --- | --- |
| `bash` | Run shell commands; `cd` persists for the session. |
| `view` | Read file (with line numbers) or list a directory. |
| `edit` | Exact-match string replacement in a file (must match once). |
| `create` | Create a new file (must not exist). |
| `grep` | ripgrep-backed content search with glob filter. |
| `glob` | Glob-pattern file finder. |

MCP-discovered tools are merged into the same registry and respect the same permission gates.

---

## Agents (`agents/*.yaml`)

Bundled: `analyst`, `architect`, `backend`, `code-review`, `coder`, `critic`, `debug`, `docs-writer`, `explore`, `frontend`, `judge`, `observer`, `optimizer`, `plan`, `reasoner`, `researcher`, `security`, `synthesizer`, `task`, `tester`, `test-writer`.

Each agent is a YAML doc:
```yaml
name: explore
displayName: Explore Agent
description: Fast codebase exploration…
model: nemotron
tools: [grep, glob, view]   # optional restriction; "*" = all
prompt: |
  …system prompt with {{cwd}}, {{platform}} placeholders…
# Optional routing overrides:
# baseUrl, backend, host, room, identity, sessionId, livekitUrl, …
```
User agents can be dropped into `~/.nemo-cli/agents/` or loaded ad-hoc by path.

## Skills (`skills/*.yaml`)

Bundled: `commit`, `review`, `fix`, `refactor`, `test`, `docs`, `explain`, `scaffold`, `migrate`, `pr`, `changelog`, `security-audit`, `dependency-audit`, `test-coverage`, `debug`.

Skill YAML:
```yaml
name: commit
displayName: Generate Commit Message
description: Analyze staged changes and write a conventional commit message
tools: [bash, view, grep]
prompt: |
  …full prompt; {{args}} is replaced with anything the user typed after /commit…
```
User skills live in `~/.nemo-cli/skills/`. `SkillSystem.install()` / `uninstall()` manage them programmatically.

## Swarms (`swarms/*.yaml`)

Coordinator-driven multi-agent flows. Bundled: `analyze`, `architect-build-test`, `cluster-review`, `consensus`, `debug`, `distributed-pipeline`, `error-recovery`, `full-pipeline`, `implement`, `iterative-refinement`, `observe-analyze`, `reason-code`, `review`, `tempest-fleet-review`, `tempest-nemo-coach`.

A swarm declares `agents` (role → agent mapping) and a `coordinator_prompt` that calls `delegate(role=…, task=…)`. Sub-agents may execute locally or on remote cluster nodes via `ClusterManager` (`remote-llm` or `remote-agent` mode).

---

## MCP (Model Context Protocol)

Nemo speaks JSON-RPC 2.0 over stdio to MCP servers, discovers their tools, and proxies tool calls. Configure via `~/.nemo-cli/mcp-config.json` or `--mcp-config`:

```json
{
  "mcpServers": {
    "dlmcp": { "command": "node", "args": ["/abs/path/to/mcp-servers/dlmcp.js"] }
  }
}
```

The bundled `mcp-servers/dlmcp.js` exposes the DarbotLM gateway and PersonaPlex voice service:
`dlmcp_services`, `dlmcp_nodes`, `dlmcp_providers`, `dlmcp_templates`, `moshi_health`, `moshi_info`, `moshi_voices`.

---

## Voice

Two backends:

- **PersonaPlex (Moshi)** — full-duplex over `ws://<host>:8998/api/chat`, OGG-Opus 24 kHz mono, 20 ms frames. Playback via `aplay` at 48 kHz (opusscript decode).
- **LiveKit** — room/session/identity routed; minted or supplied tokens. The `LiveKitNemoBridge` (`src/livekit-agent-bridge.js`) wires LiveKit text turns into the same `Agent` loop used by the CLI, so swarm/agent routing applies in voice rooms.

Examples:
```bash
/voice antonjr1 natm0
/voice livekit room standup host ws://127.0.0.1:7880
nemo --backend livekit --room ops --identity nemo --agent reviewer
```

---

## Cluster manager

`src/cluster.js` knows about a default 3-node fleet (`anton`, `antonjr1`, `antonjr2`) and can:

- health-check nodes (cached 30 s),
- pick targets via round-robin / specific / least-loaded strategies,
- dispatch in **remote-llm** mode (point the local agent at a remote `/v1` endpoint) or **remote-agent** mode (SSH and run `nemo --prompt …` on the remote node).

This is what makes swarms scale across the cluster transparently.

---

## Testing

```bash
npm test
```
Runs every `src/**/*.test.js` file under `node --test`. Coverage spans config, permissions, sessions, store, skills, agents, commands, tools (`edit`), cluster, swarm, voice, and the LiveKit bridge.

---

## Repository layout

```
bin/nemo.js                 CLI entrypoint (arg parsing, REPL, one-shot, listing)
src/
  client.js                 OpenAI-compatible streaming client
  agent.js                  Core agent loop (LLM ↔ tools ↔ permissions)
  agents.js                 YAML agent loader + applyAgent()
  skills.js                 YAML skill loader + expand/install
  swarm.js                  SwarmSystem + SwarmRunner (coordinator/delegate)
  cluster.js                Multi-node dispatch + health
  commands.js               Slash commands + voice command parsing
  config.js                 Defaults, env/file/CLI merge, validation
  session.js                In-memory conversation state
  store.js                  Session persistence + shared memory
  permissions.js            Tool allow/deny + interactive approval
  mcp.js                    MCP stdio client + tool proxy
  voice.js                  PersonaPlex Moshi voice loop
  livekit-room-client.js    LiveKit room I/O
  livekit-agent-bridge.js   Wire LiveKit turns into the Agent loop
  logger.js                 Tiny leveled logger
  tools/                    bash, view, edit, create, grep, glob (+ tests)
  ui/                       renderer.js, input.js (terminal UI)
agents/      *.yaml         Built-in agents
skills/      *.yaml         Built-in skills
swarms/      *.yaml         Built-in swarms
mcp-servers/dlmcp.js        Bundled MCP server (DarbotLM + PersonaPlex)
```

---

## License

MIT © darbot

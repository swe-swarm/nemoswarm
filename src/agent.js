// Agent loop — the core reasoning engine
// Handles: prompt → LLM → tool_calls → execute → loop
// Supports: permissions, MCP tools, streaming, chain-of-thought, output formats
import { TOOL_DEFINITIONS, executeTool } from './tools/index.js';

// ── Streaming <think> block parser ───────────────────────────────────────────
// Handles tags split across multiple stream chunks.
class ThinkingParser {
  constructor() {
    this.state = 'normal'; // 'normal' | 'in-think'
    this.buf = '';
  }

  // Feed a new chunk; returns { normal, think } text segments
  feed(chunk) {
    this.buf += chunk;
    let normal = '';
    let think = '';

    while (this.buf.length > 0) {
      if (this.state === 'normal') {
        const open = '<think>';
        const idx = this.buf.indexOf(open);
        if (idx === -1) {
          // Guard against partial tag sitting at the tail
          const safe = this._safeLen(this.buf, open);
          normal += this.buf.slice(0, safe);
          this.buf = this.buf.slice(safe);
          break;
        }
        normal += this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + open.length);
        this.state = 'in-think';
      } else {
        const close = '</think>';
        const idx = this.buf.indexOf(close);
        if (idx === -1) {
          const safe = this._safeLen(this.buf, close);
          think += this.buf.slice(0, safe);
          this.buf = this.buf.slice(safe);
          break;
        }
        think += this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + close.length);
        this.state = 'normal';
      }
    }

    return { normal, think };
  }

  // Flush any remaining buffer at end of stream
  flush() {
    const remaining = this.buf;
    this.buf = '';
    if (this.state === 'normal') return { normal: remaining, think: '' };
    return { normal: '', think: remaining };
  }

  // How many bytes of buf can we safely emit (avoiding partial tag at end)?
  _safeLen(buf, tag) {
    const max = tag.length - 1;
    for (let l = Math.min(max, buf.length); l > 0; l--) {
      if (tag.startsWith(buf.slice(-l))) return buf.length - l;
    }
    return buf.length;
  }
}

// ── Agent ────────────────────────────────────────────────────────────────────
export class Agent {
  constructor(client, session, ui, config, opts = {}) {
    this.client = client;
    this.session = session;
    this.ui = ui;
    this.config = config;
    this.permissions = opts.permissions || null;
    this.mcpClient = opts.mcpClient || null;
    this.maxIterations = 25;
    this.streamEnabled = opts.stream !== false;
    this.outputFormat = opts.outputFormat || 'text'; // text | json | stream-json
    this.silent = opts.silent || false;
    this.onEvent = opts.onEvent || null;
    this.swarmExecutor = opts.swarmExecutor || null; // custom executor for _swarm tools
    this._abortController = null;
    this._toolDefsCache = null;
  }

  getToolDefinitions() {
    if (this._toolDefsCache) return this._toolDefsCache;
    let tools = [...TOOL_DEFINITIONS];
    if (this.mcpClient) tools = tools.concat(this.mcpClient.getToolDefinitions());
    if (this.permissions) tools = this.permissions.filterTools(tools);
    this._toolDefsCache = tools;
    return tools;
  }

  invalidateToolCache() {
    this._toolDefsCache = null;
  }

  _emitEvent(type, data) {
    if (this.onEvent) {
      try {
        this.onEvent({ type, data, timestamp: new Date().toISOString() });
      } catch (_) { /* don't let a broken handler crash the agent */ }
    }
  }

  abort() {
    if (this._abortController) this._abortController.abort();
  }

  async run(userMessage) {
    this.session.addUser(userMessage);
    this._abortController = new AbortController();
    this._toolDefsCache = null; // invalidate so we get fresh definitions each run
    let iterations = 0;
    const allToolDefs = this.getToolDefinitions();
    let fullResponse = '';

    this._emitEvent('turn.start', { message: userMessage });

    while (iterations < this.maxIterations) {
      iterations++;
      const messages = this.session.getMessages();

      let fullContent = '';
      let toolCalls = [];
      let currentToolCalls = {};

      if (!this.silent && this.outputFormat === 'text') {
        this.ui.startSpinner(iterations === 1 ? 'Thinking' : 'Processing tool results');
      }

      let spinnerStopped = false;
      let thinkingOpen = false;    // is the thinking block currently visible?
      let responseStarted = false; // have we printed any response text?
      const parser = new ThinkingParser();

      const _ensureSpinnerOff = () => {
        if (!spinnerStopped) {
          if (!this.silent) this.ui.stopSpinner();
          spinnerStopped = true;
        }
      };

      const _handleThink = (text) => {
        if (!text) return;
        if (!thinkingOpen) {
          if (!this.silent && this.outputFormat === 'text') this.ui.startThinking();
          thinkingOpen = true;
          this._emitEvent('thinking.start', {});
        }
        if (!this.silent && this.outputFormat === 'text') this.ui.streamThinkToken(text);
        this._emitEvent('thinking.delta', { content: text });
      };

      const _handleNormal = (text) => {
        if (!text) return;
        if (thinkingOpen) {
          if (!this.silent && this.outputFormat === 'text') this.ui.stopThinking();
          thinkingOpen = false;
          this._emitEvent('thinking.end', {});
        }
        if (!responseStarted) {
          if (!this.silent && this.outputFormat === 'text') process.stdout.write('\n');
          responseStarted = true;
        }
        fullContent += text;
        if (this.outputFormat === 'text' && !this.silent) this.ui.streamToken(text);
        else if (this.outputFormat === 'stream-json') this._emitEvent('assistant.message_delta', { content: text });
      };

      try {
        if (this.streamEnabled) {
          for await (const chunk of this.client.chatStream(messages, allToolDefs, {
            temperature: this.config.temperature,
            maxTokens: this.config.maxTokens,
            signal: this._abortController.signal,
          })) {
            const delta = chunk.choices?.[0]?.delta;
            if (!delta && !chunk.choices?.[0]?.finish_reason) continue;

            // Some models (e.g. newer llama.cpp builds) expose reasoning separately
            if (delta?.reasoning_content) {
              _ensureSpinnerOff();
              _handleThink(delta.reasoning_content);
            }

            if (delta?.content) {
              _ensureSpinnerOff();
              const { normal, think } = parser.feed(delta.content);
              if (think) _handleThink(think);
              if (normal) _handleNormal(normal);
            }

            // Accumulate tool calls
            if (delta?.tool_calls) {
              _ensureSpinnerOff();
              for (const tc of delta.tool_calls) {
                const idx = tc.index;
                if (!currentToolCalls[idx]) {
                  currentToolCalls[idx] = {
                    id: tc.id || `call_${idx}_${Date.now()}`,
                    type: 'function',
                    function: { name: '', arguments: '' },
                  };
                }
                if (tc.id) currentToolCalls[idx].id = tc.id;
                if (tc.function?.name) currentToolCalls[idx].function.name += tc.function.name;
                if (tc.function?.arguments) currentToolCalls[idx].function.arguments += tc.function.arguments;
              }
            }
          }

          // Flush parser buffer
          const { normal: fn, think: ft } = parser.flush();
          if (ft) _handleThink(ft);
          if (fn) _handleNormal(fn);

        } else {
          // Non-streaming mode
          const resp = await this.client.chat(messages, allToolDefs, {
            temperature: this.config.temperature,
            maxTokens: this.config.maxTokens,
            signal: this._abortController.signal,
          });
          _ensureSpinnerOff();

          const choice = resp.choices?.[0];
          if (choice?.message?.content) {
            const { normal, think } = parser.feed(choice.message.content);
            const { normal: fn2, think: ft2 } = parser.flush();
            const allThink = think + ft2;
            const allNormal = normal + fn2;
            if (allThink) _handleThink(allThink);
            if (allNormal) _handleNormal(allNormal);
          }
          if (choice?.message?.tool_calls) {
            for (const tc of choice.message.tool_calls) {
              currentToolCalls[tc.index ?? Object.keys(currentToolCalls).length] = tc;
            }
          }
        }
      } catch (err) {
        _ensureSpinnerOff();
        if (thinkingOpen && !this.silent) this.ui.stopThinking();
        if (err.name === 'AbortError') {
          this._emitEvent('turn.abort', {});
          return fullResponse;
        }
        if (!this.silent) this.ui.printError(`LLM request failed: ${err.message}`);
        this._emitEvent('error', { message: err.message });
        return fullResponse;
      }

      _ensureSpinnerOff();
      if (thinkingOpen && !this.silent) { this.ui.stopThinking(); thinkingOpen = false; }

      toolCalls = Object.values(currentToolCalls);
      fullResponse += fullContent;

      if (fullContent || toolCalls.length > 0) {
        this.session.addAssistant(fullContent || null, toolCalls.length > 0 ? toolCalls : null);
      }

      if (toolCalls.length === 0) {
        if (fullContent && !this.silent && this.outputFormat === 'text') process.stdout.write('\n');
        this._emitEvent('assistant.message', { content: fullContent });
        this._emitEvent('turn.end', { iterations });
        return fullResponse;
      }

      // Execute tool calls
      this._emitEvent('tools.start', { count: toolCalls.length });

      for (const tc of toolCalls) {
        const name = tc.function.name;
        let args;
        try {
          args = JSON.parse(tc.function.arguments);
        } catch (err) {
          const parseError = { error: "Failed to parse tool arguments: " + err.message };
          if (!this.silent) this.ui.toolResult(name, parseError);
          this._emitEvent('tool.error', { name, error: parseError.error });
          this.session.addToolResult(tc.id, JSON.stringify(parseError));
          continue;
        }

        if (this.permissions && !this.permissions.isAllowed(name)) {
          const perm = await this.permissions.checkPermission(name, args, this.ui);
          if (!perm.allowed) {
            this.session.addToolResult(tc.id, JSON.stringify({ error: `Permission denied: ${perm.reason}` }));
            this._emitEvent('tool.denied', { name, reason: perm.reason });
            continue;
          }
        }

        if (!this.silent) this.ui.toolStart(name, args);
        this._emitEvent('tool.start', { name, args });

        let result;
        const normalizedName = name.replace(/[^a-zA-Z0-9_]/g, '_');
        const toolDef = allToolDefs.find(t =>
          t.function?.name === name || t.function?.name === normalizedName
        );
        const resolvedMcpTool = !toolDef && this.mcpClient
          ? this.mcpClient.resolveToolCall(name) || this.mcpClient.resolveToolCall(normalizedName)
          : null;

        if (toolDef?._swarm && this.swarmExecutor) {
          result = await this.swarmExecutor(name, args);
        } else if ((toolDef?._mcp || resolvedMcpTool) && this.mcpClient) {
          const mcpTarget = resolvedMcpTool || toolDef._mcp;
          result = await this.mcpClient.executeTool(mcpTarget.server, mcpTarget.originalName, args);
        } else {
          result = await executeTool(name, args, { cwd: this.session.cwd || process.cwd() });
        }

        if (!this.silent) this.ui.toolResult(name, result);
        this._emitEvent('tool.end', { name, result: result.error ? 'error' : 'success' });

        if (result?.cwd && this.session?.setCwd) {
          this.session.setCwd(result.cwd);
          this.config.cwd = result.cwd;
        }

        const content = result.error
          ? JSON.stringify({ error: result.error })
          : JSON.stringify({
            output: result.output,
            exitCode: result.exitCode,
            ...(result.cwd ? { cwd: result.cwd } : {}),
          });

        this.session.addToolResult(tc.id, content);
      }
    }

    if (!this.silent) this.ui.printWarning(`Reached max iterations (${this.maxIterations}). Stopping.`);
    this._emitEvent('turn.end', { iterations, maxReached: true });
    return fullResponse;
  }
}

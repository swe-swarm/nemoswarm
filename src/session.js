// Session management — conversation history and context
export class Session {
  constructor(config = {}) {
    this.messages = [];
    this.maxHistory = config.maxHistory || 100;
    this.cwd = config.cwd || process.cwd();
    this.baseSystemPrompt = config.baseSystemPrompt || config.systemPrompt || '';
    this.sharedMemory = config.sharedMemory || '';
    this.systemPrompt = this._composeSystemPrompt();
    this.turnCount = 0;
  }

  _buildRuntimeContext() {
    return this.cwd ? `Runtime context:\n- Current working directory: ${this.cwd}` : '';
  }

  _composeSystemPrompt() {
    return [this.baseSystemPrompt, this._buildRuntimeContext(), this.sharedMemory]
      .filter(Boolean)
      .join('\n\n');
  }

  _updateSystemMessage() {
    this.systemPrompt = this._composeSystemPrompt();
    if (!this.systemPrompt) return;
    if (this.messages.length > 0 && this.messages[0].role === 'system') {
      this.messages[0] = { role: 'system', content: this.systemPrompt };
    } else {
      this.messages.unshift({ role: 'system', content: this.systemPrompt });
    }
  }

  addSystem(content) {
    this.baseSystemPrompt = content || '';
    this._updateSystemMessage();
  }

  setSystem(content) {
    this.addSystem(content);
  }

  setSharedMemory(content) {
    this.sharedMemory = content || '';
    this._updateSystemMessage();
  }

  setCwd(cwd) {
    const nextCwd = String(cwd || '').trim();
    if (!nextCwd || nextCwd === this.cwd) return;
    this.cwd = nextCwd;
    this._updateSystemMessage();
  }

  addUser(content) {
    this.messages.push({ role: 'user', content });
    this.turnCount++;
  }

  addAssistant(content, toolCalls = null) {
    const msg = { role: 'assistant', content: content || '' };
    if (toolCalls && toolCalls.length > 0) {
      msg.tool_calls = toolCalls;
    }
    this.messages.push(msg);
  }

  addToolResult(toolCallId, content) {
    this.messages.push({
      role: 'tool',
      tool_call_id: toolCallId,
      content: typeof content === 'string' ? content : JSON.stringify(content),
    });
  }

  getMessages() {
    const msgs = [...this.messages];
    if (msgs.length === 0 || msgs[0].role !== 'system') {
      if (this.systemPrompt) {
        msgs.unshift({ role: 'system', content: this.systemPrompt });
      }
    } else if (msgs[0].content !== this.systemPrompt) {
      msgs[0] = { role: 'system', content: this.systemPrompt };
    }

    if (msgs.length > this.maxHistory + 1) {
      const system = msgs[0];
      const recent = msgs.slice(-this.maxHistory);
      return system ? [system, ...recent] : recent;
    }
    return msgs;
  }

  clear() {
    this.messages = [];
    this.turnCount = 0;
    this._updateSystemMessage();
  }

  compact(summary) {
    const messages = [];
    if (this.systemPrompt) {
      messages.push({ role: 'system', content: this.systemPrompt });
    }
    messages.push({
      role: 'assistant',
      content: `[Previous conversation summary: ${summary}]`,
    });
    this.messages = messages;
  }

  fork(options = {}) {
    const {
      systemPrompt = this.baseSystemPrompt,
      sharedMemory = this.sharedMemory,
      cwd = this.cwd,
      maxHistory = this.maxHistory,
      tailCount = this.maxHistory,
      includeMessages = true,
    } = options;

    const forked = new Session({
      systemPrompt,
      baseSystemPrompt: this.baseSystemPrompt,
      sharedMemory,
      cwd,
      maxHistory,
    });

    if (!includeMessages) {
      forked._updateSystemMessage();
      return forked;
    }

    const history = this.getMessages().slice(1);
    const tail = typeof tailCount === 'number' ? history.slice(-tailCount) : history;
    forked.messages = [
      ...(forked.systemPrompt ? [{ role: 'system', content: forked.systemPrompt }] : []),
      ...tail.map((message) => ({
        ...message,
        tool_calls: message.tool_calls ? message.tool_calls.map((toolCall) => ({
          ...toolCall,
          function: toolCall.function ? { ...toolCall.function } : toolCall.function,
        })) : message.tool_calls,
      })),
    ];
    forked.turnCount = tail.filter((message) => message.role === 'user').length;
    return forked;
  }

  serialize() {
    return {
      messages: this.getMessages(),
      turnCount: this.turnCount,
      systemPrompt: this.systemPrompt,
      baseSystemPrompt: this.baseSystemPrompt,
      sharedMemory: this.sharedMemory,
      cwd: this.cwd,
      maxHistory: this.maxHistory,
    };
  }

  get tokenEstimate() {
    const text = this.getMessages().map(m => m.content || '').join('');
    return Math.ceil(text.length / 4);
  }
}

// Nemotron API client — OpenAI-compatible streaming interface to llama-server
import { EventEmitter } from 'events';

const DEFAULT_BASE_URL = 'http://127.0.0.1:30000';
const DEFAULT_MODEL = 'nemotron';
const DEFAULT_CHAT_COMPLETIONS_PATH = '/v1/chat/completions';

function normalizeOptionalString(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function normalizePath(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return DEFAULT_CHAT_COMPLETIONS_PATH;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export class NemotronClient extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.baseUrl = opts.baseUrl || process.env.NEMO_BASE_URL || DEFAULT_BASE_URL;
    this.chatCompletionsPath = normalizePath(
      opts.chatCompletionsPath ?? process.env.NEMO_CHAT_COMPLETIONS_PATH
    );
    this.apiVersion = normalizeOptionalString(
      opts.apiVersion ?? process.env.NEMO_API_VERSION
    );
    this.bearerToken = normalizeOptionalString(
      opts.bearerToken ?? process.env.NEMO_BEARER_TOKEN
    );
    this.apimSubscriptionKey = normalizeOptionalString(
      opts.apimSubscriptionKey ?? process.env.NEMO_APIM_SUBSCRIPTION_KEY
    );
    this.model = opts.model || process.env.NEMO_MODEL || DEFAULT_MODEL;
    this.maxTokens = opts.maxTokens || 4096;
    this.temperature = opts.temperature ?? 0.7;
    this.reasoningBudget = opts.reasoningBudget ?? 1024;
  }

  _buildBody(messages, tools, opts) {
    const body = {
      model: this.model,
      messages,
      temperature: opts.temperature ?? this.temperature,
      max_tokens: opts.maxTokens ?? this.maxTokens,
      stream: opts.stream ?? true,
      reasoning_format: 'deepseek',
      thinking: {
        type: 'enabled',
        budget_tokens: opts.reasoningBudget ?? this.reasoningBudget,
      },
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = opts.toolChoice || 'auto';
    }
    return body;
  }

  _buildChatUrl() {
    const base = String(this.baseUrl).replace(/\/+$/, '');
    const url = new URL(`${base}${this.chatCompletionsPath}`);
    if (this.apiVersion) url.searchParams.set('api-version', this.apiVersion);
    return url.toString();
  }

  _buildHeaders({ contentType = false } = {}) {
    const headers = {};
    if (contentType) headers['Content-Type'] = 'application/json';
    if (this.bearerToken) headers.Authorization = `Bearer ${this.bearerToken}`;
    if (this.apimSubscriptionKey) {
      headers['Ocp-Apim-Subscription-Key'] = this.apimSubscriptionKey;
    }
    return headers;
  }

  _redactSecrets(text) {
    let redacted = String(text ?? '');
    for (const secret of [this.bearerToken, this.apimSubscriptionKey]) {
      if (secret) redacted = redacted.split(secret).join('[REDACTED]');
    }
    return redacted;
  }

  async *chatStream(messages, tools = null, opts = {}) {
    const body = this._buildBody(messages, tools, { ...opts, stream: true });

    const resp = await fetch(this._buildChatUrl(), {
      method: 'POST',
      headers: this._buildHeaders({ contentType: true }),
      body: JSON.stringify(body),
      signal: opts.signal,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Nemotron API error ${resp.status}: ${this._redactSecrets(text)}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;

        try {
          const chunk = JSON.parse(trimmed.slice(6));
          yield chunk;
        } catch (err) {
          if (process.env.NEMO_DEBUG) console.error('Skipping malformed SSE chunk:', err.message);
        }
      }
    }
  }

  async chat(messages, tools = null, opts = {}) {
    const body = this._buildBody(messages, tools, { ...opts, stream: false });

    const resp = await fetch(this._buildChatUrl(), {
      method: 'POST',
      headers: this._buildHeaders({ contentType: true }),
      body: JSON.stringify(body),
      signal: opts.signal,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Nemotron API error ${resp.status}: ${this._redactSecrets(text)}`);
    }

    try {
      return await resp.json();
    } catch (err) {
      throw new Error(`Failed to parse chat response JSON: ${err.message}`);
    }
  }

  async health() {
    try {
      const resp = await fetch(`${this.baseUrl}/health`, {
        headers: this._buildHeaders(),
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok) return false;
      const data = await resp.json();
      return data.status === 'ok';
    } catch {
      return false;
    }
  }

  async slots() {
    try {
      const resp = await fetch(`${this.baseUrl}/slots`, {
        headers: this._buildHeaders(),
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok) return null;
      return resp.json();
    } catch {
      return null;
    }
  }
}

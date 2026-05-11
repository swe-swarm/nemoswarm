import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { NemotronClient } from './client.js';

const CLIENT_ENV_KEYS = [
  'NEMO_BASE_URL',
  'NEMO_MODEL',
  'NEMO_CHAT_COMPLETIONS_PATH',
  'NEMO_API_VERSION',
  'NEMO_BEARER_TOKEN',
  'NEMO_APIM_SUBSCRIPTION_KEY',
];

function installFetchMock(response = {}) {
  const calls = [];
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      async json() {
        return response.json ?? { id: 'ok' };
      },
      async text() {
        return response.text ?? '';
      },
    };
  };
  return calls;
}

describe('NemotronClient', () => {
  let originalFetch;
  let originalEnv;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalEnv = { ...process.env };
    for (const key of CLIENT_ENV_KEYS) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    if (originalFetch === undefined) delete global.fetch;
    else global.fetch = originalFetch;
    for (const key of CLIENT_ENV_KEYS) {
      if (originalEnv[key] !== undefined) process.env[key] = originalEnv[key];
      else delete process.env[key];
    }
  });

  it('uses the default chat URL and headers when APIM settings are unset', async () => {
    const calls = installFetchMock();
    const client = new NemotronClient({ baseUrl: 'http://127.0.0.1:30000' });

    const result = await client.chat([{ role: 'user', content: 'hello' }]);

    assert.deepEqual(result, { id: 'ok' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:30000/v1/chat/completions');
    assert.deepEqual(calls[0].init.headers, { 'Content-Type': 'application/json' });
    assert.equal(JSON.parse(calls[0].init.body).stream, false);
  });

  it('builds APIM chat URLs and auth headers from options', async () => {
    const calls = installFetchMock();
    const client = new NemotronClient({
      baseUrl: 'https://apim.example.test/nemo/',
      chatCompletionsPath: '/openai/deployments/nemotron/chat/completions',
      apiVersion: '2024-10-21',
      bearerToken: 'placeholder-bearer-token',
      apimSubscriptionKey: 'placeholder-subscription-key',
    });

    await client.chat([{ role: 'user', content: 'hello' }]);

    assert.equal(
      calls[0].url,
      'https://apim.example.test/nemo/openai/deployments/nemotron/chat/completions?api-version=2024-10-21'
    );
    assert.deepEqual(calls[0].init.headers, {
      'Content-Type': 'application/json',
      Authorization: 'Bearer placeholder-bearer-token',
      'Ocp-Apim-Subscription-Key': 'placeholder-subscription-key',
    });
  });

  it('builds APIM chat URLs and auth headers from environment variables', async () => {
    process.env.NEMO_CHAT_COMPLETIONS_PATH = '/openai/deployments/env/chat/completions';
    process.env.NEMO_API_VERSION = '2024-12-01-preview';
    process.env.NEMO_BEARER_TOKEN = 'placeholder-env-bearer-token';
    process.env.NEMO_APIM_SUBSCRIPTION_KEY = 'placeholder-env-subscription-key';
    const calls = installFetchMock();
    const client = new NemotronClient({ baseUrl: 'https://apim.example.test' });

    await client.chat([{ role: 'user', content: 'hello' }]);

    assert.equal(
      calls[0].url,
      'https://apim.example.test/openai/deployments/env/chat/completions?api-version=2024-12-01-preview'
    );
    assert.deepEqual(calls[0].init.headers, {
      'Content-Type': 'application/json',
      Authorization: 'Bearer placeholder-env-bearer-token',
      'Ocp-Apim-Subscription-Key': 'placeholder-env-subscription-key',
    });
  });

  it('redacts configured auth values from API errors', async () => {
    installFetchMock({
      ok: false,
      status: 401,
      text: 'invalid token placeholder-bearer-token and key placeholder-subscription-key',
    });
    const client = new NemotronClient({
      baseUrl: 'https://apim.example.test',
      bearerToken: 'placeholder-bearer-token',
      apimSubscriptionKey: 'placeholder-subscription-key',
    });

    await assert.rejects(
      () => client.chat([{ role: 'user', content: 'hello' }]),
      (err) => {
        assert.equal(err.name, 'Error');
        assert.match(err.message, /Nemotron API error 401/);
        assert.doesNotMatch(err.message, /placeholder-bearer-token/);
        assert.doesNotMatch(err.message, /placeholder-subscription-key/);
        assert.match(err.message, /\[REDACTED\]/);
        return true;
      }
    );
  });
});

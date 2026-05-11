import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { loadConfig } from './config.js';

const CONFIG_ENV_KEYS = [
  'NEMO_HOME',
  'NEMO_URL',
  'NEMO_PORT',
  'NEMO_MODEL',
  'NEMO_TEMP',
  'NEMO_TOKENS',
  'NEMO_CHAT_COMPLETIONS_PATH',
  'NEMO_API_VERSION',
  'NEMO_BEARER_TOKEN',
  'NEMO_APIM_SUBSCRIPTION_KEY',
  'NEMO_BACKEND',
  'NEMO_HOST',
  'NEMO_ROOM',
  'NEMO_IDENTITY',
  'NEMO_SESSION',
  'NEMO_SESSION_ID',
  'LIVEKIT_URL',
  'LIVEKIT_TOKEN_STRATEGY',
  'LIVEKIT_TOKEN',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
];

describe('loadConfig', () => {
  let tmpHome;
  let origHome;
  let origEnv;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(process.cwd(), '.nemo-config-test-'));
    origHome = process.env.HOME;
    origEnv = { ...process.env };

    // Point NEMO_HOME to an empty temp dir so no config file is found
    process.env.NEMO_HOME = tmpHome;
    // Clear env vars that might interfere
    for (const key of CONFIG_ENV_KEYS) {
      delete process.env[key];
    }
    process.env.NEMO_HOME = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    for (const key of CONFIG_ENV_KEYS) {
      if (origEnv[key] !== undefined) process.env[key] = origEnv[key];
      else delete process.env[key];
    }
    if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  });

  it('defaults are applied when no config file exists', () => {
    const config = loadConfig();
    assert.equal(config.model, 'nemotron');
    assert.equal(config.temperature, 0.5);
    assert.equal(config.maxTokens, 16384);
    assert.equal(config.maxHistory, 100);
    assert.equal(config.baseUrl, 'http://127.0.0.1:30000');
    assert.equal(config.chatCompletionsPath, '/v1/chat/completions');
    assert.equal(config.apiVersion, null);
    assert.equal(config.bearerToken, null);
    assert.equal(config.apimSubscriptionKey, null);
    assert.equal(config.backend, 'personaplex');
    assert.equal(config.host, null);
    assert.equal(config.livekitUrl, 'ws://127.0.0.1:7880');
    assert.equal(config.livekitTokenStrategy, 'mint');
    assert.equal(config.livekitToken, null);
    assert.ok(config.systemPrompt.includes('Nemo'));
  });

  it('overrides take precedence', () => {
    const config = loadConfig({ model: 'custom-model', temperature: 0.8, backend: 'livekit', room: 'cli-room' });
    assert.equal(config.model, 'custom-model');
    assert.equal(config.temperature, 0.8);
    assert.equal(config.backend, 'livekit');
    assert.equal(config.room, 'cli-room');
  });

  it('validation clamps temperature > 2 to default', () => {
    const config = loadConfig({ temperature: 5 });
    assert.equal(config.temperature, 0.5);
  });

  it('validation clamps negative maxTokens to default', () => {
    const config = loadConfig({ maxTokens: -100 });
    assert.equal(config.maxTokens, 16384);
  });

  it('environment variable NEMO_MODEL is picked up', () => {
    process.env.NEMO_MODEL = 'env-test-model';
    const config = loadConfig();
    assert.equal(config.model, 'env-test-model');
  });

  it('loads APIM chat settings from the environment', () => {
    process.env.NEMO_CHAT_COMPLETIONS_PATH = '/openai/deployments/nemo/chat/completions';
    process.env.NEMO_API_VERSION = '2024-10-21';
    process.env.NEMO_BEARER_TOKEN = 'placeholder-bearer-token';
    process.env.NEMO_APIM_SUBSCRIPTION_KEY = 'placeholder-subscription-key';

    const config = loadConfig();
    assert.equal(config.chatCompletionsPath, '/openai/deployments/nemo/chat/completions');
    assert.equal(config.apiVersion, '2024-10-21');
    assert.equal(config.bearerToken, 'placeholder-bearer-token');
    assert.equal(config.apimSubscriptionKey, 'placeholder-subscription-key');
  });

  it('invalid APIM chat settings fall back to defaults', () => {
    const config = loadConfig({
      chatCompletionsPath: 'openai/deployments/nemo/chat/completions',
      apiVersion: '',
      bearerToken: 123,
      apimSubscriptionKey: {},
    });
    assert.equal(config.chatCompletionsPath, '/v1/chat/completions');
    assert.equal(config.apiVersion, null);
    assert.equal(config.bearerToken, null);
    assert.equal(config.apimSubscriptionKey, null);
  });

  it('supports nested livekit routing from config files', () => {
    writeFileSync(join(tmpHome, 'config.yaml'), `backend: livekit
host: room-router.local
routing:
  room: ops-voice
  identity: nemo-router
  session: session-42
livekit:
  url: wss://livekit.example.com
  tokenStrategy: token
  token: file-token
`);

    const config = loadConfig();
    assert.equal(config.backend, 'livekit');
    assert.equal(config.host, 'room-router.local');
    assert.equal(config.room, 'ops-voice');
    assert.equal(config.identity, 'nemo-router');
    assert.equal(config.sessionId, 'session-42');
    assert.equal(config.livekitUrl, 'wss://livekit.example.com');
    assert.equal(config.livekitTokenStrategy, 'token');
    assert.equal(config.livekitToken, 'file-token');
    assert.equal(config.baseUrl, 'http://127.0.0.1:30000');
    assert.equal(config.model, 'nemotron');
  });

  it('loads livekit routing fields from the environment', () => {
    process.env.NEMO_BACKEND = 'LiveKit';
    process.env.NEMO_HOST = 'env-host';
    process.env.NEMO_ROOM = 'env-room';
    process.env.NEMO_IDENTITY = 'env-identity';
    process.env.NEMO_SESSION = 'env-session';
    process.env.LIVEKIT_URL = 'wss://env.livekit.example.com';
    process.env.LIVEKIT_TOKEN_STRATEGY = 'TOKEN';
    process.env.LIVEKIT_TOKEN = 'env-token';
    process.env.LIVEKIT_API_KEY = 'env-api-key';
    process.env.LIVEKIT_API_SECRET = 'env-api-secret';

    const config = loadConfig();
    assert.equal(config.backend, 'livekit');
    assert.equal(config.host, 'env-host');
    assert.equal(config.room, 'env-room');
    assert.equal(config.identity, 'env-identity');
    assert.equal(config.sessionId, 'env-session');
    assert.equal(config.livekitUrl, 'wss://env.livekit.example.com');
    assert.equal(config.livekitTokenStrategy, 'token');
    assert.equal(config.livekitToken, 'env-token');
    assert.equal(config.livekitApiKey, 'env-api-key');
    assert.equal(config.livekitApiSecret, 'env-api-secret');
  });

  it('CLI overrides beat environment variables', () => {
    process.env.NEMO_MODEL = 'env-model';
    process.env.NEMO_BACKEND = 'livekit';
    process.env.NEMO_ROOM = 'env-room';
    const config = loadConfig({ model: 'cli-model', backend: 'personaplex', room: 'cli-room' });
    assert.equal(config.model, 'cli-model');
    assert.equal(config.backend, 'personaplex');
    assert.equal(config.room, 'cli-room');
  });

  it('invalid livekit routing values fall back to defaults', () => {
    const config = loadConfig({
      backend: 'invalid-backend',
      livekitTokenStrategy: 'invalid-strategy',
      livekitUrl: 'ftp://unsupported',
    });
    assert.equal(config.backend, 'personaplex');
    assert.equal(config.livekitTokenStrategy, 'mint');
    assert.equal(config.livekitUrl, 'ws://127.0.0.1:7880');
  });

  it('token auth strategy requires an explicit token override', () => {
    const config = loadConfig({ livekitTokenStrategy: 'token' });
    assert.equal(config.livekitTokenStrategy, 'mint');
    assert.equal(config.livekitToken, null);
  });
});

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// We need to override the SESSIONS_DIR constant used inside SessionStore.
// The module reads it at import-time from a const, so we patch the HOME env
// var *before* importing, then construct the store manually with a temp dir.
// Instead, we'll subclass and override the paths used.

// Since SESSIONS_DIR is a module-level const derived from process.env.HOME,
// we set HOME to a temp dir before the dynamic import so the store writes there.

let tmpHome;
let SessionStore;

async function setup() {
  tmpHome = mkdtempSync(join(tmpdir(), 'nemo-store-test-'));
  // Point HOME to the temp dir so SESSIONS_DIR resolves inside it
  process.env.HOME = tmpHome;
  // Dynamic import so the module picks up the patched HOME
  const mod = await import('./store.js?t=' + Date.now());
  SessionStore = mod.SessionStore;
}

function makeSession(messages = [], turnCount = 0) {
  return {
    messages,
    turnCount,
    systemPrompt: 'test-system',
    baseSystemPrompt: 'test-system',
    sharedMemory: '',
    maxHistory: 50,
  };
}

describe('SessionStore', async () => {
  let store;
  let origHome;

  beforeEach(async () => {
    origHome = process.env.HOME;
    await setup();
    store = new SessionStore();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  });

  it('save() creates a JSON file', () => {
    const session = makeSession([{ role: 'user', content: 'hello' }], 1);
    const id = store.save(session, { id: 'test-save-id' });
    assert.equal(id, 'test-save-id');

    const sessionsDir = join(tmpHome, '.nemo-cli', 'sessions');
    const files = readdirSync(sessionsDir);
    assert.ok(files.includes('test-save-id.json'));
  });

  it('load() restores saved session data', () => {
    const messages = [
      { role: 'user', content: 'ping' },
      { role: 'assistant', content: 'pong' },
    ];
    const session = makeSession(messages, 2);
    const id = store.save(session, { id: 'test-load-id', model: 'test-model' });

    const loaded = store.load(id);
    assert.ok(loaded);
    assert.equal(loaded.id, 'test-load-id');
    assert.equal(loaded.model, 'test-model');
    assert.equal(loaded.turnCount, 2);
    assert.deepEqual(loaded.messages, messages);
  });

  it('list() returns recent sessions sorted by time', async () => {
    const s1 = makeSession([{ role: 'user', content: 'first' }], 1);
    store.save(s1, { id: 'session-1' });

    // Small delay to ensure different mtime
    await new Promise(r => setTimeout(r, 50));

    const s2 = makeSession([{ role: 'user', content: 'second' }], 1);
    store.save(s2, { id: 'session-2' });

    const sessions = store.list();
    assert.ok(sessions.length >= 2);
    // Most recent first
    assert.equal(sessions[0].id, 'session-2');
    assert.equal(sessions[1].id, 'session-1');
  });

  it('getMostRecent() returns the latest session', async () => {
    const cwd = '/tmp/test-project';
    store.save(makeSession([{ role: 'user', content: 'old' }], 1), { id: 'old-session', cwd });

    await new Promise(r => setTimeout(r, 50));

    store.save(makeSession([{ role: 'user', content: 'new' }], 1), { id: 'new-session', cwd });

    const recent = store.getMostRecent(cwd);
    assert.ok(recent);
    assert.equal(recent.id, 'new-session');
  });

  it('buildMemoryContext() returns a string with session summaries', () => {
    store.save(
      makeSession([{ role: 'user', content: 'write tests' }, { role: 'assistant', content: 'done' }], 2),
      { id: 'mem-session', cwd: process.cwd() },
    );

    const context = store.buildMemoryContext({ cwd: process.cwd() });
    assert.ok(typeof context === 'string');
    assert.ok(context.includes('Shared session memory'));
    assert.ok(context.includes('mem-sess')); // first 8 chars of id
  });

  it('memory cache: second call within TTL returns cached result', () => {
    store.save(
      makeSession([{ role: 'user', content: 'cache test' }], 1),
      { id: 'cache-session', cwd: process.cwd() },
    );

    const first = store.buildMemoryContext({ cwd: process.cwd() });
    const second = store.buildMemoryContext({ cwd: process.cwd() });

    // Should be the exact same reference (cached)
    assert.equal(first, second);
    assert.ok(store._memoryCacheTime > 0);
  });
});

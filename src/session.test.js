import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from './session.js';

describe('Session', () => {
  it('addUser() appends a user message', () => {
    const s = new Session({ systemPrompt: 'sys' });
    s.addUser('hello');
    const msgs = s.getMessages();
    const userMsgs = msgs.filter(m => m.role === 'user');
    assert.equal(userMsgs.length, 1);
    assert.equal(userMsgs[0].content, 'hello');
  });

  it('addAssistant() appends an assistant message', () => {
    const s = new Session({ systemPrompt: 'sys' });
    s.addAssistant('reply');
    const msgs = s.getMessages();
    const assistantMsgs = msgs.filter(m => m.role === 'assistant');
    assert.equal(assistantMsgs.length, 1);
    assert.equal(assistantMsgs[0].content, 'reply');
  });

  it('getMessages() includes system message at index 0', () => {
    const s = new Session({ systemPrompt: 'you are helpful' });
    s.addUser('hi');
    const msgs = s.getMessages();
    assert.equal(msgs[0].role, 'system');
    assert.match(msgs[0].content, /you are helpful/);
  });

  it('fork() creates an independent copy', () => {
    const s = new Session({ systemPrompt: 'base' });
    s.addUser('msg1');
    s.addAssistant('reply1');

    const forked = s.fork();
    forked.addUser('msg2');

    // Original should not contain msg2
    const origUsers = s.getMessages().filter(m => m.role === 'user');
    assert.equal(origUsers.length, 1);
    // Forked should have both
    const forkUsers = forked.getMessages().filter(m => m.role === 'user');
    assert.equal(forkUsers.length, 2);
  });

  it('fork() does not create duplicate system messages', () => {
    const s = new Session({ systemPrompt: 'sys prompt' });
    s.addUser('q');
    s.addAssistant('a');

    const forked = s.fork();
    const msgs = forked.getMessages();
    const sysMsgs = msgs.filter(m => m.role === 'system');
    assert.equal(sysMsgs.length, 1);
  });

  it('setCwd() updates the system prompt', () => {
    const s = new Session({ systemPrompt: 'base', cwd: '/old' });
    s.addUser('hi');
    s.setCwd('/new/path');
    const msgs = s.getMessages();
    assert.match(msgs[0].content, /\/new\/path/);
  });

  it('history truncation when messages exceed maxHistory', () => {
    const s = new Session({ systemPrompt: 'sys', maxHistory: 4 });
    for (let i = 0; i < 10; i++) {
      s.addUser(`u${i}`);
      s.addAssistant(`a${i}`);
    }
    const msgs = s.getMessages();
    // Should be system + maxHistory messages
    assert.equal(msgs.length, 5); // 1 system + 4 recent
    assert.equal(msgs[0].role, 'system');
    // The last message should be the most recent assistant reply
    assert.equal(msgs[msgs.length - 1].content, 'a9');
  });
});

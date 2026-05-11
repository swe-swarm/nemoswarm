import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ClusterManager } from './cluster.js';

describe('ClusterManager', () => {
  // Create a minimal instance — we won't do real SSH or health checks
  function makeManager() {
    const nodes = [
      { name: 'local', host: '127.0.0.1', port: 30000, user: 'test', role: 'orchestrator' },
    ];
    return new ClusterManager(nodes, 'local');
  }

  describe('_shellQuote()', () => {
    it('wraps a simple string in single quotes', () => {
      const cm = makeManager();
      assert.equal(cm._shellQuote('hello'), "'hello'");
    });

    it('escapes embedded single quotes', () => {
      const cm = makeManager();
      const result = cm._shellQuote("it's");
      // Standard POSIX: close quote, backslash-escape quote, reopen
      assert.equal(result, "'it'\\''s'");
    });

    it('strips newlines and other control characters', () => {
      const cm = makeManager();
      const result = cm._shellQuote('abc\ndef\tghi');
      assert.ok(!result.includes('\n'), 'should not contain newline');
      assert.ok(!result.includes('\t'), 'should not contain tab');
      assert.match(result, /abcdefghi/);
    });

    it('strips null bytes', () => {
      const cm = makeManager();
      const result = cm._shellQuote('ab\x00cd');
      assert.ok(!result.includes('\x00'));
      assert.match(result, /abcd/);
    });

    it('handles empty / null input', () => {
      const cm = makeManager();
      assert.equal(cm._shellQuote(''), "''");
      assert.equal(cm._shellQuote(null), "''");
      assert.equal(cm._shellQuote(undefined), "''");
    });
  });

  describe('_validateSshInput()', () => {
    it('rejects strings containing null bytes', () => {
      const cm = makeManager();
      assert.throws(
        () => cm._validateSshInput('bad\x00input', 'field'),
        /null bytes/,
      );
    });

    it('accepts normal strings', () => {
      const cm = makeManager();
      assert.doesNotThrow(() => cm._validateSshInput('normal text', 'field'));
    });

    it('accepts null/undefined without throwing', () => {
      const cm = makeManager();
      assert.doesNotThrow(() => cm._validateSshInput(null, 'field'));
      assert.doesNotThrow(() => cm._validateSshInput(undefined, 'field'));
    });

    it('rejects strings with excessive control characters', () => {
      const cm = makeManager();
      // More than 10% control chars relative to string length
      const bad = '\x01\x02\x03ab';
      assert.throws(
        () => cm._validateSshInput(bad, 'field'),
        /suspicious control characters/,
      );
    });
  });

  describe('status()', () => {
    it('reports LLM and voice health separately', async () => {
      const cm = makeManager();
      cm.checkNode = async () => true;
      cm.checkVoice = async () => false;

      const status = await cm.status();

      assert.equal(status.nodes[0].healthy, true);
      assert.equal(status.nodes[0].voiceHealthy, false);
      assert.equal(status.nodes[0].voicePort, 8998);
      assert.equal(status.healthyRemotes, 0);
      assert.equal(status.voiceHealthyRemotes, 0);
    });
  });
});

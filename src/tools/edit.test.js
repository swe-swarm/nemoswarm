import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { executeEdit } from './edit.js';

describe('edit tool', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'edit-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('performs a successful find-and-replace (single occurrence)', async () => {
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'hello world\n');
    const result = await executeEdit(
      { path: file, old_str: 'hello', new_str: 'goodbye' },
      { cwd: dir },
    );
    assert.ok(result.output);
    assert.match(result.output, /Edited/);
    assert.equal(readFileSync(file, 'utf-8'), 'goodbye world\n');
  });

  it('returns error when pattern is not found', async () => {
    const file = join(dir, 'b.txt');
    writeFileSync(file, 'hello world\n');
    const result = await executeEdit(
      { path: file, old_str: 'notfound', new_str: 'x' },
      { cwd: dir },
    );
    assert.ok(result.error);
    assert.match(result.error, /not found/i);
  });

  it('returns error when pattern matches multiple occurrences', async () => {
    const file = join(dir, 'c.txt');
    writeFileSync(file, 'aaa bbb aaa\n');
    const result = await executeEdit(
      { path: file, old_str: 'aaa', new_str: 'zzz' },
      { cwd: dir },
    );
    assert.ok(result.error);
    assert.match(result.error, /2 occurrences/);
  });

  it('writes via temp file + rename (atomic write)', async () => {
    const file = join(dir, 'd.txt');
    writeFileSync(file, 'alpha beta\n');
    await executeEdit(
      { path: file, old_str: 'alpha', new_str: 'gamma' },
      { cwd: dir },
    );
    // After a successful edit the temp file should not linger
    assert.ok(!existsSync(`${file}.tmp`), 'temp file should be cleaned up after rename');
    assert.equal(readFileSync(file, 'utf-8'), 'gamma beta\n');
  });

  it('resolves relative paths against cwd', async () => {
    const file = join(dir, 'rel.txt');
    writeFileSync(file, 'one two three\n');
    const result = await executeEdit(
      { path: 'rel.txt', old_str: 'two', new_str: 'TWO' },
      { cwd: dir },
    );
    assert.ok(result.output);
    assert.equal(readFileSync(file, 'utf-8'), 'one TWO three\n');
  });
});

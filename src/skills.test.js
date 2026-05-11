import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SkillSystem } from './skills.js';

describe('SkillSystem', () => {
  const skills = new SkillSystem();

  it('loads built-in skills from the skills/ directory', () => {
    // The skills/ dir has YAML files like commit.yaml, test.yaml, etc.
    assert.ok(skills.skills.size > 0, 'should load at least one built-in skill');
    assert.ok(skills.has('commit'), 'should have the "commit" built-in skill');
  });

  it('list() returns all loaded skills', () => {
    const list = skills.list();
    assert.ok(Array.isArray(list));
    assert.ok(list.length > 0);

    const first = list[0];
    assert.ok(typeof first.name === 'string');
    assert.ok(typeof first.description === 'string');
    assert.ok(first.source === 'builtin' || first.source === 'user');
  });

  it('get() retrieves a specific skill', () => {
    const commit = skills.get('commit');
    assert.ok(commit);
    assert.equal(commit.name, 'commit');
    assert.ok(commit.prompt, 'skill should have a prompt');
    assert.equal(commit._source, 'builtin');
  });

  it('get() returns null for unknown skill', () => {
    const missing = skills.get('nonexistent-skill-xyz');
    assert.equal(missing, null);
  });

  it('expand() replaces {{args}} in prompt', () => {
    const result = skills.expand('commit', 'fix: typo in readme');
    assert.ok(result);
    assert.ok(typeof result.prompt === 'string');
    assert.ok(result.prompt.includes('fix: typo in readme'));
    assert.ok(!result.prompt.includes('{{args}}'));
  });

  it('expand() with no args replaces {{args}} with empty string', () => {
    const result = skills.expand('commit');
    assert.ok(result);
    assert.ok(!result.prompt.includes('{{args}}'));
    // Prompt should still contain the core skill instructions
    assert.ok(result.prompt.includes('commit'));
  });

  it('expand() returns null for unknown skill', () => {
    const result = skills.expand('nonexistent-skill-xyz', 'some args');
    assert.equal(result, null);
  });
});

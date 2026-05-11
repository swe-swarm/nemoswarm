import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ToolPermissions } from './permissions.js';

describe('ToolPermissions', () => {
  describe('isAllowed()', () => {
    it('exact match: "bash" matches "bash"', () => {
      const tp = new ToolPermissions({ allowedTools: ['bash'] });
      assert.ok(tp.isAllowed('bash'));
    });

    it('glob pattern: "bash(git:*)" matches "bash(git:push)"', () => {
      const tp = new ToolPermissions({ allowedTools: ['bash(git:*)'] });
      assert.ok(tp.isAllowed('bash(git:push)'));
    });

    it('glob pattern: "bash(git:*)" does NOT match "bash(npm:install)"', () => {
      const tp = new ToolPermissions({ allowedTools: ['bash(git:*)'] });
      assert.ok(!tp.isAllowed('bash(npm:install)'));
    });

    it('allowAll flag allows any tool', () => {
      const tp = new ToolPermissions({ allowAll: true });
      assert.ok(tp.isAllowed('anything'));
    });

    it('regex metacharacters in patterns are treated as literals', () => {
      // The pattern contains parens and colon — should be escaped, not treated as regex groups
      const tp = new ToolPermissions({ allowedTools: ['bash(git:*)'] });
      // Should NOT match a crafted string that would match an unescaped regex
      assert.ok(!tp.isAllowed('bashXgitYpush'));
    });
  });

  describe('isDenied()', () => {
    it('exact match denies correctly', () => {
      const tp = new ToolPermissions({ deniedTools: ['rm'] });
      assert.ok(tp.isDenied('rm'));
      assert.ok(!tp.isDenied('ls'));
    });

    it('glob pattern denies matching tools', () => {
      const tp = new ToolPermissions({ deniedTools: ['bash(rm:*)'] });
      assert.ok(tp.isDenied('bash(rm:rf)'));
      assert.ok(!tp.isDenied('bash(git:push)'));
    });
  });

  describe('isExcluded()', () => {
    it('excludes tools in excludedTools set', () => {
      const tp = new ToolPermissions({ excludedTools: ['voice'] });
      assert.ok(tp.isExcluded('voice'));
      assert.ok(!tp.isExcluded('bash'));
    });

    it('excludes tools not in availableTools when availableTools is set', () => {
      const tp = new ToolPermissions({ availableTools: new Set(['bash', 'edit']) });
      assert.ok(tp.isExcluded('voice'));
      assert.ok(!tp.isExcluded('bash'));
    });
  });

  describe('filterTools()', () => {
    it('removes excluded and denied tools', () => {
      const tp = new ToolPermissions({
        excludedTools: ['voice'],
        deniedTools: ['rm'],
      });
      const tools = [
        { function: { name: 'bash' } },
        { function: { name: 'voice' } },
        { function: { name: 'rm' } },
        { function: { name: 'edit' } },
      ];
      const filtered = tp.filterTools(tools);
      const names = filtered.map(t => t.function.name);
      assert.deepEqual(names, ['bash', 'edit']);
    });

    it('handles tools with top-level name property', () => {
      const tp = new ToolPermissions({ deniedTools: ['rm'] });
      const tools = [{ name: 'rm' }, { name: 'bash' }];
      const filtered = tp.filterTools(tools);
      assert.equal(filtered.length, 1);
      assert.equal(filtered[0].name, 'bash');
    });
  });
});

// View tool — read files and directories
import { readFileSync, statSync, readdirSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';

function resolvePath(filePath, cwd) {
  if (!filePath) return cwd;
  return isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
}

export async function executeView(args, opts = {}) {
  const { path: filePath, start_line, end_line } = args;
  const cwd = opts.cwd || process.cwd();
  const resolvedPath = resolvePath(filePath, cwd);

  try {
    const stat = statSync(resolvedPath);

    if (stat.isDirectory()) {
      return { output: listDirectory(resolvedPath, 0, 2) };
    }

    if (stat.size > 1024 * 1024) {
      return { error: `File too large: ${(stat.size / 1024).toFixed(0)} KB. Use start_line/end_line to read portions.` };
    }

    const content = readFileSync(resolvedPath, 'utf-8');
    const lines = content.split('\n');

    const start = (start_line || 1) - 1;
    const end = end_line === -1 ? lines.length : (end_line || lines.length);
    const selected = lines.slice(start, end);

    const numbered = selected.map((line, i) => `${start + i + 1}. ${line}`).join('\n');
    return { output: numbered };
  } catch (err) {
    return { error: `Cannot read ${resolvedPath}: ${err.message}` };
  }
}

function listDirectory(dir, depth, maxDepth) {
  if (depth >= maxDepth) return '';
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter(e => !e.name.startsWith('.'))
    .sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

  let result = '';
  for (const entry of entries) {
    const indent = '  '.repeat(depth);
    const suffix = entry.isDirectory() ? '/' : '';
    result += `${indent}${entry.name}${suffix}\n`;
    if (entry.isDirectory() && depth < maxDepth - 1) {
      result += listDirectory(join(dir, entry.name), depth + 1, maxDepth);
    }
  }
  return result.trimEnd();
}

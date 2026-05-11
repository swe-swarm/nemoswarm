// Create tool — create new files
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, isAbsolute, resolve } from 'path';

function resolvePath(filePath, cwd) {
  return isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
}

export async function executeCreate(args, opts = {}) {
  const { path: filePath, content } = args;
  const resolvedPath = resolvePath(filePath, opts.cwd || process.cwd());

  try {
    const dir = dirname(resolvedPath);
    mkdirSync(dir, { recursive: true });

    writeFileSync(resolvedPath, content, { encoding: 'utf-8', flag: 'wx' });
    const lines = content.split('\n').length;
    return { output: `Created ${resolvedPath} (${lines} lines)` };
  } catch (err) {
    if (err.code === 'EEXIST') {
      return { error: `File already exists: ${resolvedPath}. Use edit tool to modify existing files.` };
    }
    return { error: `Create failed: ${err.message}` };
  }
}

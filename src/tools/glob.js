// Glob tool — file pattern matching
import { glob as globFn } from 'glob';
import { isAbsolute, resolve } from 'path';

function resolvePath(filePath, cwd) {
  if (!filePath) return cwd;
  return isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
}

export async function executeGlob(args, opts = {}) {
  const { pattern, path: basePath } = args;
  const cwd = resolvePath(basePath, opts.cwd || process.cwd());

  try {
    const matches = await globFn(pattern, {
      cwd,
      absolute: true,
      nodir: false,
      dot: false,
      ignore: ['**/node_modules/**', '**/.git/**'],
    });

    if (matches.length === 0) {
      return { output: 'No files matched the pattern' };
    }

    const limited = matches.slice(0, 100);
    let result = limited.join('\n');
    if (matches.length > 100) {
      result += `\n\n... and ${matches.length - 100} more files`;
    }
    return { output: result };
  } catch (err) {
    return { error: `Glob failed: ${err.message}` };
  }
}

// Grep tool — code search via ripgrep
import { spawn } from 'child_process';
import { isAbsolute, resolve } from 'path';

function resolvePath(filePath, cwd) {
  if (!filePath) return cwd;
  return isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
}

export async function executeGrep(args, opts = {}) {
  const { pattern, path: searchPath, glob: globPattern, ignore_case, max_results = 50 } = args;
  const cwd = resolvePath(searchPath, opts.cwd || process.cwd());

  const rgArgs = ['--no-heading', '--line-number', '--color=never', '-m', String(max_results)];
  if (ignore_case) rgArgs.push('-i');
  if (globPattern) rgArgs.push('-g', globPattern);
  rgArgs.push(pattern, cwd);

  return new Promise((resolve) => {
    let output = '';
    const proc = spawn('rg', rgArgs, { timeout: 10000 });

    proc.stdout.on('data', (data) => { output += data.toString(); });
    proc.stderr.on('data', (data) => { output += data.toString(); });

    proc.on('error', () => {
      // Fallback to grep if rg not available
      const grepArgs = ['-rn', '--color=never'];
      if (ignore_case) grepArgs.push('-i');
      if (globPattern) grepArgs.push('--include', globPattern);
      grepArgs.push(pattern, cwd);

      let grepOut = '';
      const grepProc = spawn('grep', grepArgs, { timeout: 10000 });
      grepProc.stdout.on('data', (d) => { grepOut += d.toString(); });
      grepProc.on('close', () => {
        const lines = grepOut.trim().split('\n').slice(0, max_results);
        resolve({ output: lines.join('\n') || 'No matches found' });
      });
    });

    proc.on('close', (code) => {
      const trimmed = output.trim();
      resolve({ output: trimmed || 'No matches found' });
    });
  });
}

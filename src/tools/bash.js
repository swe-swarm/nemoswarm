// Bash tool — execute shell commands
import { spawn } from 'child_process';

export async function executeBash(args, opts = {}) {
  const { command, timeout = 30 } = args;
  const cwd = opts.cwd || process.cwd();
  const cwdMarker = `__NEMO_CWD__${Date.now()}__`;
  const wrappedCommand = `{ ${command}\n}; status=$?; printf '\\n${cwdMarker}%s\\n' \"$PWD\"; exit $status`;

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let resolved = false;

    const proc = spawn('bash', ['-lc', wrappedCommand], {
      cwd,
      timeout: timeout * 1000,
      maxBuffer: 1024 * 1024 * 10,
      env: { ...process.env, GIT_PAGER: '', PAGER: '' },
    });

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({ output: '', error: err.message });
    });

    proc.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);

      let nextCwd = cwd;
      const markerIndex = stdout.lastIndexOf(cwdMarker);
      if (markerIndex !== -1) {
        nextCwd = stdout.slice(markerIndex + cwdMarker.length).trim() || cwd;
        stdout = stdout.slice(0, markerIndex).replace(/\s+$/, '');
      }

      const output = (stdout + (stderr ? `\n${stderr}` : '')).trim();
      if (output.length > 50000) {
        resolve({
          output: output.slice(0, 25000) + '\n\n... [truncated] ...\n\n' + output.slice(-25000),
          exitCode: code,
          cwd: nextCwd,
        });
      } else {
        resolve({ output, exitCode: code, cwd: nextCwd });
      }
    });

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      proc.kill('SIGTERM');
      resolve({ output: stdout.trim(), error: `Command timed out after ${timeout}s`, exitCode: -1, cwd });
    }, timeout * 1000);
  });
}

// Edit tool — find and replace strings in files
import { readFileSync, writeFileSync, renameSync } from 'fs';
import { isAbsolute, resolve } from 'path';

function resolvePath(filePath, cwd) {
  return isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
}

export async function executeEdit(args, opts = {}) {
  const { path: filePath, old_str, new_str } = args;
  const resolvedPath = resolvePath(filePath, opts.cwd || process.cwd());

  try {
    const content = readFileSync(resolvedPath, 'utf-8');
    const occurrences = content.split(old_str).length - 1;

    if (occurrences === 0) {
      return { error: `String not found in ${resolvedPath}` };
    }
    if (occurrences > 1) {
      return { error: `Found ${occurrences} occurrences of the string in ${resolvedPath}. Must match exactly once. Add more context to make it unique.` };
    }

    const updated = content.replace(old_str, new_str);
    const tmpPath = `${resolvedPath}.tmp`;
    writeFileSync(tmpPath, updated, 'utf-8');
    renameSync(tmpPath, resolvedPath);

    // Show a small diff context
    const oldLines = old_str.split('\n');
    const newLines = new_str.split('\n');
    let diff = '';
    for (const line of oldLines) diff += `- ${line}\n`;
    for (const line of newLines) diff += `+ ${line}\n`;

    return { output: `Edited ${resolvedPath}\n${diff.trim()}` };
  } catch (err) {
    return { error: `Edit failed: ${err.message}` };
  }
}

// Tool registry — defines all tools and dispatches execution
import { executeBash } from './bash.js';
import { executeView } from './view.js';
import { executeEdit } from './edit.js';
import { executeCreate } from './create.js';
import { executeGrep } from './grep.js';
import { executeGlob } from './glob.js';

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Execute a bash command and return its output. Directory changes persist for the current Nemo session. Use for running tests, builds, git commands, installing packages, or any shell operation.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The bash command to execute' },
          timeout: { type: 'number', description: 'Timeout in seconds (default: 30)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'view',
      description: 'View file contents or directory listing. Relative paths resolve from the current working directory. For files, returns content with line numbers. For directories, returns a tree listing.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File or directory path, absolute or relative to the current working directory' },
          start_line: { type: 'number', description: 'Start line (1-indexed, optional)' },
          end_line: { type: 'number', description: 'End line (optional, -1 for end of file)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit',
      description: 'Replace a string in a file. Relative paths resolve from the current working directory. The old_str must match exactly one occurrence in the file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path, absolute or relative to the current working directory' },
          old_str: { type: 'string', description: 'The exact string to find and replace' },
          new_str: { type: 'string', description: 'The replacement string' },
        },
        required: ['path', 'old_str', 'new_str'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create',
      description: 'Create a new file with the given content. Relative paths resolve from the current working directory. The file must not already exist.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path, absolute or relative to the current working directory' },
          content: { type: 'string', description: 'File content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search file contents using ripgrep. Returns matching lines with file paths and line numbers.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          path: { type: 'string', description: 'Directory or file to search in (default: cwd)' },
          glob: { type: 'string', description: 'File glob filter (e.g. "*.js", "*.py")' },
          ignore_case: { type: 'boolean', description: 'Case insensitive search' },
          max_results: { type: 'number', description: 'Max results to return (default: 50)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Find files matching a glob pattern. Returns list of matching file paths.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.js", "src/**/*.test.ts")' },
          path: { type: 'string', description: 'Base directory to search from (default: cwd)' },
        },
        required: ['pattern'],
      },
    },
  },
];

const EXECUTORS = {
  bash: executeBash,
  view: executeView,
  edit: executeEdit,
  create: executeCreate,
  grep: executeGrep,
  glob: executeGlob,
};

export async function executeTool(name, args, opts = {}) {
  const executor = EXECUTORS[name];
  if (!executor) return { error: `Unknown tool: ${name}` };

  try {
    const result = await executor(typeof args === 'string' ? JSON.parse(args) : args, opts);
    return result;
  } catch (err) {
    return { error: `Tool ${name} failed: ${err.message}` };
  }
}

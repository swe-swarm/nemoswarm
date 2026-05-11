// Tool permissions — allow/deny system with interactive confirmation
import chalk from 'chalk';
import readline from 'readline';

export class ToolPermissions {
  constructor(opts = {}) {
    this.allowAll = opts.allowAll || false;
    this.allowedTools = new Set(opts.allowedTools || []);
    this.deniedTools = new Set(opts.deniedTools || []);
    this.excludedTools = new Set(opts.excludedTools || []);
    this.availableTools = opts.availableTools || null; // null = all
    this.approvedThisSession = new Set();
    this.interactive = opts.interactive !== false;

    // Pre-compile glob patterns to RegExp for performance and safety
    this._compiledPatterns = new Map();
    for (const pattern of [...this.allowedTools, ...this.deniedTools]) {
      if (pattern.includes('*')) {
        this._compiledPatterns.set(pattern, this._compilePattern(pattern));
      }
    }
  }

  isExcluded(toolName) {
    if (this.excludedTools.has(toolName)) return true;
    if (this.availableTools && !this.availableTools.has(toolName)) return true;
    return false;
  }

  isDenied(toolName) {
    // Check exact match
    if (this.deniedTools.has(toolName)) return true;
    // Check pattern match (e.g. "bash(git push)" denied by "bash(git:*)")
    for (const pattern of this.deniedTools) {
      if (this._matchPattern(pattern, toolName)) return true;
    }
    return false;
  }

  isAllowed(toolName) {
    if (this.allowAll) return true;
    if (this.approvedThisSession.has(toolName)) return true;
    if (this.allowedTools.has(toolName)) return true;
    // Check pattern match
    for (const pattern of this.allowedTools) {
      if (this._matchPattern(pattern, toolName)) return true;
    }
    return false;
  }

  _escapeRegex(str) {
    return str.replace(/[()[\]{}+?.\\^$|]/g, '\\$&');
  }

  _compilePattern(pattern) {
    const escaped = this._escapeRegex(pattern);
    return new RegExp('^' + escaped.replace(/\*/g, '.*') + '$');
  }

  _matchPattern(pattern, toolName) {
    if (!pattern.includes('*')) return pattern === toolName;
    let regex = this._compiledPatterns.get(pattern);
    if (!regex) {
      regex = this._compilePattern(pattern);
      this._compiledPatterns.set(pattern, regex);
    }
    return regex.test(toolName);
  }

  async checkPermission(toolName, args, ui) {
    if (this.isExcluded(toolName)) {
      return { allowed: false, reason: 'Tool is excluded' };
    }
    if (this.isDenied(toolName)) {
      return { allowed: false, reason: 'Tool is denied' };
    }
    if (this.isAllowed(toolName)) {
      return { allowed: true };
    }

    // Interactive confirmation
    if (!this.interactive) {
      return { allowed: false, reason: 'Tool not allowed in non-interactive mode. Use --allow-all-tools.' };
    }

    const argsStr = typeof args === 'string' ? args : JSON.stringify(args);
    const preview = argsStr.length > 200 ? argsStr.slice(0, 200) + '...' : argsStr;

    console.log(chalk.yellow(`\n  ⚠ Tool: ${chalk.bold(toolName)}`));
    console.log(chalk.dim(`    Args: ${preview}`));

    const answer = await this._ask('  Allow? (y)es / (n)o / (a)lways: ');
    const choice = answer.toLowerCase().trim();

    if (choice === 'y' || choice === 'yes') {
      return { allowed: true };
    } else if (choice === 'a' || choice === 'always') {
      this.approvedThisSession.add(toolName);
      return { allowed: true };
    }
    return { allowed: false, reason: 'User denied' };
  }

  _ask(question) {
    return new Promise((resolve) => {
      let settled = false;
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        rl.close();
        resolve('');
      }, 30000);
      rl.on('close', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve('');
      });
      rl.question(chalk.yellow(question), (answer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rl.close();
        resolve(answer);
      });
    });
  }

  // Filter tool definitions based on permissions
  filterTools(tools) {
    return tools.filter(t => {
      const name = t.function?.name || t.name;
      return !this.isExcluded(name) && !this.isDenied(name);
    });
  }
}

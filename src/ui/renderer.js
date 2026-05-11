// Terminal UI — rendering, spinner, thinking display, and interactive prompt
import chalk from 'chalk';
import { InteractiveInput } from './input.js';

export class TerminalUI {
  constructor() {
    this.input = new InteractiveInput();
    this.spinnerInterval = null;
    this.spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    this.spinnerIdx = 0;
    this.inThinking = false;
    this.thinkLineLen = 0;
  }

  // Call after skills/agents/commands are ready, before the REPL starts
  setSlashItems(items) {
    this.input.setItems(items);
  }

  init() {
    // Nothing to set up — InteractiveInput manages its own stdin lifecycle per-prompt
  }

  async prompt() {
    return this.input.read();
  }

  // ── Spinner ───────────────────────────────────────────────────────────────

  startSpinner(text = 'Thinking') {
    this.spinnerIdx = 0;
    process.stdout.write('\n');
    this.spinnerInterval = setInterval(() => {
      const frame = this.spinnerFrames[this.spinnerIdx % this.spinnerFrames.length];
      process.stdout.write(`\r${chalk.yellow(frame)} ${chalk.dim(text)}...`);
      this.spinnerIdx++;
    }, 80);
  }

  stopSpinner() {
    if (this.spinnerInterval) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = null;
      process.stdout.write('\r' + ' '.repeat(60) + '\r');
    }
  }

  // ── Chain-of-Thought / Thinking ───────────────────────────────────────────

  startThinking() {
    this.inThinking = true;
    this.thinkLineLen = 0;
    process.stdout.write(
      '\n' + chalk.dim('  ┌─ ') + chalk.dim.italic('reasoning') + chalk.dim(' ──────────────────────────────────────\n')
    );
    process.stdout.write(chalk.dim('  │ '));
  }

  streamThinkToken(token) {
    if (!token) return;
    const WRAP = 90;
    for (const ch of token) {
      if (ch === '\n') {
        process.stdout.write('\n' + chalk.dim('  │ '));
        this.thinkLineLen = 0;
      } else {
        if (this.thinkLineLen >= WRAP) {
          process.stdout.write('\n' + chalk.dim('  │ '));
          this.thinkLineLen = 0;
        }
        process.stdout.write(chalk.dim(ch));
        this.thinkLineLen++;
      }
    }
  }

  stopThinking() {
    this.inThinking = false;
    this.thinkLineLen = 0;
    process.stdout.write('\n' + chalk.dim('  └───────────────────────────────────────────────\n'));
  }

  // ── Response streaming ────────────────────────────────────────────────────

  streamToken(token) {
    process.stdout.write(token);
  }

  // ── Tool display ──────────────────────────────────────────────────────────

  toolStart(name, args) {
    const argsStr = typeof args === 'string' ? args : JSON.stringify(args);
    const preview = argsStr.length > 120 ? argsStr.slice(0, 120) + '...' : argsStr;
    console.log(chalk.dim(`\n  ⚡ ${chalk.yellow(name)} ${preview}`));
  }

  toolResult(name, result) {
    if (result.error) {
      console.log(chalk.dim(`  ${chalk.red('✗')} ${name}: ${result.error.slice(0, 200)}`));
    } else {
      const output = result.output || '';
      const lines = output.split('\n').length;
      console.log(chalk.dim(`  ${chalk.green('✓')} ${name} (${lines} lines)`));
    }
  }

  // ── Text output ───────────────────────────────────────────────────────────

  printAssistant(content) {
    if (!content) return;
    console.log('\n' + content);
  }

  printError(msg) {
    console.log(chalk.red(`\n  ✗ ${msg}`));
  }

  printInfo(msg) {
    console.log(chalk.dim(`\n  ${msg}`));
  }

  printWarning(msg) {
    console.log(chalk.yellow(`\n  ⚠ ${msg}`));
  }

  // ── Swarm display ─────────────────────────────────────────────────────────

  swarmHeader(name, description, roles = []) {
    console.log('');
    console.log(chalk.bold.magenta('  ◆ Swarm: ') + chalk.bold.white(name));
    if (description) console.log(chalk.dim('  ' + description.trim()));
    if (roles.length) {
      console.log(chalk.dim('  Sub-agents: ') + roles.map(r => chalk.magenta(r)).join(chalk.dim(' · ')));
    }
    console.log(chalk.dim('  ' + '─'.repeat(52)));
    console.log('');
  }

  subAgentHeader(role, displayName, index, total) {
    console.log('');
    const label = `  ┌─ [${index}/${total}] ${displayName || role} `;
    const pad = Math.max(0, 54 - label.replace(/\x1b\[[0-9;]*m/g, '').length);
    console.log(chalk.magenta(label) + chalk.dim('─'.repeat(pad)));
  }

  subAgentFooter(role) {
    console.log(chalk.dim(`  └─ ${role} done `) + chalk.dim('─'.repeat(48 - role.length)));
  }

  // ── Branding ──────────────────────────────────────────────────────────────

  splash() {
    console.log('');
    console.log(chalk.bold.green('  ⚡ Nemo') + chalk.bold(' CLI') + chalk.dim(' — Nemotron-powered terminal agent'));
    console.log(chalk.dim('  Running 100% locally. No data leaves this machine.'));
    console.log(chalk.dim('  Type /help for commands, /skills for skills.\n'));
  }

  statusBar(config) {
    console.log(chalk.dim(`  Model: ${chalk.white(config.model)} | Server: ${chalk.white(config.baseUrl)}`));
  }

  // ── Voice mode ────────────────────────────────────────────────────────────

  // Call from /voice command handler to wait for user to press Enter (exits voice).
  // Raw mode is already off between prompts, so we just listen on stdin.
  pauseForVoice() {
    return new Promise((resolve) => {
      const onData = (data) => {
        // Enter key (bare \n or \r)
        if (data.includes('\n') || data.includes('\r')) {
          process.stdin.off('data', onData);
          process.stdin.pause();
          resolve();
        }
      };
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', onData);
    });
  }

  close() {
    this.stopSpinner();
    // stdin raw mode is cleaned up per-prompt by InteractiveInput
  }
}

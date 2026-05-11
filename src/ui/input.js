// Interactive raw-mode input with "/" suggestion panel, tab-complete, and history
// Falls back to basic readline when stdin is not a TTY (pipes, scripts).
import chalk from 'chalk';
import { createInterface as rlCreateInterface } from 'readline';

const MAX_SUGGESTIONS = 10;
const PROMPT = '❯ ';

function commonPrefix(strs) {
  if (!strs.length) return '';
  let prefix = strs[0];
  for (let i = 1; i < strs.length; i++) {
    while (!strs[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (!prefix) return '';
    }
  }
  return prefix;
}

export class InteractiveInput {
  constructor() {
    this.slashItems = []; // [{ trigger: '/commit', description: '...', category: '...' }]
    this.history = [];
  }

  setItems(items) {
    this.slashItems = items;
  }

  async read() {
    if (!process.stdin.isTTY) return this._readFallback();
    return this._readRaw();
  }

  // ── Fallback: basic readline for non-TTY (pipes, --prompt mode) ───────────
  _readFallback() {
    return new Promise((resolve) => {
      const rl = rlCreateInterface({ input: process.stdin, output: process.stdout });
      rl.question('\n' + PROMPT, (ans) => { rl.close(); resolve(ans.trim()); });
    });
  }

  // ── Raw mode REPL ─────────────────────────────────────────────────────────
  _readRaw() {
    return new Promise((resolve) => {
      let buf = '';           // current input buffer
      let renderedLines = 0; // how many suggestion lines are drawn below
      let suggestions = [];  // current suggestion list
      let selIdx = -1;        // selected suggestion index (-1 = none)
      let histIdx = -1;       // history position (-1 = live input)
      let savedBuf = '';      // save live input when navigating history

      const cols = () => process.stdout.columns || 100;

      // ── Suggestion matching ───────────────────────────────────────────────
      const getSuggestions = (text) => {
        if (!text.startsWith('/')) return [];
        const lower = text.toLowerCase();
        return this.slashItems
          .filter(it => it.trigger.toLowerCase().startsWith(lower))
          .slice(0, MAX_SUGGESTIONS);
      };

      // ── Terminal drawing ──────────────────────────────────────────────────

      // Erase the suggestion panel (cursor must be at end of prompt line after this)
      const clearBelow = () => {
        if (!renderedLines) return;
        for (let i = 0; i < renderedLines; i++) {
          process.stdout.write('\x1b[B\r\x1b[2K'); // move down, go to col 0, erase line
        }
        process.stdout.write(`\x1b[${renderedLines}A`); // move back up
        renderedLines = 0;
      };

      // Draw suggestion panel below the current prompt line.
      // Cursor is saved/restored so it stays at the end of the input.
      const drawSuggestions = (items, selectedIdx) => {
        if (!items.length) return;
        const w = cols();
        const trigW = Math.min(20, Math.max(...items.map(i => i.trigger.length)) + 2);

        process.stdout.write('\x1b[s'); // save cursor at end of input

        // Group label if first item has a category change
        let lastCat = null;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const cat = item.category || '';
          const isSelected = i === selectedIdx;
          const trigger = item.trigger.padEnd(trigW);
          const maxDesc = Math.max(0, w - trigW - 8);
          const desc = (item.description || '').slice(0, maxDesc);

          // Category separator
          if (cat && cat !== lastCat) {
            process.stdout.write('\n\r' + chalk.dim('  ─ ' + cat));
            renderedLines++;
            lastCat = cat;
          }

          process.stdout.write('\n\r');
          if (isSelected) {
            const row = ' ▶ ' + trigger + ' ' + desc.padEnd(maxDesc);
            process.stdout.write(chalk.bgBlue.white(row));
          } else {
            process.stdout.write(chalk.dim('   ') + chalk.cyan(trigger) + chalk.dim(desc));
          }
          renderedLines++;
        }

        // Hint line
        process.stdout.write(
          '\n\r' + chalk.dim('   tab·→ complete   ↑↓ select   esc dismiss')
        );
        renderedLines++;

        process.stdout.write('\x1b[u'); // restore cursor to end of input
      };

      // Full redraw: clear suggestions, rewrite prompt+buf, redraw suggestions
      const render = () => {
        clearBelow();
        process.stdout.write('\r\x1b[K' + chalk.cyan.bold(PROMPT) + buf);
        suggestions = getSuggestions(buf);
        if (suggestions.length) {
          drawSuggestions(suggestions, selIdx);
        } else {
          selIdx = -1;
        }
      };

      // ── Commit input ──────────────────────────────────────────────────────
      const commit = (value) => {
        clearBelow();
        process.stdout.write('\r\x1b[K' + chalk.cyan.bold(PROMPT) + value + '\n');
        cleanup();
        const trimmed = value.trim();
        if (trimmed) {
          this.history.unshift(trimmed);
          if (this.history.length > 200) this.history.pop();
        }
        resolve(trimmed);
      };

      const cleanup = () => {
        try { process.stdin.setRawMode(false); } catch {}
        process.stdin.removeListener('data', onData);
      };

      // ── Key handler ───────────────────────────────────────────────────────
      const onData = (data) => {
        const bytes = [...data];
        const b0 = bytes[0];
        const str = data.toString('utf8');

        // Ctrl+C
        if (b0 === 0x03) {
          clearBelow();
          process.stdout.write('^C\n');
          cleanup();
          process.exit(0);
        }

        // Ctrl+D (EOF)
        if (b0 === 0x04) {
          clearBelow();
          process.stdout.write('\n');
          cleanup();
          resolve(null);
          return;
        }

        // Enter (CR or LF)
        if (b0 === 0x0d || b0 === 0x0a) {
          if (selIdx >= 0 && suggestions[selIdx]) buf = suggestions[selIdx].trigger;
          commit(buf);
          return;
        }

        // Tab — autocomplete
        if (b0 === 0x09) {
          const sug = getSuggestions(buf);
          if (!sug.length) return;
          if (sug.length === 1) {
            buf = sug[0].trigger + ' ';
            selIdx = -1;
          } else {
            const prefix = commonPrefix(sug.map(s => s.trigger));
            if (prefix.length > buf.length) {
              buf = prefix;
              selIdx = -1;
            } else {
              // Cycle through suggestions on repeated Tab
              selIdx = (selIdx + 1) % sug.length;
            }
          }
          render();
          return;
        }

        // ESC / escape sequences
        if (b0 === 0x1b) {
          if (bytes.length === 1) {
            // Plain ESC — dismiss suggestion panel
            clearBelow();
            renderedLines = 0;
            selIdx = -1;
            process.stdout.write('\r\x1b[K' + chalk.cyan.bold(PROMPT) + buf);
            return;
          }

          // CSI sequences: ESC [ ...
          if (bytes[1] === 0x5b) {
            const code = bytes[2];

            // Up arrow
            if (code === 0x41) {
              if (buf.startsWith('/') && suggestions.length) {
                selIdx = selIdx <= 0 ? suggestions.length - 1 : selIdx - 1;
                render();
              } else {
                if (histIdx === -1) savedBuf = buf;
                if (histIdx < this.history.length - 1) {
                  histIdx++;
                  buf = this.history[histIdx];
                  selIdx = -1;
                  render();
                }
              }
              return;
            }

            // Down arrow
            if (code === 0x42) {
              if (buf.startsWith('/') && suggestions.length) {
                selIdx = (selIdx + 1) % suggestions.length;
                render();
              } else {
                if (histIdx > -1) {
                  histIdx--;
                  buf = histIdx === -1 ? savedBuf : this.history[histIdx];
                  selIdx = -1;
                  render();
                }
              }
              return;
            }

            // Right arrow — accept top/selected suggestion
            if (code === 0x43) {
              if (buf.startsWith('/') && suggestions.length) {
                const pick = selIdx >= 0 ? suggestions[selIdx] : suggestions[0];
                buf = pick.trigger + ' ';
                selIdx = -1;
                render();
              }
              return;
            }

            // Left arrow / others — ignore (no inline cursor movement)
            return;
          }
          return;
        }

        // Backspace (DEL 0x7f or BS 0x08)
        if (b0 === 0x7f || b0 === 0x08) {
          if (buf.length) {
            buf = [...buf].slice(0, -1).join(''); // handles multi-byte chars
            selIdx = -1;
            render();
          }
          return;
        }

        // Ctrl+U — clear entire line
        if (b0 === 0x15) { buf = ''; selIdx = -1; render(); return; }

        // Ctrl+W — delete last word
        if (b0 === 0x17) { buf = buf.replace(/\S+\s*$/, ''); selIdx = -1; render(); return; }

        // Ctrl+L — clear screen and redraw
        if (b0 === 0x0c) {
          process.stdout.write('\x1b[2J\x1b[H');
          renderedLines = 0;
          render();
          return;
        }

        // Printable characters and multi-byte UTF-8
        if (b0 >= 0x20 || (b0 & 0x80)) {
          buf += str;
          selIdx = -1;
          render();
        }
      };

      // ── Start ─────────────────────────────────────────────────────────────
      process.stdout.write('\n' + chalk.cyan.bold(PROMPT));

      try {
        process.stdin.setRawMode(true);
      } catch {
        cleanup();
        this._readFallback().then(resolve);
        return;
      }

      process.stdin.resume();
      process.stdin.on('data', onData);
    });
  }
}

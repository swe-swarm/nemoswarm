// Session persistence — save/load/resume conversations
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

const SESSIONS_DIR = join(process.env.HOME || '', '.nemo-cli', 'sessions');

export class SessionStore {
  constructor() {
    if (!existsSync(SESSIONS_DIR)) {
      mkdirSync(SESSIONS_DIR, { recursive: true });
    }
    this._memoryCache = null;
    this._memoryCacheTime = 0;
  }

  save(session, metadata = {}) {
    const serialized = typeof session.serialize === 'function'
      ? session.serialize()
      : {
        messages: session.messages || [],
        turnCount: session.turnCount || 0,
        systemPrompt: session.systemPrompt || '',
        baseSystemPrompt: session.baseSystemPrompt || session.systemPrompt || '',
        sharedMemory: session.sharedMemory || '',
        maxHistory: session.maxHistory || 100,
      };

    const {
      id: metadataId,
      createdAt,
      cwd,
      model,
      summary,
      ...extra
    } = metadata;

    const id = metadataId || randomUUID();
    const data = {
      ...extra,
      id,
      cwd: cwd || serialized.cwd || process.cwd(),
      createdAt: createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      turnCount: serialized.turnCount,
      messages: serialized.messages,
      model: model || 'nemotron',
      summary: summary || this._extractSummaryFromMessages(serialized.messages),
      lastAssistant: this._extractLastAssistant(serialized.messages),
      systemPrompt: serialized.systemPrompt,
      baseSystemPrompt: serialized.baseSystemPrompt,
      sharedMemory: serialized.sharedMemory,
      sessionCwd: serialized.cwd || cwd || process.cwd(),
      maxHistory: serialized.maxHistory,
    };

    const finalPath = join(SESSIONS_DIR, `${id}.json`);
    const tmpPath = `${finalPath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    renameSync(tmpPath, finalPath);
    this._memoryCache = null;
    this._memoryCacheTime = 0;
    return id;
  }

  load(id) {
    const path = join(SESSIONS_DIR, `${id}.json`);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf-8'));
    } catch (err) {
      console.error('Failed to load session:', id, err.message);
      return null;
    }
  }

  getMostRecent(cwd = null) {
    const sessions = this.list();
    const filtered = cwd ? sessions.filter(s => s.cwd === cwd) : sessions;
    return filtered[0] ? this.load(filtered[0].id) : null;
  }

  list(limit = 20) {
    if (!existsSync(SESSIONS_DIR)) return [];
    const files = readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const path = join(SESSIONS_DIR, f);
        try {
          const stat = statSync(path);
          const data = JSON.parse(readFileSync(path, 'utf-8'));
          return {
            id: data.id,
            cwd: data.cwd,
            createdAt: data.createdAt,
            updatedAt: data.updatedAt,
            turnCount: data.turnCount,
            model: data.model,
            summary: data.summary,
            lastAssistant: data.lastAssistant || null,
            kind: data.kind || null,
            role: data.role || null,
            swarmId: data.swarmId || null,
            swarmName: data.swarmName || null,
            node: data.node || null,
            dispatchMode: data.dispatchMode || null,
            agentName: data.agentName || null,
            agentDisplayName: data.agentDisplayName || null,
            mtime: stat.mtimeMs,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
    return files.slice(0, limit);
  }

  getMemoryEntries(options = {}) {
    const {
      cwd = process.cwd(),
      limit = 8,
      excludeIds = [],
      allowCrossCwd = false,
    } = options;

    const excluded = new Set(excludeIds.filter(Boolean));
    const sessions = this.list(Math.max(limit * 4, 20));
    const filtered = sessions
      .filter((entry) => !excluded.has(entry.id))
      .filter((entry) => !cwd || entry.cwd === cwd)
      .slice(0, limit)
      .map((entry) => {
        const full = this.load(entry.id) || {};
        return {
          ...entry,
          summary: full.summary || entry.summary || '(empty session)',
          lastAssistant: full.lastAssistant || entry.lastAssistant || '',
        };
      });

    if (filtered.length > 0 || !cwd || !allowCrossCwd) {
      return filtered;
    }

    return sessions
      .filter((entry) => !excluded.has(entry.id))
      .slice(0, limit)
      .map((entry) => {
        const full = this.load(entry.id) || {};
        return {
          ...entry,
          summary: full.summary || entry.summary || '(empty session)',
          lastAssistant: full.lastAssistant || entry.lastAssistant || '',
        };
      });
  }

  buildMemoryContext(options = {}) {
    const now = Date.now();
    if (this._memoryCache && (now - this._memoryCacheTime) < 60_000) {
      return this._memoryCache;
    }

    const entries = this.getMemoryEntries(options);
    if (entries.length === 0) return '';

    const lines = ['Shared session memory from recent Nemo activity:'];
    for (const entry of entries) {
      const tags = [
        entry.kind,
        entry.agentName ? `agent=${entry.agentName}` : null,
        entry.role ? `role=${entry.role}` : null,
        entry.node ? `node=${entry.node}` : null,
        entry.cwd ? `cwd=${entry.cwd}` : null,
      ].filter(Boolean).join(', ');

      const summary = this._trim(entry.summary || '(empty session)', 140);
      const outcome = this._trim(entry.lastAssistant || '', 180);
      const prefix = `- [${entry.id.slice(0, 8)}] ${entry.updatedAt || entry.createdAt || ''}`;
      const meta = tags ? ` ${tags}` : '';

      lines.push(`${prefix}${meta}`);
      lines.push(`  Summary: ${summary}`);
      if (outcome) {
        lines.push(`  Latest outcome: ${outcome}`);
      }
    }

    const result = lines.join('\n');
    this._memoryCache = result;
    this._memoryCacheTime = now;
    return result;
  }

  _trim(text, maxLen) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    return normalized.length > maxLen ? `${normalized.slice(0, maxLen)}...` : normalized;
  }

  _extractSummaryFromMessages(messages = []) {
    const firstUser = messages.find(m => m.role === 'user');
    if (!firstUser) return '(empty session)';
    const text = firstUser.content || '';
    return this._trim(text, 100);
  }

  _extractLastAssistant(messages = []) {
    const assistants = messages.filter(m => m.role === 'assistant' && m.content);
    if (assistants.length === 0) return '';
    return this._trim(assistants[assistants.length - 1].content, 220);
  }
}

export function restoreSession(session, savedData) {
  session.cwd = savedData.cwd || savedData.sessionCwd || session.cwd || process.cwd();
  session.baseSystemPrompt = savedData.baseSystemPrompt || savedData.systemPrompt || session.baseSystemPrompt || session.systemPrompt;
  session.sharedMemory = savedData.sharedMemory || session.sharedMemory || '';
  session.maxHistory = savedData.maxHistory || session.maxHistory;
  session.messages = Array.isArray(savedData.messages) ? savedData.messages : [];
  session.turnCount = savedData.turnCount || 0;
  session.systemPrompt = [session.baseSystemPrompt, session.sharedMemory].filter(Boolean).join('\n\n');

  if (session.messages.length === 0 || session.messages[0].role !== 'system') {
    session.addSystem(session.baseSystemPrompt);
    if (session.sharedMemory) {
      session.setSharedMemory(session.sharedMemory);
    }
  } else if (session.messages[0].content !== session.systemPrompt) {
    session.messages[0] = { role: 'system', content: session.systemPrompt };
  }
}

export function refreshSessionMemory(session, store, options = {}) {
  if (!session?.setSharedMemory || !store?.buildMemoryContext) return '';
  const memory = store.buildMemoryContext(options);
  session.setSharedMemory(memory);
  return memory;
}

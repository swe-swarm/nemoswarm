// Skills system — slash-command macros that expand to full prompts
// Skills live in:
//   1. <repo>/skills/          — built-in bundled skills
//   2. ~/.nemo-cli/skills/     — user-installed skills
//
// Skill YAML format:
//   name:        commit
//   displayName: Generate Commit
//   description: Analyze staged changes and write a conventional commit message
//   prompt: |
//     <full prompt, {{args}} is replaced with user-supplied args>
//   tools: [bash, view]   # optional tool restrictions

import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __dir = dirname(fileURLToPath(import.meta.url));
const BUILTIN_SKILLS_DIR = join(__dir, '..', 'skills');
const USER_SKILLS_DIR = join(process.env.HOME || '', '.nemo-cli', 'skills');

export class SkillSystem {
  constructor() {
    this.skills = new Map(); // name -> skill data
    this._loadDir(BUILTIN_SKILLS_DIR, 'builtin');
    this._loadDir(USER_SKILLS_DIR, 'user');
  }

  _loadDir(dir, source) {
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))) {
      try {
        const data = yaml.load(readFileSync(join(dir, file), 'utf-8'));
        if (data?.name) {
          this.skills.set(data.name, { ...data, _source: source });
        }
      } catch (err) {
        console.error('Failed to load skill:', join(dir, file), err.message);
      }
    }
  }

  // Is this a known skill name?
  has(name) {
    return this.skills.has(name);
  }

  get(name) {
    return this.skills.get(name) || null;
  }

  list() {
    return Array.from(this.skills.values()).map(s => ({
      name: s.name,
      displayName: s.displayName || s.name,
      description: s.description || '',
      tools: s.tools || null,
      source: s._source,
    }));
  }

  // Expand a skill into the prompt that will be sent to the LLM
  expand(name, args = '') {
    const skill = this.skills.get(name);
    if (!skill) return null;
    const prompt = (skill.prompt || '').replace(/\{\{args\}\}/g, args).trim();
    return { prompt, tools: skill.tools || null };
  }

  // Install a skill from a YAML string or file path into the user skills dir
  install(yamlStrOrPath) {
    let data;
    if (existsSync(yamlStrOrPath)) {
      data = yaml.load(readFileSync(yamlStrOrPath, 'utf-8'));
    } else {
      data = yaml.load(yamlStrOrPath);
    }
    if (!data?.name) throw new Error('Skill must have a name field');
    if (!existsSync(USER_SKILLS_DIR)) mkdirSync(USER_SKILLS_DIR, { recursive: true });
    const dest = join(USER_SKILLS_DIR, `${data.name}.yaml`);
    writeFileSync(dest, yaml.dump(data));
    this.skills.set(data.name, { ...data, _source: 'user' });
    return data;
  }

  // Remove a user-installed skill
  uninstall(name) {
    const skill = this.skills.get(name);
    if (!skill) throw new Error(`Skill not found: ${name}`);
    if (skill._source !== 'user') throw new Error(`Cannot uninstall built-in skill: ${name}`);
    const path = join(USER_SKILLS_DIR, `${name}.yaml`);
    if (existsSync(path)) {
      unlinkSync(path);
    }
    this.skills.delete(name);
  }
}

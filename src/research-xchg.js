// The research files of one game server (design 2026-09-20, section 4.1):
// the nine configs the game keeps in its profile, the faction states, and
// the exchange directory where the bridge leaves a candidate config for the
// game to read and delete. One
// owner per file at any moment: the game writes configs and states, the
// bridge writes candidates, and every handover is a letter, never a watch
// on the directory.

import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { stampNow } from './storage-wire.js';

// The nine config tags, as the game registers them with the core's editor,
// in the order the game reads them.
export const NAMES = [
  'ResearchSettings', 'ResearchPointTypes', 'ResearchOwners', 'ResearchRules', 'ResearchTree',
  'ResearchDataItems', 'ResearchModules', 'ResearchSampleTypes', 'ResearchStatics',
];

// The top-level array each config is built around, checked before a
// candidate is written: a wrong shape would only fail inside the game.
export const SHAPES = {
  ResearchSettings: null,
  ResearchPointTypes: 'PointTypes',
  ResearchOwners: 'Owners',
  ResearchRules: 'Groups',
  ResearchTree: 'Branches',
  ResearchDataItems: 'Items',
  ResearchModules: 'Modules',
  ResearchSampleTypes: 'Items',
  ResearchStatics: 'Entries',
};

const TOKEN = /^[0-9a-f]{12}$/;
const CANDIDATE = /^(Research[A-Za-z]+)\.([0-9a-f]{12})\.json$/;
// A faction id as the game accepts it in a path (OZL_Ids.IsPathSafe).
const OWNER_FILE = /^([A-Za-z0-9_-]{1,64})\.json$/;
// The class dumps of builds before the core took them over (2026-09-20):
// swept, never read -- the core writes <profile>/classes.tsv now.
const OLD_CLASS_DUMPS = ['classes.txt', 'classes.tsv'];
const RETRY_MS = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

export class ResearchXchg {
  constructor(dir, xchgDir = '') {
    if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`no such directory: ${dir}`);
    this.dir = dir;
    this.stateDir = join(dir, 'research');
    this.xchgDir = xchgDir || join(dir, 'research', 'xchg');
    mkdirSync(this.xchgDir, { recursive: true });
  }

  static isName(name) {
    return NAMES.includes(String(name ?? ''));
  }

  static isToken(token) {
    return TOKEN.test(String(token ?? ''));
  }

  static fileOf(name) {
    return `OZ_Research_${String(name).slice('Research'.length)}.json`;
  }

  static candidateName(name, token) {
    return `${name}.${token}.json`;
  }

  static parseCandidate(file) {
    const m = CANDIDATE.exec(String(file ?? ''));
    return m ? { name: m[1], token: m[2] } : null;
  }

  configPath(name) {
    return join(this.dir, ResearchXchg.fileOf(name));
  }

  // The text of a config as the game wrote it; null when the file is not
  // there. A parse failure is retried once after a moment -- the game may
  // be in the middle of rewriting the file -- and then reported.
  async readConfig(name) {
    if (!ResearchXchg.isName(name)) throw new Error(`not a research config: ${name}`);
    const p = this.configPath(name);
    for (let attempt = 0; ; attempt++) {
      if (!existsSync(p)) return null;
      const text = strip(readFileSync(p, 'utf8'));
      try {
        JSON.parse(text);
        return { text, size: Buffer.byteLength(text, 'utf8'), mtime: statSync(p).mtimeMs };
      } catch (e) {
        if (attempt >= 1) throw new Error(`${ResearchXchg.fileOf(name)} is not json: ${e.message}`);
        await sleep(RETRY_MS);
      }
    }
  }

  configInfo(name) {
    const p = this.configPath(name);
    if (!existsSync(p)) return { exists: false, size: 0, mtime: 0 };
    const st = statSync(p);
    return { exists: true, size: st.size, mtime: st.mtimeMs };
  }

  // The faction states the game keeps: pool, completed nodes, projects.
  // A file that does not parse is reported in place, not thrown.
  readStates() {
    if (!existsSync(this.stateDir)) return [];
    const out = [];
    for (const file of readdirSync(this.stateDir).sort()) {
      const m = OWNER_FILE.exec(file);
      if (!m) continue;
      const p = join(this.stateDir, file);
      if (!statSync(p).isFile()) continue;
      const owner = m[1];
      try {
        const j = JSON.parse(strip(readFileSync(p, 'utf8')));
        out.push({
          owner,
          points: (Array.isArray(j.Points) ? j.Points : []).map((kv) => ({ key: String(kv?.Key ?? ''), value: Number(kv?.Value) || 0 })),
          completed: (Array.isArray(j.CompletedNodes) ? j.CompletedNodes : []).map(String),
          projects: (Array.isArray(j.ActiveProjects) ? j.ActiveProjects : []).map((pr) => ({
            node: String(pr?.NodeId ?? ''), starter: String(pr?.StarterUid ?? ''), endSec: Number(pr?.EndSec) || 0,
          })),
          at: stampNow(new Date(statSync(p).mtimeMs)),
        });
      } catch (e) {
        out.push({ owner, error: e.message, points: [], completed: [], projects: [], at: '' });
      }
    }
    return out;
  }

  // The spawner's own state: which static entries it has placed.
  readStaticsState() {
    const p = join(this.dir, 'OZ_Research_Statics_State.json');
    if (!existsSync(p)) return { spawned: [] };
    try {
      const j = JSON.parse(strip(readFileSync(p, 'utf8')));
      return { spawned: (Array.isArray(j.SpawnedIds) ? j.SpawnedIds : []).map(String) };
    } catch {
      return { spawned: [] };
    }
  }

  // A candidate, written whole under a name nobody else uses, then renamed
  // into place: the game never sees half a file.
  writeCandidate(name, token, text) {
    if (!ResearchXchg.isName(name)) throw new Error(`not a research config: ${name}`);
    if (!ResearchXchg.isToken(token)) throw new Error('bad token');
    const file = ResearchXchg.candidateName(name, token);
    const p = join(this.xchgDir, file);
    writeFileSync(`${p}.part`, text, 'utf8');
    renameSync(`${p}.part`, p);
    return file;
  }

  hasCandidate(file) {
    return !!ResearchXchg.parseCandidate(file) && existsSync(join(this.xchgDir, file));
  }

  readCandidate(file) {
    if (!ResearchXchg.parseCandidate(file)) throw new Error('not a candidate file name');
    return readFileSync(join(this.xchgDir, file), 'utf8');
  }

  discard(file) {
    if (!ResearchXchg.parseCandidate(file)) return false;
    try {
      unlinkSync(join(this.xchgDir, file));
      return true;
    } catch {
      return false;
    }
  }

  // Half-written files and candidates whose command is over go; the
  // candidates of unanswered and refused commands stay (`keepTokens`).
  sweep(keepTokens) {
    const keep = new Set(keepTokens);
    const removed = [];
    for (const file of readdirSync(this.xchgDir)) {
      let drop = false;
      if (file.endsWith('.part') || OLD_CLASS_DUMPS.includes(file)) drop = true;
      else {
        const c = ResearchXchg.parseCandidate(file);
        if (c) drop = !keep.has(c.token);
      }
      if (!drop) continue;
      try {
        unlinkSync(join(this.xchgDir, file));
        removed.push(file);
      } catch {
        // a file in use is swept next time
      }
    }
    return removed;
  }
}

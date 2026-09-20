// The research files of one game server (design 2026-09-20, section 4.1):
// the nine configs the game keeps in its profile, the faction states, the
// classes the game dumps at boot, and the exchange directory where the
// bridge leaves a candidate config for the game to read and delete. One
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
const CLASSES_FILE = 'classes.tsv';
// The one-column dump of builds before 2026-09-20: swept, never read.
const OLD_CLASSES_FILE = 'classes.txt';
const RETRY_MS = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A game name that is still a bare key (a dangling $STR_) is no name; the
// engine's $UNT$ mark on an untranslated string is not part of the name.
const nameOrNothing = (v) => {
  const s = String(v ?? '').trim().replace(/^\$UNT\$/, '');
  return /^\$?STR_/i.test(s) ? '' : s;
};

// The five roots OZL_Match.ClassExists asks the game about, in the order
// of the dump and of the site's index (classIndex.ts).
export const ROOTS = ['CfgVehicles', 'CfgMagazines', 'CfgNonAIVehicles', 'CfgAmmo', 'cfgWeapons'];

// The class index the admin site reads, out of one server's dump: the
// shape classIndex.ts parses (v3 rows: name, parent row, mod, root, the
// original column's name, the English one's) with one "mod", the server
// itself, because the game does not say which addon declared a class.
// The parent is looked up in the same root first (the game inherits
// within a root), then in any.
export function serverClassIndex(rows, server, at) {
  const byRoot = new Map();
  const byName = new Map();
  rows.forEach((r, i) => {
    const low = r.name.toLowerCase();
    byRoot.set(`${r.root}:${low}`, i);
    if (!byName.has(low)) byName.set(low, i);
  });
  const classes = rows.map((r) => {
    const low = r.base.toLowerCase();
    let parent = -1;
    if (low) {
      const same = byRoot.get(`${r.root}:${low}`);
      parent = same !== undefined ? same : (byName.get(low) ?? -1);
    }
    return [r.name, parent, 0, r.root, r.original, r.english];
  });
  return { v: 3, generated: at, mods: [server], classes };
}
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

  // The classes the game dumps at boot (OZL_ClassDump): a line per class,
  // tab-separated -- the root (0..4, the order of ROOTS), the name, the
  // parent, the game name in the stringtables' original column and in the
  // English one, as the server read them out of its archives.
  readClasses() {
    const p = join(this.xchgDir, CLASSES_FILE);
    if (!existsSync(p)) return { rows: [], count: 0, at: '' };
    const rows = [];
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      if (!line) continue;
      const f = line.split('\t');
      const root = Number(f[0]);
      const name = (f[1] || '').trim();
      if (!Number.isInteger(root) || root < 0 || root >= ROOTS.length || !name) continue;
      rows.push({ root, name, base: (f[2] || '').trim(), original: nameOrNothing(f[3]), english: nameOrNothing(f[4]) });
    }
    return { rows, count: rows.length, at: stampNow(new Date(statSync(p).mtimeMs)) };
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
      if (file.endsWith('.part') || file === OLD_CLASSES_FILE) drop = true;
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

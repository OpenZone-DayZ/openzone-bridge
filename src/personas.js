// NPC posters: names an admin mints and hands to factions.
//
// A persona is AUTHORSHIP, not an account: it exists so a faction leader can
// speak in the news feed as "Сидорович" rather than as himself. Admins may
// wear any persona; a faction leader may wear the ones granted to his
// faction; everyone else posts under their own linked game name only.
//
// KEPT IN THE STORE, like everything else the bridge remembers -- one row
// in its meta table, written atomically on every grant.

const KEY = 'personas';

export class Personas {
  constructor(store) {
    this.store = store;
    this.data = { version: 1, items: {} }; // name -> { factions: [slug], by, at }

    const raw = store.metaGet(KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.items) this.data = parsed;
      } catch (err) {
        console.error(`[personas] the stored roster is unreadable (${err.message}); starting empty`);
      }
    }
  }

  #save() {
    this.store.metaSet(KEY, JSON.stringify(this.data));
  }

  create(name, by) {
    if (this.data.items[name]) return { Error: 'exists' };
    this.data.items[name] = { factions: [], by, at: new Date().toISOString() };
    this.#save();
    return { ok: true };
  }

  grant(name, factionSlug) {
    const p = this.data.items[name];
    if (!p) return { Error: 'no_persona' };
    if (!p.factions.includes(factionSlug)) p.factions.push(factionSlug);
    this.#save();
    return { ok: true };
  }

  revoke(name, factionSlug) {
    const p = this.data.items[name];
    if (!p) return { Error: 'no_persona' };
    const at = p.factions.indexOf(factionSlug);
    if (at >= 0) p.factions.splice(at, 1);
    this.#save();
    return { ok: true };
  }

  list() {
    return Object.entries(this.data.items).map(([name, p]) => ({ name, factions: [...p.factions] }));
  }

  // The names this member may post under, besides his own. Admin -> all;
  // a faction leader -> whatever his faction was granted.
  //
  // THE LEADER PICKS FROM THIS LIST HIMSELF, and an organisation may hold
  // several names (owner, 2026-09-01). What he cannot do is mint a persona
  // or grant one to himself: assigning them is an admin's act alone. The
  // line runs between "which names we have" and "which one signs this post".
  //
  // Read the other way round once and implemented as a single fixed voice
  // per organisation; that was wrong and is recorded in TZ-6 §1a.
  allowedFor(resolved, isAdmin) {
    if (isAdmin) return Object.keys(this.data.items);
    if (!resolved || !resolved.Org) return [];
    if (!resolved.Posts || !resolved.Posts.includes('leader')) return [];
    return Object.entries(this.data.items)
      .filter(([, p]) => p.factions.includes(resolved.Org))
      .map(([name]) => name);
  }
}

// The admin page (design 2026-09-19, sections 8 and 15) in one file, no
// build step: a hash router, a JSON client of admin/v1, one view per
// screen. Every word comes from strings.js, so the page is the same in
// Ukrainian and in English. Confirmations and forms are inline panels,
// never window.confirm or prompt. Every address is relative to the page,
// so a reverse proxy may serve it under any path.
(() => {
  'use strict';

  const STR = window.OZ_STR;
  const SIZES = { OZ_StorageBox_Small: [5, 'size_small'], OZ_StorageBox_Medium: [10, 'size_medium'], OZ_StorageBox_Large: [15, 'size_large'] };
  const COLS = 10;
  const MONO = new Set(['id', 'uid', 'stamp', 'when', 'pos', 'placed_at', 'parked_at', 'last_seen', 'box', 'cell', 'classes']);

  const remembered = (key, dflt) => {
    try { return localStorage.getItem(key) || dflt; } catch (e) { return dflt; }
  };
  const remember = (key, value) => {
    try { localStorage.setItem(key, value); } catch (e) { /* a page without storage still works */ }
  };

  let lang = remembered('oz_lang', 'uk');
  let myName = remembered('oz_name', 'web');
  let me = { auth: false, name: '', userId: '' };

  const s = (key, vars) => {
    let t = (STR[lang] && STR[lang][key]) || STR.en[key] || key;
    if (vars) for (const k of Object.keys(vars)) t = t.split(`{${k}}`).join(String(vars[k]));
    return t;
  };

  // ---- dom ----
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') el.className = v || '';
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false || c === '') continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  const view = document.getElementById('view');
  const only = (xs) => xs.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false && x !== '');
  const show = (...nodes) => view.replaceChildren(...only(nodes));
  const msg = (text, bad) => h('div', { class: bad ? 'msg bad' : 'msg' }, text);
  const notice = (text, bad) => {
    const m = msg(text, bad);
    view.prepend(m);
    setTimeout(() => m.remove(), 8000);
  };
  const link = (href, text, cls) => h('a', { href, class: cls }, text);
  const boxLink = (id) => link(`#/box/${id}`, id, 'mono');
  const table = (cols, rows, cell) => {
    if (!rows.length) return h('p', { class: 'dim' }, s('nothing'));
    return h('table', null,
      h('thead', null, h('tr', null, cols.map((c) => h('th', null, s(c))))),
      h('tbody', null, rows.map((r) => h('tr', null, cols.map((c) => h('td', { class: MONO.has(c) ? 'mono' : '' }, cell(r, c)))))));
  };
  const num = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);
  const status = (st) => s(`st_${st}`);
  const sizeOf = (cls) => (SIZES[cls] ? s(SIZES[cls][1]) : cls);
  const cellOf = (i) => (i.loc_type === 2 ? `${s('slot')} ${i.slot}` : i.row >= 0 ? `${i.row},${i.col}` : '—');
  const eventCell = (e) => e.slot || (e.row >= 0 ? `${e.row},${e.col}` : '');

  // A question with two buttons at the top of the view; resolves true or false.
  function ask(key, vars) {
    return new Promise((resolve) => {
      const bar = h('div', { class: 'msg' }, s(key, vars), ' ',
        h('button', { type: 'button', onclick: () => { bar.remove(); resolve(true); } }, s('confirm')), ' ',
        h('button', { type: 'button', onclick: () => { bar.remove(); resolve(false); } }, s('cancel')));
      view.prepend(bar);
      bar.scrollIntoView({ block: 'nearest' });
    });
  }

  // ---- api ----
  async function api(op, body) {
    let r;
    try {
      r = await fetch(`admin/v1/${op}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-oz-admin': '1' },
        body: JSON.stringify({ ...(body || {}), admin: myName }),
      });
    } catch (e) {
      return { ok: false, why: e.message };
    }
    let out;
    try { out = await r.json(); } catch (e) { out = { ok: false, why: `${r.status}` }; }
    if (r.status === 401) out = { ok: false, why: s('sign_in_first') };
    return out;
  }
  async function act(op, body) {
    const r = await api(op, body);
    if (!r.ok) {
      notice(`${s('error')}: ${r.why}`, true);
      return null;
    }
    return r;
  }

  // ---- header ----
  function paintHeader() {
    document.documentElement.lang = lang;
    document.title = s('title');
    for (const el of document.querySelectorAll('[data-str]')) el.textContent = s(el.dataset.str);
    for (const b of document.querySelectorAll('[data-lang]')) b.classList.toggle('on', b.dataset.lang === lang);
    const page = location.hash.replace(/^#\/?/, '').split('/')[0] || 'boxes';
    const section = page === 'box' || page === 'history' ? 'boxes' : page;
    for (const a of document.querySelectorAll('nav a')) a.classList.toggle('on', a.getAttribute('href') === `#/${section}`);
    const who = document.getElementById('who');
    if (me.auth && me.name) {
      who.replaceChildren(h('span', null, `${s('signed_in_as')} ${me.name}`),
        h('button', { type: 'button', onclick: async () => {
          await fetch('auth/logout', { method: 'POST', headers: { 'x-oz-admin': '1' } });
          location.reload();
        } }, s('sign_out')));
    } else if (me.auth) {
      who.replaceChildren(h('a', { href: 'auth/login' }, s('sign_in')));
    } else {
      const input = h('input', { value: myName === 'web' ? '' : myName, placeholder: s('your_name'), size: 18 });
      input.addEventListener('change', () => {
        myName = input.value.trim().slice(0, 64) || 'web';
        remember('oz_name', myName);
      });
      who.replaceChildren(input);
    }
  }
  for (const b of document.querySelectorAll('[data-lang]')) {
    b.addEventListener('click', () => {
      lang = b.dataset.lang;
      remember('oz_lang', lang);
      route();
    });
  }

  // ---- views ----
  async function boxesView() {
    show(h('h2', null, s('nav_boxes')), msg(s('loading')));
    const r = await api('boxes');
    if (!r.ok) return show(h('h2', null, s('nav_boxes')), msg(r.why, true));
    show(h('h2', null, s('nav_boxes')),
      table(['id', 'cls', 'status', 'items', 'roots', 'pos', 'placed_by', 'last_seen'], r.boxes.filter((b) => b.status !== 'removed'), (b, c) => ({
        id: boxLink(b.box_id), cls: sizeOf(b.class), status: status(b.status), items: b.entities, roots: b.roots,
        pos: b.pos, placed_by: b.placed_by, last_seen: b.last_seen_at,
      })[c]));
  }

  async function boxView(id) {
    const title = h('h2', null, `${s('box')} `, h('span', { class: 'mono' }, id));
    show(title, msg(s('loading')));
    const r = await api('box', { id });
    if (!r.ok) return show(title, msg(r.why, true));
    const { box, items } = r;
    const closed = box.status === 'closed';
    let filter = '';

    const roots = [];
    for (const it of items) {
      if (!roots[it.root_idx]) roots[it.root_idx] = [];
      roots[it.root_idx].push(it);
    }
    const hit = (it) => filter !== '' && it.type.toLowerCase().includes(filter);
    const rootHit = (nodes) => nodes.some(hit);
    const rowsOf = () => (SIZES[box.class] ? SIZES[box.class][0] : Math.max(5, ...items.map((i) => i.row + 1)));
    const short = (type) => type.replace(/^OZ_/, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 6);

    const grid = h('div', { class: 'grid' });
    const tree = h('div', { class: 'tree' });
    const aside = h('div');
    const actions = h('div', { class: 'panel' });
    const again = () => boxView(id);

    function paint() {
      const at = new Map();
      for (const nodes of roots) if (nodes && nodes[0].loc_type === 3 && nodes[0].row >= 0) at.set(`${nodes[0].row},${nodes[0].col}`, nodes);
      const cells = [];
      const rows = rowsOf();
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < COLS; col++) {
          const nodes = at.get(`${row},${col}`);
          cells.push(nodes
            ? h('div', { class: `item${rootHit(nodes) ? ' hit' : ''}`, title: `${nodes[0].type} (${nodes.length})` }, short(nodes[0].type))
            : h('div', null));
        }
      }
      grid.replaceChildren(...cells);
      const unplaced = [];
      const slots = [];
      for (const nodes of roots) {
        if (!nodes) continue;
        if (nodes[0].loc_type === 2) slots.push(nodes);
        else if (nodes[0].row < 0) unplaced.push(nodes);
      }
      aside.replaceChildren(...only([
        unplaced.length ? h('h3', null, s('unplaced')) : null,
        ...unplaced.map((nodes) => h('div', { class: 'mono' }, `${nodes[0].type} (${nodes.length})`)),
        slots.length ? h('h3', null, s('in_slots')) : null,
        ...slots.map((nodes) => h('div', { class: 'mono' }, `${nodes[0].slot}: ${nodes[0].type} (${nodes.length})`))]));
      tree.replaceChildren(h('ul', null, roots.map((nodes, idx) => (nodes ? rootNode(nodes, idx) : null))));
    }

    function rootNode(nodes, rootIdx) {
      const kids = (parent) => nodes.map((n, i) => [n, i]).filter(([n]) => n.parent === parent);
      const line = (n, i) => {
        const node = h('span', { class: `node${hit(n) ? ' hit' : ''}` },
          h('span', { class: 'type mono' }, n.type),
          n.quantity > 0 ? h('span', { class: 'dim' }, `×${num(n.quantity)}`) : null,
          h('span', { class: 'dim' }, `${s('health')} ${num(n.health)}`),
          i === 0 ? h('span', { class: 'dim' }, cellOf(n)) : null,
          n.has_blob ? h('span', { class: 'dim', title: s('has_state') }, '◆') : null,
          closed ? h('button', { type: 'button', class: 'small', onclick: () => editForm(rootIdx, i, n) }, s('edit')) : null,
          closed && i === 0 ? h('button', { type: 'button', class: 'small', onclick: () => shelve(rootIdx, n) }, s('shelve')) : null,
          closed && i === 0 ? h('button', { type: 'button', class: 'small', onclick: () => moveForm(rootIdx, n) }, s('move')) : null);
        const below = kids(i);
        return h('li', null, node, below.length ? h('ul', null, below.map(([k, ki]) => line(k, ki))) : null);
      };
      return line(nodes[0], 0);
    }

    // ---- tier 2 ----
    const closeButton = (form) => h('button', { type: 'button', onclick: () => form.remove() }, s('close'));
    async function shelve(rootIdx, n) {
      if (!(await ask('c_shelve', { type: n.type, id }))) return;
      const out = await act('shelve', { id, root: rootIdx });
      if (out) {
        await again();
        notice(`${s('done')} ${s('new_version', { v: out.version })} ${s('takes_effect')}`);
      }
    }
    function moveForm(rootIdx, n) {
      const to = h('input', { placeholder: s('move_to'), size: 44, class: 'mono' });
      const form = h('form', { class: 'panel row', onsubmit: async (e) => {
        e.preventDefault();
        const target = to.value.trim();
        if (!target) return;
        if (!(await ask('c_move', { type: n.type, id, to: target }))) return;
        const out = await act('move', { from: id, root: rootIdx, to: target });
        if (out) {
          await again();
          notice(`${s('done')} ${s('two_versions', { a: out.fromVersion, b: out.toVersion })} ${s('takes_effect')}`);
        }
      } }, h('span', { class: 'mono' }, n.type), to, h('button', { type: 'submit' }, s('move')));
      form.append(closeButton(form));
      actions.append(form);
    }
    function editForm(rootIdx, nodeIdx, n) {
      const qty = h('input', { placeholder: s('edit_qty'), size: 30 });
      const hp = h('input', { placeholder: s('edit_health'), size: 36 });
      const reset = h('input', { type: 'checkbox' });
      const form = h('form', { class: 'panel', onsubmit: async (e) => {
        e.preventDefault();
        const body = { id, root: rootIdx, node: nodeIdx };
        if (qty.value.trim() !== '') body.quantity = qty.value.trim();
        if (hp.value.trim() !== '') body.health = hp.value.trim();
        if (reset.checked) body.reset = true;
        if (!(await ask(reset.checked ? 'c_edit_reset' : 'c_edit', { type: n.type, id }))) return;
        const out = await act('edit', body);
        if (out) {
          await again();
          notice(`${s('done')} ${s('new_version', { v: out.version })} ${s('takes_effect')}`);
        }
      } },
      h('div', { class: 'row' }, h('span', { class: 'mono' }, n.type), h('span', { class: 'dim' }, `×${num(n.quantity)}, ${s('health')} ${num(n.health)}`)),
      h('div', { class: 'row' }, qty, hp),
      n.has_blob ? h('label', { class: 'row' }, reset, ` ${s('reset')}`) : null,
      h('div', { class: 'row' }, h('button', { type: 'submit' }, s('edit'))));
      form.lastChild.append(closeButton(form));
      actions.append(form);
    }
    function giveForm() {
      const type = h('input', { placeholder: s('give_class'), size: 24 });
      const qty = h('input', { placeholder: s('give_qty'), size: 22, value: '0' });
      const form = h('form', { class: 'panel row', onsubmit: async (e) => {
        e.preventDefault();
        const t = type.value.trim();
        const q = Number(qty.value) || 0;
        if (!t) return;
        if (!(await ask('c_give', { type: t, qty: q, id }))) return;
        const out = await act('give', { id, type: t, qty: q });
        if (out) {
          await again();
          notice(`${s('done')} ${s('new_version', { v: out.version })} ${s('takes_effect')}`);
        }
      } }, type, qty, h('button', { type: 'submit' }, s('give')));
      form.append(closeButton(form));
      actions.append(form);
    }
    async function empty() {
      if (!(await ask('c_empty', { id }))) return;
      const out = await act('empty', { id });
      if (out) {
        await again();
        notice(`${s('done')} ${s('new_version', { v: out.version })} ${s('takes_effect')}`);
      }
    }

    const filterInput = h('input', { placeholder: s('filter'), size: 24 });
    filterInput.addEventListener('input', () => {
      filter = filterInput.value.trim().toLowerCase();
      paint();
    });
    actions.append(h('div', { class: 'row' },
      h('button', { type: 'button', disabled: !closed, onclick: giveForm }, s('give')),
      h('button', { type: 'button', class: 'danger', disabled: !closed, onclick: empty }, s('empty')),
      link(`#/history/${id}`, s('history')),
      closed ? null : h('span', { class: 'dim' }, s('closed_only'))));

    show(title,
      h('div', { class: 'panel stat' },
        h('span', { class: 'dim' }, s('cls')), h('span', null, `${box.class} (${sizeOf(box.class)})`),
        h('span', { class: 'dim' }, s('status')), h('span', { class: box.status === 'open' ? 'good' : '' }, status(box.status)),
        h('span', { class: 'dim' }, s('version')), h('span', null, String(box.current_version)),
        h('span', { class: 'dim' }, s('items')), h('span', null, String(items.length)),
        h('span', { class: 'dim' }, s('pos')), h('span', { class: 'mono' }, box.pos),
        h('span', { class: 'dim' }, s('placed_by')), h('span', null, `${box.placed_by} ${box.placed_at}`)),
      actions,
      h('div', { class: 'row' }, filterInput),
      h('h3', null, s('grid')), grid, aside,
      h('h3', null, s('tree')), tree);
    paint();
  }

  async function historyView(id) {
    const title = h('h2', null, `${s('history')} `, boxLink(id));
    show(title, msg(s('loading')));
    const r = await api('history', { id, limit: 200 });
    if (!r.ok) return show(title, msg(r.why, true));
    const b = await api('box', { id });
    const current = b.ok ? b.box.current_version : 0;
    const closed = b.ok && b.box.status === 'closed';
    const diffPanel = h('div');
    async function compare(v) {
      diffPanel.replaceChildren(msg(s('loading')));
      const d = await api('diff', { a: current, b: v.id });
      if (!d.ok) return diffPanel.replaceChildren(msg(d.why, true));
      const list = (key, xs, sign) => (xs.length ? [h('h3', null, s(key)), h('ul', { class: 'diff' }, xs.map((x) => h('li', { class: 'mono' }, `${sign} ${x.type} ×${x.n}`)))] : []);
      diffPanel.replaceChildren(h('div', { class: 'panel' },
        h('div', { class: 'row' }, h('b', null, `${s('version')} ${v.id}`), h('span', { class: 'dim' }, `${v.stamp} · ${v.source} · ${v.note}`)),
        ...list('gone', d.gone, '−'), ...list('came', d.came, '+'),
        !d.gone.length && !d.came.length ? h('p', { class: 'dim' }, s('same')) : null,
        h('div', { class: 'row' },
          h('button', { type: 'button', disabled: !closed || v.id === current, onclick: async () => {
            if (!(await ask('c_rollback', { id, v: v.id }))) return;
            const out = await act('rollback', { id, version: v.id });
            if (out) {
              await historyView(id);
              notice(`${s('done')} ${s('new_version', { v: out.version })} ${s('takes_effect')}`);
            }
          } }, s('rollback_to')),
          closed ? null : h('span', { class: 'dim' }, s('closed_only')))));
    }
    show(title,
      h('h3', null, s('versions')),
      table(['version', 'stamp', 'source', 'roots', 'items', 'note', 'actions'], r.versions, (v, c) => ({
        version: v.id === current ? h('b', null, `${v.id} (${s('current')})`) : String(v.id),
        stamp: v.stamp, source: v.source, roots: v.roots, items: v.entities, note: v.note,
        actions: h('button', { type: 'button', class: 'small', onclick: () => compare(v) }, s('compare')),
      })[c]),
      diffPanel,
      h('h3', null, s('events')),
      table(['when', 'kind', 'who', 'cls', 'qty', 'cell', 'note', 'admin'], r.events, (e, c) => ({
        when: e.at, kind: e.kind, who: e.name || e.uid, cls: e.type, qty: e.qty || '', cell: eventCell(e), note: e.note, admin: e.admin,
      })[c]));
  }

  function searchForm(placeholderKey, value, page) {
    const input = h('input', { placeholder: s(placeholderKey), size: 28, value: value || '' });
    return h('form', { class: 'row', onsubmit: (e) => {
      e.preventDefault();
      location.hash = `#/${page}/${encodeURIComponent(input.value.trim())}`;
    } }, input, h('button', { type: 'submit' }, s('search')));
  }

  async function playerView(uid) {
    const title = h('h2', null, s('nav_player'));
    const form = searchForm('uid', uid, 'player');
    show(title, form, uid ? msg(s('loading')) : null);
    if (!uid) return;
    const r = await api('player', { uid, limit: 500 });
    if (!r.ok) return show(title, form, msg(r.why, true));
    show(title, form, table(['when', 'kind', 'box', 'cls', 'qty', 'cell', 'note'], r.events, (e, c) => ({
      when: e.at, kind: e.kind, box: boxLink(e.box_id), cls: e.type, qty: e.qty || '', cell: eventCell(e), note: e.note,
    })[c]));
  }

  async function findView(type) {
    const title = h('h2', null, s('nav_find'));
    const form = searchForm('cls', type, 'find');
    show(title, form, type ? msg(s('loading')) : null);
    if (!type) return;
    const r = await api('find', { type });
    if (!r.ok) return show(title, form, msg(r.why, true));
    const last = r.last
      ? h('p', null, `${s('last_taken')}: ${r.last.name || r.last.uid} · ${r.last.at} · `, boxLink(r.last.box_id))
      : h('p', { class: 'dim' }, s('nobody_took'));
    show(title, form, last, table(['box', 'status', 'cls', 'pos', 'cell', 'qty', 'health'], r.items, (i, c) => ({
      box: boxLink(i.box_id), status: status(i.status), cls: sizeOf(i.box_class), pos: i.pos, cell: cellOf(i), qty: num(i.quantity), health: num(i.health),
    })[c]));
  }

  async function shelfView() {
    const title = h('h2', null, s('nav_shelf'));
    show(title, msg(s('loading')));
    const r = await api('parked');
    if (!r.ok) return show(title, msg(r.why, true));
    const classes = (p) => {
      try { return JSON.parse(p.types).join(', '); } catch (e) { return p.types; }
    };
    show(title, table(['id', 'box', 'parked_at', 'reason', 'cls', 'classes', 'from_version', 'actions'], r.parked, (p, c) => ({
      id: String(p.id), box: boxLink(p.box_id), parked_at: p.parked_at, reason: p.reason, cls: p.type, classes: classes(p), from_version: String(p.from_version),
      actions: h('span', { class: 'row' },
        h('button', { type: 'button', class: 'small', onclick: async () => {
          if (!(await ask('c_return', { type: p.type, id: p.box_id }))) return;
          const out = await act('unpark', { parked: p.id });
          if (out) {
            await shelfView();
            notice(`${s('done')} ${s('new_version', { v: out.version })} ${s('takes_effect')}`);
          }
        } }, s('shelf_return')),
        h('button', { type: 'button', class: 'small danger', onclick: async () => {
          if (!(await ask('c_discard', { type: p.type }))) return;
          if (await act('discard', { parked: p.id })) {
            await shelfView();
            notice(s('done'));
          }
        } }, s('shelf_discard'))),
    })[c]));
  }

  async function healthView() {
    const title = h('h2', null, s('nav_health'));
    show(title, msg(s('loading')));
    const r = await api('health');
    if (!r.ok) return show(title, msg(r.why, true));
    const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
    show(title,
      h('div', { class: 'panel stat' },
        h('span', { class: 'dim' }, s('xchg')), h('span', { class: r.xchg ? 'good' : 'bad' }, r.xchg ? s('configured') : s('not_configured')),
        h('span', { class: 'dim' }, s('auth')), h('span', null, r.auth ? s('auth_discord') : s('auth_none')),
        h('span', { class: 'dim' }, s('db_size')), h('span', null, mb(r.dbBytes || 0)),
        h('span', { class: 'dim' }, s('keep')), h('span', null, `${r.keep ? r.keep.versions : 0} ${s('keep_versions')}, ${r.keep ? r.keep.events : 0} ${s('keep_events')}`)),
      h('h3', null, s('servers')),
      (r.servers || []).length
        ? h('ul', null, r.servers.map((x) => h('li', { class: 'mono' }, `${x.id}: ${s('last_poll')} ${x.at}`)))
        : h('p', { class: 'dim' }, s('no_servers')),
      h('h3', null, s('open_boxes')),
      table(['id', 'cls', 'last_seen'], r.open || [], (b, c) => ({ id: boxLink(b.box_id), cls: sizeOf(b.class), last_seen: b.last_seen_at })[c]));
  }

  // ---- router ----
  async function route() {
    const parts = location.hash.replace(/^#\/?/, '').split('/');
    const page = parts[0] || 'boxes';
    const arg = decodeURIComponent(parts.slice(1).join('/'));
    paintHeader();
    if (me.auth && !me.name) return show(h('h2', null, s('title')), msg(s('sign_in_first')));
    if (page === 'box' && arg) return boxView(arg);
    if (page === 'history' && arg) return historyView(arg);
    if (page === 'player') return playerView(arg);
    if (page === 'find') return findView(arg);
    if (page === 'shelf') return shelfView();
    if (page === 'health') return healthView();
    return boxesView();
  }
  window.addEventListener('hashchange', route);

  (async () => {
    const w = await api('whoami');
    if (w.ok) me = { auth: !!w.auth, name: w.name || '', userId: w.userId || '' };
    route();
  })();
})();

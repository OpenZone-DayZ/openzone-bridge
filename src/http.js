// The half the game talks to.
//
// Every route is POST with a JSON body, and the shared secret travels IN THAT
// BODY rather than in a header — DayZ's RestContext.SetHeader controls only
// Content-Type, so an Authorization header is not available to it. That is
// also why the endpoint must be HTTPS in production: plain http would hand the
// secret to anyone watching the wire.
//
// /v1/poll is a LONG poll. The game has no inbound connections — a DayZ server
// listens to nobody, and Discord cannot knock on its door. So the game asks,
// and we hold the answer until there is something to say or the hold expires.
//
// The hold MUST stay under ten seconds. Measured against the engine: an
// asynchronous DayZ request dies at exactly 10 s no matter what
// RestApi.SetOption is told, and the answer then lands in a socket nobody is
// listening on. The documented 3..120 s range applies to the synchronous call
// only. Eight seconds leaves margin and costs one request per server per eight
// seconds — while a message that actually arrives still goes out at once,
// because wake() releases the held poll immediately.

import { createServer } from 'node:http';
import { once } from 'node:events';
import { timingSafeEqual } from 'node:crypto';

const MAX_BODY = 1 << 20; // 1 MiB: a chat batch is never near this

export class HttpSide {
  constructor(cfg, handlers) {
    this.cfg = cfg;
    this.handlers = handlers;
    this.waiters = [];
    this.secret = Buffer.from(String(cfg.secret || ''), 'utf8');
    this.server = createServer((req, res) => this.#route(req, res));
  }

  // LOOPBACK UNLESS TOLD OTHERWISE (BRIDGE_HOST).
  //
  // This listened on every interface while the documentation described the
  // bridge as something the DayZ server alone talks to, over a secret in the
  // body and no TLS. On a host with a public address that is the whole chat
  // of every player, offered to the internet, one guessed string away.
  async listen() {
    const host = this.cfg.host || '127.0.0.1';
    this.server.listen(this.cfg.port, host);
    await once(this.server, 'listening');
    console.log(`[http] listening on ${host}:${this.cfg.port}`);
  }

  // Something happened in Discord: release every held poll at once.
  wake() {
    const held = this.waiters;
    this.waiters = [];
    for (const w of held) {
      clearTimeout(w.timer);
      w.resolve();
    }
  }

  async #route(req, res) {
    // Reachability check, and nothing else: no secret, no state, no answer
    // that says anything about the guild. Setting a bridge up means proving
    // the game can reach it before wondering why chat is empty.
    if (req.url.startsWith('/v1/ping')) {
      return this.#json(res, 200, { ok: true });
    }

    if (req.method !== 'POST') {
      return this.#json(res, 405, { error: 'post only' });
    }

    let body;
    try {
      body = await this.#read(req);
    } catch (err) {
      return this.#json(res, 400, { error: err.message });
    }

    // The secret is checked before anything else looks at the payload, and
    // the comparison does not stop at the first wrong character.
    if (!body || !this.#secretOk(body.Secret)) {
      // Deliberately vague: a precise answer helps whoever is guessing.
      return this.#json(res, 403, { error: 'refused' });
    }

    // Enforce Script serialises a class field by field, and a nested object
    // would need a declared type for every route. The game therefore posts
    // its payload as a STRING of JSON and the bridge opens it here -- once,
    // in one place, instead of in each route.
    if (typeof body.Json === 'string') {
      try {
        body.Json = JSON.parse(body.Json || '{}');
      } catch {
        return this.#json(res, 400, { error: 'Json is not json' });
      }
    }

    const path = req.url.split('?')[0];

    try {
      if (path === '/v1/poll') return await this.#poll(res, body);

      const fn = this.handlers.routes[path];
      if (!fn) return this.#json(res, 404, { error: 'no such route' });

      const out = await fn(body);
      return this.#json(res, 200, out ?? { ok: true });
    } catch (err) {
      console.error(`[http] ${path}: ${err.stack || err.message}`);
      return this.#json(res, 500, { error: 'bridge failed' });
    }
  }

  async #poll(res, body) {
    const first = this.handlers.drain(body);
    if (first.Items.length > 0) return this.#json(res, 200, first);

    // Nothing yet. Hold the request instead of answering "no" — an empty
    // answer would just be asked again a moment later, and the latency of
    // that gap is exactly what long polling exists to remove.
    await new Promise((resolve) => {
      const w = { resolve, timer: null };
      w.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        resolve();
      }, this.cfg.holdSeconds * 1000);
      this.waiters.push(w);
    });

    return this.#json(res, 200, this.handlers.drain(body));
  }

  #secretOk(given) {
    const got = Buffer.from(String(given ?? ''), 'utf8');
    // Length is public either way -- timingSafeEqual refuses unequal buffers
    // -- and the comparison of equal-length ones takes the same time whatever
    // the bytes are.
    return got.length === this.secret.length && timingSafeEqual(got, this.secret);
  }

  async #read(req) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) {
        req.destroy();
        throw new Error('body too large');
      }
      chunks.push(c);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      throw new Error('body is not json');
    }
  }

  #json(res, code, obj) {
    const s = JSON.stringify(obj);
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(s),
    });
    res.end(s);
  }
}

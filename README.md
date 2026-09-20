# OpenZone Bridge

The service that connects a DayZ server running **OpenZone** to a Discord guild.

## Why a separate service

A DayZ server can make outbound HTTP requests, but it accepts no inbound connections,
and its REST client cannot set request headers. Discord cannot push into the game.
The bridge closes that gap:

- **Game to Discord** — the DayZ server POSTs to the bridge; the bridge writes to
  Discord.
- **Discord to game** — the bridge holds the game's poll request open until something
  happens, then answers with a batch, so this behaves like a push with none of the
  latency of short polling. The hold is kept **under ten seconds**: the engine kills
  an asynchronous REST request at exactly ten, whatever `SetOption` was told. The
  3..120 range in the docs describes the blocking `POST_now`, not the async path
  this uses — measured on the stand, and the reason `POLL_HOLD_SECONDS` defaults
  to 8.

## What it does

- Links a player's SteamID to their Discord account: the PDA shows a six-character
  code, the player runs `/link <code>` in the guild, and the bot knows who they are
  from the interaction. No browser, no OAuth round trip, nothing to register.
- Keeps every private conversation and group chat as a **private Discord thread**,
  visible only to its participants. Threads, not channels: a guild is capped at 500
  channels, which a server with active players would exhaust, while archived threads
  are unlimited.
- Keeps factions, posts, ranks and traits, and who holds what, in its own SQLite
  tables (keyed by Steam64, no Discord link required) and mirrors them onto Discord
  roles when the roles mirror is on — one direction: a role edited by hand in the
  guild is put back from the tables.
- Caches recent messages so the PDA still shows history and can queue outgoing
  messages while Discord is unreachable.

## Running without a Discord bot

Leave `DISCORD_BOT_TOKEN` empty in `.env` and the bridge starts anyway. Everything
whose home is this service — chat, the news feed, factions and roles, the wipe —
runs exactly as it does with a bot, because all of it lives in the bridge's own
SQLite. What is missing is the guild: mirrors, slash commands and `/link` are
unavailable and say so (`discord_off`) instead of failing quietly, and one line at
start-up names the mode rather than pretending to connect. Nobody is linked in this
mode, so a player is named by his in-game name, or by his Steam64 when even that is
unknown.

`GET /v1/ping` carries the difference: `{"ok":true,"discord":false}` without a bot
and `"discord":true` with one, so the game and the admin can tell **the bridge is
down** from **the bridge is up and has no bot**. The game reads that field once at
start-up and treats "Discord is not configured" the same way it treats "no mirrors
are on" — the link gate is not held for a service that writes nowhere.

Setting `DISCORD_BOT_TOKEN` makes `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID` and
`DISCORD_PARENT_CHANNEL_ID` required: half a Discord configuration is a mistake and
the bridge refuses to start on it, while an absent one is a mode.

## Running

Node.js **24+** (the store is `node:sqlite`, which ships unflagged from 24 -- nothing to
compile on the host) and a filled-in `.env` (see `SETUP.md`). Then:

- **Windows**: `.\run.ps1` — or `.\run.ps1 -Loop` to restart on crash.
- **Linux**: `./run.sh` — or `./run.sh --loop`.

Both scripts check the Node version, install the two dependencies on first
run, refuse to start without `.env`, and then just run `node src/index.js`.

## Running from the release

Every `v*` tag is a GitHub release with `openzone-bridge-<version>-win32-x64.zip`: one
`openzone-bridge.exe` (Node built in, nothing to install) with `web/dist/` (the admin site), `.env.example`,
this README and SETUP.md beside it. Unzip anywhere, copy `.env.example` to `.env` next to
the exe, fill it in (SETUP.md), run `openzone-bridge.exe`. The exe reads `.env`, keeps its
database in `state/` and serves `web/` from its own folder, whatever the current directory
is; update by replacing the exe and `web/`, keep `.env` and `state/`. The console clients
`scripts/storage.mjs` and `scripts/research.mjs` are not in the exe -- the admin site covers
them; the scripts need Node and the repository.

## Building the release

`npm run build` type-checks and builds the admin site (`web-src/` -> `web/dist/`, Vite);
`npm run build:sea` then bundles the sources with esbuild, makes a Node single-executable
blob and injects it into a copy of the running Node (`scripts/build-sea.mjs`); the result is
`dist/openzone-bridge-<version>-<platform>-<arch>/` and its zip. The workflow
`.github/workflows/release.yml` does the same on `windows-latest` for every tag and
publishes the zip; `build:sea` refuses to package without a built site.

## Tests

```
npm run check     # every file in src/, test/ and scripts/ still parses
npm test          # every offline suite, named one by one on purpose
npm run test:web  # the admin site's unit tests (vitest): the editor's schema, checks, tree, chains
npm run test:live # test/roundtrip.mjs against a running bridge
```

`npm test` runs offline against a throwaway SQLite file and touches neither
Discord nor the stand. It names its files instead of letting `node --test`
discover them, because that discovery is recursive over anything under a
directory called `test` and would otherwise pick up `test/roundtrip.mjs`
too; a `pretest` check fails loudly if the named list and the directory ever
disagree, so a new suite has to be added to `package.json` on purpose before
it runs. `BRIDGE_DB` points any offline suite that reads it at another
database.

`test/roundtrip.mjs` is the one suite that needs more, which is why it is
not in that list: it talks to a **running** bridge on `BRIDGE_PORT` and
reads the shared secret from `.env` (it never prints it), and it polls
under a ServerId of its own so the guild sees nothing and drops the rows it
wrote when it finishes. Run it on purpose with `npm run test:live`.

## Storage boxes

The bridge is the home of every closed storage box of `OpenZone_Storage`
(design: `docs/specs/2026-09-19-storage-sql-truth-design.md` in the series
hub). The game writes a box's contents as one file into
`$profile:OpenZone/Storage/xchg/` when it closes and posts
`/v1/storage/close`; the bridge keeps the roots byte for byte in SQLite,
promotes the file into the box's cache, and answers `/v1/storage/open`
with that cache, rebuilding it only after an admin changed the version.
Without `STORAGE_XCHG_DIR` every storage route refuses and the game shows
its boxes as unavailable.

| `.env` key | Default | Meaning |
|---|---|---|
| `STORAGE_XCHG_DIR` | unset | the game server's `profiles/OpenZone/Storage/xchg` directory, on this machine |
| `STORAGE_KEEP_VERSIONS_DAYS` | 14 | versions older than this go, except each box's current one |
| `STORAGE_KEEP_EVENTS_DAYS` | 90 | events older than this go |

### From the console

`node scripts/storage.mjs <command>` talks to the running bridge with the shared
secret from `.env` (never printed). Reads: `boxes`, `box <id>`, `history <id>`,
`player <steam64>`, `find <class>` (with who took it last), `parked`, `version <n>`,
`diff <a> <b>` (the classes that go and come between two versions), `health`. Changes
to a closed box, taking effect at its next open: `rollback <id> <version>`,
`unpark <parkedId>`, `discard <parkedId>`, `give <id> <class> [qty]`, `empty <id>`,
`shelve <id> <root>` (a root onto the shelf of parked roots), `move <from> <root> <to>`
(a root into another closed box; it takes a free cell at that box's next open),
`edit <id> <root> <node> [qty=N] [health=N] [reset]` (quantity and health of one item;
an item that carries mod state needs `reset`, which drops the mod state of its whole
tree). Live, answered by the engine within a few seconds: `close <id>`, `remove <id>`
(a closed box only), `report <id>`; `result <ref>` reads the answer later. Every
change is an event with the admin's name.

### The admin web

`ADMIN_PORT` (8788) serves the admin site on **127.0.0.1 only**: one site, one door per
kind (`POST /admin/v1/<kind>/<op>` over the very operations the console uses), with the
storage pages and the research pages behind it. Storage: the boxes with search, filters
and sorting; a box's grid, its contents as a tree with edit, shelf, move and give on each
row, its versions as a timeline with a diff between any two and a rollback, and a live
panel where the game's answers to report, close and remove land as they come; the shelf,
find, a player's takings, the health, a journal of admin actions, and a map of boxes on
the world's grid (`ADMIN_MAP_SIZE`, `ADMIN_MAP_IMAGE`). Research: the nine configs and
their editor (below), the factions with their pools, the statics, the journal. A journal
across both kinds merges them by time; a switch in the header picks the game server when
the bridge has heard from more than one. Every confirmation is a second press in place;
Ukrainian and English by a switch in the header.

The site is `web-src/` (Vite + React 19 + TypeScript) built into `web/dist/` by
`npm run build`; the bridge serves that directory and answers with a page that says so
when it is missing. `npm run dev` serves the site from source with a proxy to a running
bridge on 8788.

Sign-in is optional and turns on with `ADMIN_URL`, the page's address as a browser
sees it. Without it the page has no sign-in and asks for a name to sign the log
with; it is safe only because nothing but this machine reaches 127.0.0.1 -- do
not put a reverse proxy in front of it in that mode. With `ADMIN_URL` the page
sends admins to Discord and admits holders of one of the roles in
`DISCORD_ADMIN_ROLE_ID` (several ids, comma-separated); then
`DISCORD_CLIENT_SECRET`, `DISCORD_CLIENT_ID` and `DISCORD_GUILD_ID` are required,
and the Developer Portal must list `<ADMIN_URL>/auth/callback` under OAuth2 ->
Redirects. Sessions last twelve hours and live in memory: a restart signs
everyone out. A reverse proxy belongs in front of the page only with
`ADMIN_URL` and its sign-in; the bridge refuses forwarded requests otherwise.
The proxy must pass the path without a prefix, e.g.
`location /admin/ { proxy_pass http://127.0.0.1:8788/; }`.
| `.env` key | Default | Meaning |
|---|---|---|
| `ADMIN_PORT` | 8788 | the admin page's port, on 127.0.0.1; 0 turns the page off |
| `ADMIN_URL` | unset | the page's address as a browser sees it; turns Discord sign-in on |
| `DISCORD_CLIENT_SECRET` | unset | Developer Portal -> OAuth2; required with ADMIN_URL; secret |
| `DISCORD_ADMIN_ROLE_ID` | unset | the admin roles, comma-separated; required with ADMIN_URL |
| `ADMIN_MAP_SIZE` | 15360 | the world's size in metres for the map page's grid (Chernarus) |
| `ADMIN_MAP_IMAGE` | unset | a map image the page draws under the boxes' pins, served as `admin/map.png` |

## Research configs

The bridge is the editor and the history of the nine configs of `OpenZone_Research`
(design: `docs/specs/2026-09-20-openzone-research-bridge-design.md` in the series hub).
The truth of a config stays the file in the game server's profile; the bridge reads it
itself when the game boots (`/v1/research/boot`) and after every applied edit
(`/v1/research/changed`), and keeps every version of the text, deduplicated by a
canonical hash so the game's rewrite of a candidate promotes it instead of doubling it.
A change is a candidate: shape-checked, written into `research/xchg/`, announced to the
game as a `cfg_apply` command in its poll, pending until the game answers
(`/v1/research/result`) -- applied, or refused with the game's reason and the file left
for the admin to look at. Live commands (`reset`, `grant`, `complete`, `reload`,
`respawn`) ride the same poll; a command the game has not answered is re-sent on the
server's first poll after a restart of either side. Without `RESEARCH_DIR` every research
route refuses and the game keeps its configs to itself (the VPP editor still works).

| `.env` key | Default | Meaning |
|---|---|---|
| `RESEARCH_DIR` | unset | the game server's `profiles/OpenZone` directory, on this machine |
| `RESEARCH_XCHG_DIR` | `<RESEARCH_DIR>/research/xchg` | the exchange directory, when it is elsewhere |
| `RESEARCH_KEEP_VERSIONS_DAYS` | 30 | versions older than this go, except each config's current one and any pending candidate |
| `RESEARCH_KEEP_EVENTS_DAYS` | 90 | journal entries and answered commands older than this go |
| `PROFILE_DIR` | `RESEARCH_DIR` | the game server's `profiles/OpenZone` directory, where the core writes its class dump (`classes.tsv`) at every start |

### From the console

`node scripts/research.mjs <command>`: `configs`, `get <name> [version] [--out file]`,
`put <name> <file>` (a candidate; waits for the game's answer), `history <name>`,
`restore <name> <version>`, `state` (the factions' pools, nodes and projects), `classes`
(the server's classes, dumped at boot; `--out` writes them as a table), `reset <owner>`, `grant <owner> <type> <n>`,
`complete <owner> <node>`, `reload`, `respawn <id>`, `result <token>`, `wait <token>`,
`events`, `status`. Exit codes: 0 done, 1 refused by the bridge or the game, 2 usage,
3 the bridge does not answer, 4 the game did not answer in time.

### The editor

The admin site edits each config as a table of its rows with a form for the chosen row
(rules and tree nodes grouped by their groups and branches), checks the text the way the
game will -- a mirror of every `Validate()` and `Check()`, weighed as the game weighs it:
dropped, disabled, a warning, a note -- against the server's own class list, the point
types, the tree and the owners, and sends it as a candidate. The tree has a canvas (a
column per Tier; a drag between columns sets the Tier, a connection adds a parent unless
it would close a cycle) and a balance of what grants points against what the tree
spends, per owner; the rules have a chain canvas with an edge wherever an output feeds
an input by the station's own match, and the dead samples and unfed inputs named. The
text and the history are tabs; a starter pack goes in as a zip of the nine files.

### The class index (the kind `core`)

Every class the server knows -- its five roots (`CfgVehicles`, `CfgMagazines`,
`CfgNonAIVehicles`, `CfgAmmo`, `cfgWeapons`) with the parent of each class and its game
name in two languages -- comes from the game itself, and from the core rather than from
any one mod, because every mod's editor needs it. At every start `OpenZone_Core` dumps
them into `<PROFILE_DIR>/classes.tsv`, reading the `original` and the `english` column
of every `stringtable.csv` it can open in the loaded archives (the series' mods, CF,
VPP); a class whose key no table holds gets the name the server itself resolves, in its
own language, which is how vanilla comes out English. The bridge reads the file at the
server's first poll (and again after the game restarts) into an index per server, kept
in SQL, and the site reads the chosen server's under the `Server` section: the research
editor's live search (a class name or a game name, in either language), the family test
of the chain canvas (`IsKindOf` from the real inheritance), the game names on the cards,
the existence checks and the storage boxes' `give` form all use it. Nothing to import: a
restart with other mods brings another list (the stand: 12 937 classes, 6 stringtables,
about a second of the start).

### Sections blocked for mods the server does not run

The bridge remembers, per game server, when it last started (its first poll after a
start) and which kinds have booted since -- storage sends its boot letter at mission
start, research at start and on the bridge's request. A kind that never booted half a
minute after the server's start is a mod the server does not load: the site dims the
kind in the header and shows why instead of its pages, until a boot arrives. The
memory survives a bridge restart, so a storage mod that boots only with the server is
not forgotten when the bridge alone comes back.
## State

Everything the bridge remembers -- account links, conversation keys, the chat
tail, news, invites -- lives in one SQLite file, `state/bridge.sqlite` by
default (`BRIDGE_DB` in `.env`). Writes are atomic and the chat tail is read
from a cursor, not by loading the whole file; a line that exists only here is
never evicted.

A fresh host needs nothing but a filled-in `.env`: the `state/` directory and
the database file are created on first start. Back it up like any small
database -- copy the `.sqlite` file while the bridge is stopped, or use
`sqlite3 state/bridge.sqlite ".backup state/bridge.bak"` while it runs.

For unattended hosting:

- **Linux**: a systemd unit ships in `deploy/openzone-bridge.service`; the
  install commands are at the top of the file. `journalctl -u openzone-bridge -f`
  for logs.
- **Windows**: register a Scheduled Task that runs at boot:

  ```
  schtasks /create /tn OpenZoneBridge /sc onstart /ru SYSTEM /tr "powershell -NoProfile -ExecutionPolicy Bypass -File C:\path\to\openzone-bridge\run.ps1 -Loop"
  ```

  Adjust the path; the task survives logout, a console window does not.

## Security

The DayZ server is the only party that talks to the bridge. The shared secret travels
in the request body, because DayZ cannot set an `Authorization` header, so the endpoint
**must** be HTTPS. Game clients never see it.

The listener binds **loopback only** unless `BRIDGE_HOST` says otherwise: a bridge on
the same host as the game server needs nothing else, and a bridge that answered every
interface offered every player's private conversation to whoever guessed one string.
Set `BRIDGE_HOST=0.0.0.0` only behind a TLS terminator.

The storage admin page listens on 127.0.0.1 only. It checks the `Host` header, wants
a custom header and a JSON body on its api and refuses cross-site fetches, cannot be
framed (`X-Frame-Options`, a `frame-ancestors 'none'` policy), and refuses forwarded
requests while sign-in is off, so a browser on the same machine cannot be turned
against it by a page it visits; without `ADMIN_URL` and its Discord sign-in that is
all there is, which is why that mode must never be exposed.

## Status

Working, and exercised against a live guild — private threads created, messages
posted through a webhook, the game's long poll served for hours at a stretch, and
the bridge's own echo suppressed so a player never sees his line twice.

Not production-ready, and the gaps are named rather than hidden: no HTTPS (a plain
`node:http` listener, while the shared secret travels in the body), no outbound
queue or retry, no rate limiting, no input validation, no process supervision, no
health check anybody reads.

Run it behind a TLS terminator and treat `OZ_SHARED_SECRET` as what it is:
credentials to every player's private conversations.

## Licence

CC BY-NC-SA 4.0 with an additional permission — see `LICENSE` and `NOTICE`.

// The shell: the kinds across the top, the pages of the chosen kind down
// the side, the admin and the language on the right, the page in the
// middle. The hash says where we are.

import { useMemo, useState, type ReactNode } from 'react';
import { logout } from '../api/client';
import { LangContext, rememberLang, rememberedLang, translate, type Key, type Lang } from '../i18n';
import { href, useRoute, type Route } from './router';
import { SessionProvider, useSession } from './session';
import { ServersProvider, useServers, type ServerInfo } from './servers';
import { ToastProvider } from './toasts';
import { BoxesPage } from '../storage/BoxesPage';
import { BoxPage } from '../storage/BoxPage';
import { FindPage, HealthPage, PlayerPage, ShelfPage, StorageJournalPage } from '../storage/pages';
import { MapPage } from '../storage/MapPage';
import { ConfigsPage, FactionsPage, ResearchJournalPage, StaticsPage } from '../research/pages';
import { EditorPage } from '../research/editor/EditorPage';
import { ClassesPage } from '../core/classes/ClassesPage';
import { JournalPage } from './JournalPage';

export function App() {
  const [lang, setLangState] = useState<Lang>(rememberedLang());
  const i18n = useMemo(() => ({
    lang,
    setLang: (l: Lang) => {
      rememberLang(l);
      setLangState(l);
    },
    s: (key: Key, vars?: Record<string, string | number>) => translate(lang, key, vars),
  }), [lang]);
  document.documentElement.lang = lang;
  return (
    <LangContext.Provider value={i18n}>
      <ToastProvider>
        <SessionProvider>
          <ServersProvider>
            <Shell />
          </ServersProvider>
        </SessionProvider>
      </ToastProvider>
    </LangContext.Provider>
  );
}

const KIND_KEY = { storage: 'kind_storage', research: 'kind_research', core: 'kind_core' } as const;

const SIDE: Record<'storage' | 'research' | 'core', { page: string; key: Key }[]> = {
  storage: [
    { page: 'boxes', key: 'nav_boxes' },
    { page: 'shelf', key: 'nav_shelf' },
    { page: 'find', key: 'nav_find' },
    { page: 'player', key: 'nav_player' },
    { page: 'map', key: 'nav_map' },
    { page: 'health', key: 'nav_health' },
    { page: 'journal', key: 'nav_journal' },
  ],
  research: [
    { page: 'configs', key: 'nav_configs' },
    { page: 'factions', key: 'nav_factions' },
    { page: 'statics', key: 'nav_statics' },
    { page: 'journal', key: 'nav_journal' },
  ],
  // The server itself: what the core tells the bridge, no mod's section.
  core: [
    { page: 'classes', key: 'nav_classes' },
  ],
};

function Shell() {
  const { s, lang, setLang } = i18nOf();
  const route = useRoute();
  const session = useSession();
  const { servers, current, choose, blocked } = useServers();
  document.title = s('title');
  const kind = route.kind === 'all' ? null : route.kind;
  const off = kind && kind !== 'core' ? blocked(kind) : null;
  const gate = session.ready && session.auth && !session.name;
  return (
    <div className="shell">
      <header className="top">
        <a className="brand" href={href('storage', 'boxes')}>{s('title')}</a>
        <nav className="kinds">
          <a className={`${route.kind === 'storage' ? 'on' : ''}${blocked('storage') ? ' off' : ''}`} href={href('storage', 'boxes')} title={blocked('storage') ? s('blocked_short', { mod: 'OpenZone_Storage' }) : undefined}>{s('kind_storage')}</a>
          <a className={`${route.kind === 'research' ? 'on' : ''}${blocked('research') ? ' off' : ''}`} href={href('research', 'configs')} title={blocked('research') ? s('blocked_short', { mod: 'OpenZone_Research' }) : undefined}>{s('kind_research')}</a>
          <a className={route.kind === 'core' ? 'on' : ''} href={href('core', 'classes')}>{s('kind_core')}</a>
          <a className={route.kind === 'all' ? 'on' : ''} href={href('all', 'journal')}>{s('nav_journal')}</a>
        </nav>
        <div className="who">
          {servers.length > 1 && (
            <label className="row small">
              <span className="muted">{s('server')}</span>
              <select value={current} onChange={(e) => choose(e.target.value)}>
                {servers.map((x) => <option key={x.id} value={x.id}>{x.id}</option>)}
              </select>
            </label>
          )}
          <Who />
          <span className="lang">
            <button type="button" className={`small${lang === 'uk' ? ' on' : ''}`} onClick={() => setLang('uk')}>UK</button>
            <button type="button" className={`small${lang === 'en' ? ' on' : ''}`} onClick={() => setLang('en')}>EN</button>
          </span>
        </div>
      </header>
      <div className="body">
        {kind && (
          <aside className="side">
            <div className="group">{s(KIND_KEY[kind])}</div>
            {SIDE[kind].map((item) => (
              <a key={item.page} className={route.page === item.page || (route.page === 'box' && item.page === 'boxes') || (route.page === 'config' && item.page === 'configs') ? 'on' : ''} href={href(kind, item.page)}>{s(item.key)}</a>
            ))}
          </aside>
        )}
        <main>
          {!session.ready ? <div className="empty">{s('loading')}</div> : gate ? <Gate /> : off && kind && kind !== 'core' ? <BlockedKind kind={kind} server={off} /> : <Page route={route} />}
        </main>
      </div>
    </div>
  );
}

function i18nOf() {
  // A tiny indirection so Shell reads like the other components.
  return useLangContext();
}

import { useLang as useLangContext } from '../i18n';

function Who() {
  const { s } = i18nOf();
  const session = useSession();
  if (session.auth && session.name) {
    return (
      <>
        <span>{s('signed_in_as')} <b>{session.name}</b></span>
        <button type="button" className="small ghost" onClick={() => logout()}>{s('sign_out')}</button>
      </>
    );
  }
  if (session.auth) return <a className="button small" href="auth/login">{s('sign_in')}</a>;
  return (
    <input
      size={18}
      placeholder={s('your_name')}
      defaultValue={session.typedName === 'web' ? '' : session.typedName}
      onBlur={(e) => session.setTypedName(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

const MOD_OF: Record<string, string> = { storage: 'OpenZone_Storage', research: 'OpenZone_Research' };

// The section of a mod the chosen server does not run: no page, a reason.
function BlockedKind({ kind, server }: { kind: 'storage' | 'research'; server: ServerInfo }) {
  const { s } = i18nOf();
  const { refresh } = useServers();
  const others = Object.entries(server.kinds || {}).map(([k, at]) => `${MOD_OF[k] || k} (${at.slice(0, 19).replace('T', ' ')})`);
  return (
    <div className="gate">
      <h1>{s(kind === 'storage' ? 'kind_storage' : 'kind_research')}</h1>
      <p className="alert">{s('blocked_title', { mod: MOD_OF[kind], server: server.id })}</p>
      <p className="muted">{s('blocked_text', { since: server.since ? server.since.slice(0, 19).replace('T', ' ') : '?' })}</p>
      {others.length > 0 && <p className="muted small">{s('blocked_others')}: {others.join(', ')}</p>}
      <button type="button" onClick={refresh}>{s('blocked_again')}</button>
    </div>
  );
}

function Gate() {
  const { s } = i18nOf();
  return (
    <div className="gate">
      <h1>{s('title')}</h1>
      <p className="muted">{s('sign_in_first')}</p>
      <a className="button primary" href="auth/login">{s('sign_in')}</a>
    </div>
  );
}

function Page({ route }: { route: Route }): ReactNode {
  if (route.kind === 'all') return <JournalPage />;
  if (route.kind === 'core') return <ClassesPage />;
  if (route.kind === 'research') {
    if (route.page === 'config' && route.arg) return <EditorPage name={route.arg} />;
    if (route.page === 'factions') return <FactionsPage />;
    if (route.page === 'statics') return <StaticsPage />;
    if (route.page === 'journal') return <ResearchJournalPage />;
    return <ConfigsPage />;
  }
  if (route.page === 'box' && route.arg) return <BoxPage id={route.arg} />;
  if (route.page === 'shelf') return <ShelfPage />;
  if (route.page === 'find') return <FindPage type={route.arg} />;
  if (route.page === 'player') return <PlayerPage uid={route.arg} />;
  if (route.page === 'map') return <MapPage />;
  if (route.page === 'health') return <HealthPage />;
  if (route.page === 'journal') return <StorageJournalPage />;
  return <BoxesPage />;
}

// Two dictionaries, one switch. A key missing from the chosen language
// falls back to English, then to the key itself; the test makes sure no
// key is missing from either.

import { createContext, useContext } from 'react';
import { en } from './en';
import { ua } from './ua';
import { remember } from '../api/client';

export type Lang = 'en' | 'ua';
export type Key = keyof typeof en;

const DICT: Record<Lang, Record<Key, string>> = { en, ua };

export function translate(lang: Lang, key: Key, vars?: Record<string, string | number>): string {
  let t = DICT[lang][key] || en[key] || key;
  if (vars) for (const k of Object.keys(vars)) t = t.split(`{${k}}`).join(String(vars[k]));
  return t;
}

// Only English is looked for, so anything else stored, the old 'uk' of
// earlier builds included, is Ukrainian, which is the default.
export function rememberedLang(): Lang {
  try {
    return localStorage.getItem('oz_lang') === 'en' ? 'en' : 'ua';
  } catch {
    return 'ua';
  }
}

// What the page's lang attribute says. The browser reads it as an ISO 639
// code (spelling, hyphenation, screen readers) and knows no language "ua".
export function htmlLang(lang: Lang): string {
  return lang === 'ua' ? 'uk' : lang;
}

export function rememberLang(lang: Lang): void {
  remember('oz_lang', lang);
}

export type I18n = { lang: Lang; setLang: (l: Lang) => void; s: (key: Key, vars?: Record<string, string | number>) => string };

export const LangContext = createContext<I18n>({ lang: 'ua', setLang: () => {}, s: (k, v) => translate('ua', k, v) });

export function useLang(): I18n {
  return useContext(LangContext);
}

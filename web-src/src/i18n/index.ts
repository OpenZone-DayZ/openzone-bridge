// Two dictionaries, one switch. A key missing from the chosen language
// falls back to English, then to the key itself; the test makes sure no
// key is missing from either.

import { createContext, useContext } from 'react';
import { en } from './en';
import { uk } from './uk';
import { remember } from '../api/client';

export type Lang = 'en' | 'uk';
export type Key = keyof typeof en;

const DICT: Record<Lang, Record<Key, string>> = { en, uk };

export function translate(lang: Lang, key: Key, vars?: Record<string, string | number>): string {
  let t = DICT[lang][key] || en[key] || key;
  if (vars) for (const k of Object.keys(vars)) t = t.split(`{${k}}`).join(String(vars[k]));
  return t;
}

export function rememberedLang(): Lang {
  try {
    return localStorage.getItem('oz_lang') === 'en' ? 'en' : 'uk';
  } catch {
    return 'uk';
  }
}

export function rememberLang(lang: Lang): void {
  remember('oz_lang', lang);
}

export type I18n = { lang: Lang; setLang: (l: Lang) => void; s: (key: Key, vars?: Record<string, string | number>) => string };

export const LangContext = createContext<I18n>({ lang: 'uk', setLang: () => {}, s: (k, v) => translate('uk', k, v) });

export function useLang(): I18n {
  return useContext(LangContext);
}

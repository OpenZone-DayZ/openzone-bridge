import { afterEach, describe, expect, it, vi } from 'vitest';
import { htmlLang, rememberedLang } from './index';

// A localStorage that holds one value under oz_lang, or throws the way a
// page with blocked storage does.
function stored(value: string | null | Error): void {
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => {
      if (value instanceof Error) throw value;
      return key === 'oz_lang' ? value : null;
    },
  });
}

describe('the remembered language', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is English only when English is stored', () => {
    stored('en');
    expect(rememberedLang()).toBe('en');
  });

  it('is Ukrainian for the new code, the old uk of earlier builds, nothing stored and no storage', () => {
    for (const value of ['ua', 'uk', null]) {
      stored(value);
      expect(rememberedLang()).toBe('ua');
    }
    stored(new Error('blocked'));
    expect(rememberedLang()).toBe('ua');
  });
});

describe('the lang attribute', () => {
  it('keeps the ISO code the browser knows', () => {
    expect(htmlLang('ua')).toBe('uk');
    expect(htmlLang('en')).toBe('en');
  });
});

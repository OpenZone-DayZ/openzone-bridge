import { describe, expect, it } from 'vitest';
import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { displayNameOf, hasClass, isKindOf, parseClassIndexJson, searchClasses } from './classIndex.ts';
import { createMergeState, finalizeIndex, mergeParseResult, parsePboSource, type FileLike } from './classImportCore.ts';

const raw = {
  v: 3,
  generated: '2026-09-20',
  mods: ['@OpenZone_Research', 'vanilla'],
  classes: [
    ['Inventory_Base', -1, 1, 0, '', ''],
    ['OZL_Sample_Base', 0, 0, 0, 'Зразок', 'Sample'],
    ['OZL_Sample_01', 1, 0, 0, 'Проба яблука', 'Apple sample'],
    ['OZL_Sample_02', 1, 0, 0, '', ''],
    ['Apple', 0, 1, 0, 'Apple', 'Apple'],
    ['AKM', -1, 1, 4, 'AKM', 'AKM'],
  ],
};

describe('the class index', () => {
  const index = parseClassIndexJson(raw);
  it('parses v3 rows and v2 rows alike', () => {
    expect(index.classes.length).toBe(6);
    const v2 = parseClassIndexJson({ v: 2, mods: ['m'], classes: [['X', -1, 0, 0, 'Ікс']] });
    expect(v2.classes[0][5]).toBe('Ікс');
  });
  it('refuses garbage loudly', () => {
    expect(() => parseClassIndexJson({ v: 3, mods: [], classes: [['X']] })).toThrow();
    expect(() => parseClassIndexJson(null)).toThrow();
  });
  it('names a class in the chosen language, inheriting from the parent', () => {
    expect(displayNameOf(index, 'OZL_Sample_01', 'uk')).toBe('Проба яблука');
    expect(displayNameOf(index, 'OZL_Sample_01', 'en')).toBe('Apple sample');
    expect(displayNameOf(index, 'ozl_sample_02', 'en')).toBe('Sample');
    expect(displayNameOf(index, 'Inventory_Base', 'uk')).toBe('Inventory_Base');
    expect(displayNameOf(index, 'Nope', 'uk')).toBe('Nope');
  });
  it('knows the family the way IsKindOf does', () => {
    expect(isKindOf(index, 'OZL_Sample_01', 'OZL_Sample_Base')).toBe(true);
    expect(isKindOf(index, 'ozl_sample_01', 'inventory_base')).toBe(true);
    expect(isKindOf(index, 'Apple', 'OZL_Sample_Base')).toBe(false);
    expect(isKindOf(index, 'OZL_Sample_01', 'OZL_Sample_01|1')).toBe(true);
    expect(isKindOf(index, 'OZL_Sample_02', 'OZL_Sample_01|1')).toBe(false);
    expect(hasClass(index, 'akm|1')).toBe(true);
  });
  it('searches names first, then display names', () => {
    expect(searchClasses(index, 'ozl_s', 10, 'uk').map((h) => h.name)).toEqual(['OZL_Sample_Base', 'OZL_Sample_01', 'OZL_Sample_02']);
    expect(searchClasses(index, 'яблук', 10, 'uk').map((h) => [h.name, h.display])).toEqual([['OZL_Sample_01', 'Проба яблука']]);
    expect(searchClasses(index, 'apple', 10, 'en').map((h) => h.name)).toEqual(['Apple', 'OZL_Sample_01']);
    expect(searchClasses(index, '', 10)).toEqual([]);
  });
});

// A FileLike over a file on disk: what the browser gives the importer, from Node.
function fileOnDisk(path: string): FileLike {
  const st = statSync(path);
  return {
    name: path.split(/[\\/]/).pop() || path,
    size: st.size,
    lastModified: st.mtimeMs,
    async slice(start, end) {
      const fd = openSync(path, 'r');
      try {
        const buf = new Uint8Array(Math.max(0, end - start));
        readSync(fd, buf, 0, buf.length, start);
        return buf;
      } finally {
        closeSync(fd);
      }
    },
  };
}

// The real mod PBO on this machine, when it is there: the whole pipeline
// from the PBO's header to display names in two languages.
const PBO = 'E:/openzone/openzone-research/@OpenZone_Research/addons/OpenZone_Research.pbo';

describe.skipIf(!existsSync(PBO))('the importer on the research mod PBO', () => {
  it('reads the classes and resolves their names from the stringtable', async () => {
    const result = await parsePboSource(fileOnDisk(PBO));
    expect(result.error).toBeNull();
    expect(result.hadValidConfig).toBe(true);
    const state = createMergeState();
    mergeParseResult(state, '@OpenZone_Research', result);
    const index = parseClassIndexJson(finalizeIndex(state, '2026-09-20'));
    expect(hasClass(index, 'OZL_Microscope')).toBe(true);
    expect(isKindOf(index, 'OZL_Sample_03', 'OZL_Sample_Base')).toBe(true);
    const uk = displayNameOf(index, 'OZL_Sample_01', 'uk');
    const en = displayNameOf(index, 'OZL_Sample_01', 'en');
    expect(uk.startsWith('$')).toBe(false);
    expect(en.startsWith('$')).toBe(false);
    expect(uk).not.toBe('OZL_Sample_01');
  });
});

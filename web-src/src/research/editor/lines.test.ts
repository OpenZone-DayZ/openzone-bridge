import { describe, expect, it } from 'vitest';
import { parseClassIndexJson } from '../../core/classes/classIndex';
import { basePurityOf, classFacts, sameLine, startPurity } from './lines';

// A server's index in miniature: the mod's bases, one line's classes, a
// subclass of a sample, a sample the mirror has never heard of, a vanilla
// item and a magazine.
const index = parseClassIndexJson({
  v: 4,
  generated: 'test',
  mods: ['server'],
  classes: [
    ['Inventory_Base', -1, 0, 0, '', ''],
    ['OZL_Sample_Base', 0, 0, 0, '', ''],
    ['OZL_Sample_Bio', 1, 0, 0, 'Біопроба', 'Bio sample'],
    ['MyBioSample', 2, 0, 0, '', ''],
    ['OZL_Sample_Mutant', 1, 0, 0, '', ''],
    ['OZL_StaticDevice_Base', 0, 0, 0, '', ''],
    ['OZL_Packer_Base', 5, 0, 0, '', ''],
    ['OZL_Eco_Pack_Bio', 6, 0, 0, '', ''],
    ['Rag', 0, 0, 0, 'Ганчірка', 'Rag'],
    ['Mag_STANAG_30Rnd', -1, 0, 1, '', ''],
  ],
});

describe('class facts', () => {
  it('reads the role from the hierarchy and the line from the mirror, inherited', () => {
    const f = classFacts(index);
    expect([f.role('OZL_Sample_Bio'), f.line('OZL_Sample_Bio')]).toEqual(['sample', 'bio']);
    expect([f.role('MyBioSample'), f.line('MyBioSample')]).toEqual(['sample', 'bio']);
    expect([f.role('OZL_Eco_Pack_Bio'), f.line('OZL_Eco_Pack_Bio|1')]).toEqual(['packer', 'bio']);
    expect([f.role('Rag'), f.line('Rag')]).toEqual([null, '']);
    expect(f.line('OZL_Sample_Base')).toBe('');
  });
  it('says it does not know the line of a sample the mirror has never seen', () => {
    const f = classFacts(index);
    expect([f.role('OZL_Sample_Mutant'), f.line('OZL_Sample_Mutant')]).toEqual(['sample', null]);
    expect(sameLine(f, 'OZL_Eco_Pack_Bio', 'OZL_Sample_Mutant')).toBeUndefined();
    expect(sameLine(f, 'OZL_Eco_Pack_Bio', 'OZL_Sample_Bio')).toBe(true);
    expect(sameLine(f, 'OZL_Eco_Pack_Bio', 'OZL_Sample_Base')).toBe(false);
  });
  it('knows existence and magazines from the index, ignoring case and the |1 mark', () => {
    const f = classFacts(index);
    expect([f.exists('rag'), f.exists('OZL_Sample_Bio|1'), f.exists('Nope')]).toEqual([true, true, false]);
    expect([f.isMagazine('Mag_STANAG_30Rnd'), f.isMagazine('Rag'), f.isMagazine('Nope')]).toEqual([true, false, null]);
  });
  it('falls back to the mod naming without an index', () => {
    const f = classFacts(null, ['Rag']);
    expect([f.exists('Rag'), f.exists('Apple')]).toEqual([true, false]);
    expect(classFacts(null).exists('Rag')).toBeNull();
    expect([f.role('OZL_Sky_Proc_Anom'), f.line('OZL_Sky_Proc_Anom')]).toEqual(['analyzer', 'anomaly']);
    expect([f.role('OZL_Tool_Dosimeter'), f.line('OZL_Tool_Dosimeter')]).toEqual(['module', 'khabar']);
    expect([f.role('OZL_Carrier_Trail'), f.line('OZL_Carrier_Trail')]).toEqual(['carrier', 'trails']);
    expect([f.role('OZL_Bnd_Terminal_Painted'), f.line('OZL_Bnd_Terminal_Painted')]).toEqual(['terminal', '']);
    expect(f.kindOf('OZL_Dty_Pack_Ball', 'OZL_StaticDevice_Base')).toBe(true);
    expect(f.kindOf('Rag', 'OZL_Sample_Base')).toBe(false);
  });
});

describe('purity', () => {
  const pts = { PointTypes: [{ Id: 'bio', BasePurity: 0.5 }, { Id: 'khabar', BasePurity: 0 }, { Id: 'trails', BasePurity: 1.4 }] };
  it('takes a line base, 0 as not set, above 1 as 1, and nothing for a missing type', () => {
    expect([basePurityOf(pts, 'bio'), basePurityOf(pts, 'khabar'), basePurityOf(pts, 'trails'), basePurityOf(pts, 'anomaly')]).toEqual([0.5, 0.7, 1, null]);
  });
  it('starts a cycle from the rule, else the station line, else the sample line, else 0.7', () => {
    const f = classFacts(null);
    const own = startPurity({ Purity: 0.9, Device: 'OZL_Eco_Pack_Bio' }, f, pts);
    expect([own.purity, own.own]).toEqual([0.9, true]);
    const line = startPurity({ Purity: -1, Device: 'OZL_Eco_Pack_Bio' }, f, pts);
    expect([line.purity, line.line]).toEqual([0.5, 'bio']);
    expect(startPurity({ Purity: 0, Device: 'OZL_Eco_Pack_Bio' }, f, pts).purity).toBe(0.5);
    const bySample = startPurity({ Purity: -1, Device: 'SomeBench', Outputs: [{ Classname: 'OZL_Sample_Bio' }] }, f, pts);
    expect([bySample.purity, bySample.line]).toEqual([0.5, 'bio']);
    expect(startPurity({ Purity: -1, Device: 'OZL_Eco_Pack_Anom' }, f, pts).purity).toBe(0.7);
  });
});

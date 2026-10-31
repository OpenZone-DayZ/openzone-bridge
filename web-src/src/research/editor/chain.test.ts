import { describe, expect, it } from 'vitest';
import { normalize } from './schema';
import { buildChain, matchClass } from './chain';

describe('the match the station runs', () => {
  it('matches exactly with a suffix and by family without', () => {
    expect(matchClass('OZL_Sample_Bio', 'OZL_Sample_Bio|1')).toBe(true);
    expect(matchClass('ozl_sample_bio', 'OZL_Sample_Bio|1')).toBe(true);
    expect(matchClass('OZL_Sample_Bio', 'OZL_Sample_Anom|1')).toBe(false);
    expect(matchClass('OZL_Sample_Bio', 'OZL_Sample_Base')).toBe(true);
    expect(matchClass('Rag', 'OZL_Sample_Base')).toBe(false);
    expect(matchClass('Rag', 'Inventory_Base')).toBe(true);
    expect(matchClass('Rag', '')).toBe(false);
  });
});

describe('the chain graph of the lines', () => {
  const doc = normalize('ResearchRules', { Version: 3, Groups: [{ Id: 'g', Rules: [
    { Id: 'pack', Device: 'OZL_Eco_Pack_Bio', InputItem: { Classname: 'Rag' }, Outputs: [{ Classname: 'OZL_Sample_Bio', Points: 5 }] },
    { Id: 'proc', Device: 'OZL_Eco_Proc_Bio', InputItem: { Classname: 'OZL_Sample_Bio' }, Outputs: [{ Classname: 'OZL_Carrier_Bio' }] },
    { Id: 'lonely', Device: 'OZL_Eco_Pack_Anom', InputItem: { Classname: 'Apple' }, Outputs: [{ Classname: 'OZL_Sample_Anom', Points: 1 }] },
    { Id: 'unfed', Device: 'OZL_Bnd_Proc_Khabar', InputItem: { Classname: 'OZL_Sample_Khabar' }, Outputs: [{ Classname: 'OZL_Carrier_Khabar' }] },
    { Id: 'off', Enabled: false, Device: 'OZL_Eco_Proc_Anom', InputItem: { Classname: 'OZL_Sample_Anom' }, Outputs: [{ Classname: 'OZL_Carrier_Anom' }] },
  ] }] });
  const g = buildChain(doc, undefined, new Set(['bio']));
  it('draws packer to analyzer by the sample, and analyzer to the pool of its line', () => {
    expect(g.edges.map((e) => [e.source, e.target, e.classname])).toEqual([
      ['r:0:0', 'r:0:1', 'OZL_Sample_Bio'],
      ['r:0:1', 'p:bio', 'OZL_Carrier_Bio'],
      ['r:0:3', 'p:khabar', 'OZL_Carrier_Khabar'],
    ]);
    expect(g.pools).toEqual([{ key: 'p:bio', line: 'bio', known: true }, { key: 'p:khabar', line: 'khabar', known: false }]);
  });
  it('names the dead sample, the unfed analysis and the pool with no point type, and ignores disabled rules', () => {
    expect(g.breaks.map((b) => [b.kind, b.key])).toEqual([['no-pool', 'r:0:3'], ['dead-output', 'r:0:2'], ['unfed-input', 'r:0:3']]);
    expect(g.nodes.length).toBe(5);
  });
  it('does not count a carrier as a dead end, nor a pool without point types to check', () => {
    expect(g.breaks.some((b) => b.key === 'r:0:1')).toBe(false);
    expect(buildChain(doc).breaks.some((b) => b.kind === 'no-pool')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { normalize } from './schema';
import { buildChain, matchClass, matchInput } from './chain';

describe('the match the station runs', () => {
  it('matches exactly with a suffix and by family without', () => {
    expect(matchClass('OZL_Sample_03', 'OZL_Sample_03|1')).toBe(true);
    expect(matchClass('ozl_sample_03', 'OZL_Sample_03|1')).toBe(true);
    expect(matchClass('OZL_Sample_03', 'OZL_Sample_04|1')).toBe(false);
    expect(matchClass('OZL_Sample_03', 'OZL_Sample_Base')).toBe(true);
    expect(matchClass('Rag', 'OZL_Sample_Base')).toBe(false);
    expect(matchClass('Rag', 'Inventory_Base')).toBe(true);
    expect(matchClass('Rag', '')).toBe(false);
  });
  it('asks for the content only when the input names one', () => {
    expect(matchInput('OZL_Sample_01', 'apple', 'OZL_Sample_Base', '')).toBe(true);
    expect(matchInput('OZL_Sample_01', 'apple', 'OZL_Sample_Base', 'apple')).toBe(true);
    expect(matchInput('OZL_Sample_01', 'pear', 'OZL_Sample_Base', 'apple')).toBe(false);
  });
});

describe('the chain graph', () => {
  const doc = normalize('ResearchRules', { Groups: [{ Id: 'g', Rules: [
    { Id: 'pack', Device: 'OZL_SampleFridge', InputItem: { Classname: 'Apple' }, Outputs: [{ Classname: 'OZL_Sample_01', Content: 'apple' }] },
    { Id: 'proc', Device: 'OZL_Microscope', InputItem: { Classname: 'OZL_Sample_Base', Content: 'apple' }, Outputs: [{ Classname: 'OZL_Carrier_Science', Content: 'bio:3' }] },
    { Id: 'lonely', Device: 'OZL_Microscope', InputItem: { Classname: 'OZL_Sample_Base', Content: 'pear' }, Outputs: [{ Classname: 'OZL_Sample_02', Content: 'mash' }] },
    { Id: 'off', Enabled: false, Device: 'OZL_Microscope', InputItem: { Classname: 'OZL_Sample_Base', Content: 'mash' } },
  ] }] });
  const g = buildChain(doc);
  it('draws an edge where an output feeds an input', () => {
    expect(g.edges.map((e) => [e.source, e.target, e.classname, e.content])).toEqual([['r:0:0', 'r:0:1', 'OZL_Sample_01', 'apple']]);
  });
  it('names the dead sample and the unfed input, and ignores disabled rules', () => {
    expect(g.breaks.map((b) => [b.kind, b.key])).toEqual([['dead-output', 'r:0:2'], ['unfed-input', 'r:0:2']]);
    expect(g.nodes.length).toBe(4);
  });
  it('does not count a carrier as a dead end', () => {
    expect(g.breaks.some((b) => b.key === 'r:0:1')).toBe(false);
  });
});

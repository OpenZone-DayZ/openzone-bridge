import { describe, expect, it } from 'vitest';
import { normalize, parseText, rowsOf, serialize, withRow, blank, RULE } from './schema';
import { parseCarrierState, validate, worst } from './validate';
import { buildTreeCanvas, columnTiers, cyclePath, tierForX, unreachable } from './treeModel';

describe('schema', () => {
  it('normalizes a text into the class order with defaults', () => {
    const doc = normalize('ResearchSettings', { TreeVisibilityDepth: '3', Extra: 1 });
    expect(Object.keys(doc)).toEqual(['Version', 'DefaultOwner', 'ResearchPost', 'BasePost', 'TreeVisibilityDepth']);
    expect(doc.DefaultOwner).toBe('loner');
    expect(doc.TreeVisibilityDepth).toBe(3);
  });
  it('fills nested rows and keeps lists typed', () => {
    const doc = normalize('ResearchRules', { Groups: [{ Id: 'g', Rules: [{ Id: 'r', TimeSec: '12', Outputs: [{ Classname: 'Rag' }] }] }] });
    const rule = rowsOf('ResearchRules', doc)[0].row;
    expect(rule.Enabled).toBe(true);
    expect(rule.TimeSec).toBe(12);
    expect((rule.InputItem as Record<string, unknown>).Quantity).toBe(1);
    expect((rule.Outputs as Record<string, unknown>[])[0].Chance).toBe(1);
    expect(Object.keys(rule)).toEqual(RULE.map((f) => f.key));
  });
  it('serializes the way the game writes: four spaces, the class order', () => {
    const text = serialize('ResearchSettings', { DefaultOwner: 'bandit', Version: 1 });
    expect(text.split('\n')[1]).toBe('    "Version": 1,');
    expect(JSON.parse(text).DefaultOwner).toBe('bandit');
  });
  it('reports text that is not json without throwing', () => {
    expect(parseText('ResearchOwners', '{oops').why).not.toBe('');
    expect(parseText('ResearchOwners', '[]').why).toBe('not an object');
  });
  it('replaces, appends and removes a row without touching the original', () => {
    const doc = normalize('ResearchOwners', { Owners: [{ Id: 'a' }, { Id: 'b' }] });
    const changed = withRow('ResearchOwners', doc, [1], { ...blank(RULE), Id: 'c' });
    expect((doc.Owners as Record<string, unknown>[])[1].Id).toBe('b');
    expect((changed.Owners as Record<string, unknown>[])[1].Id).toBe('c');
    expect((withRow('ResearchOwners', doc, [9], { Id: 'd' }).Owners as unknown[]).length).toBe(3);
    expect((withRow('ResearchOwners', doc, [0], null).Owners as unknown[]).length).toBe(1);
    const rules = normalize('ResearchRules', { Groups: [{ Id: 'g', Rules: [{ Id: 'r1' }, { Id: 'r2' }] }] });
    expect(rowsOf('ResearchRules', withRow('ResearchRules', rules, [0, 0], null)).map((r) => r.row.Id)).toEqual(['r2']);
  });
});

describe('validate', () => {
  it('mirrors the point types checks as drops', () => {
    const doc = normalize('ResearchPointTypes', { PointTypes: [{ Id: 'a', Name: 'A' }, { Id: 'a', Name: 'B' }, { Id: '', Name: 'C' }, { Id: 'd', Name: '' }, { Id: 'e', Name: 'E', Tier: 11 }] });
    const p = validate('ResearchPointTypes', doc);
    expect(p.filter((x) => x.severity === 'drop').map((x) => x.path)).toEqual(['PointTypes[1]', 'PointTypes[2]', 'PointTypes[3]', 'PointTypes[4]']);
    expect(worst(p)).toBe('drop');
  });
  it('mirrors the owners checks', () => {
    const doc = normalize('ResearchOwners', { Owners: [{ Id: 'a b' }, { Id: 'loner', TerminalClasses: ['T', ''] }, { Id: 'bandit' }] });
    const p = validate('ResearchOwners', doc);
    expect(p.map((x) => [x.severity, x.path])).toEqual([
      ['drop', 'Owners[0]'], ['warn', 'Owners[1].TerminalClasses'], ['warn', 'Owners[2]'],
    ]);
  });
  it('disables a rule the way the game does, and warns on unknown classes', () => {
    const doc = normalize('ResearchRules', { Groups: [{ Id: 'g', Rules: [
      { Id: 'fast', TimeSec: 2, Device: 'D', InputItem: { Classname: 'X' } },
      { Id: 'ok', TimeSec: 10, Device: 'OZL_Microscope', InputItem: { Classname: 'Apple' }, Outputs: [{ Classname: 'OZL_Sample_01', Content: 'apple' }] },
      { Id: 'nocontent', TimeSec: 10, Device: 'OZL_Microscope', InputItem: { Classname: 'Apple' }, Outputs: [{ Classname: 'OZL_Sample_01' }] },
      { Id: 'carrier', TimeSec: 10, Device: 'OZL_Microscope', InputItem: { Classname: 'Apple' }, Outputs: [{ Classname: 'OZL_Carrier_Science', Content: 'bio:x' }] },
      { Id: 'off', Enabled: false },
    ] }] });
    const p = validate('ResearchRules', doc, { classes: new Set(['OZL_Microscope', 'Apple', 'OZL_Sample_01', 'OZL_Carrier_Science']), pointTypes: new Set(['bio']) });
    const by = (id: string) => p.filter((x) => x.path.startsWith(`Groups[0].Rules[${['fast', 'ok', 'nocontent', 'carrier', 'off'].indexOf(id)}]`));
    expect(by('fast').map((x) => x.severity)).toEqual(['disable']);
    expect(by('ok')).toEqual([]);
    expect(by('nocontent')[0].message).toContain('has no Content');
    expect(by('carrier')[0].message).toContain('must be <point type>:<1..1000>');
    expect(by('off')[0].severity).toBe('info');
    const unknown = validate('ResearchRules', doc, { classes: new Set(['Apple']) }).filter((x) => x.severity === 'warn');
    expect(unknown.some((x) => x.message.includes("device 'OZL_Microscope' is not in the server's class list"))).toBe(true);
  });
  it('drops a tree node with a doubled cost type and warns on unreachable nodes', () => {
    const doc = normalize('ResearchTree', { Branches: [{ Id: 'b', Nodes: [
      { Id: 'root', Name: 'Root', Cost: [{ Type: 'bio', Amount: 1 }, { Type: 'bio', Amount: 2 }] },
      { Id: 'child', Name: 'Child', Parents: ['nope'] },
      { Id: 'loop1', Name: 'L1', Parents: ['loop2'] },
      { Id: 'loop2', Name: 'L2', Parents: ['loop1'] },
      { Id: 'anyok', Name: 'Any', Parents: ['root', 'nope'], ParentsMode: 'any' },
    ] }] });
    const p = validate('ResearchTree', doc, { pointTypes: new Set(['bio']) });
    expect(p.find((x) => x.path === 'Branches[0].Nodes[0].Cost[1]')?.severity).toBe('drop');
    expect(p.filter((x) => x.path.startsWith('node:')).map((x) => x.path)).toEqual(['node:child', 'node:loop1', 'node:loop2']);
    expect(unreachable(doc)).toEqual(['child', 'loop1', 'loop2']);
  });
  it('knows the mod classes of data items and samples', () => {
    const d = validate('ResearchDataItems', normalize('ResearchDataItems', { Items: [{ Id: 'Rag', Name: 'x' }, { Id: 'OZL_Data_01', Name: 'y', Points: [{ Type: 'nope', Amount: 1 }] }] }), { pointTypes: new Set(['bio']) });
    expect(d.map((x) => [x.severity, x.path])).toEqual([['drop', 'Items[0]'], ['warn', 'Items[1].Points[0]']]);
    const s = validate('ResearchSampleTypes', normalize('ResearchSampleTypes', { Items: [{ Id: 'OZL_Sample_01', Name: 'x' }, { Id: 'ozl_sample_01', Name: 'y' }] }));
    expect(s.map((x) => x.severity)).toEqual(['drop']);
  });
  it('parses a carrier state the way OZL_CarrierState does', () => {
    expect(parseCarrierState('bio:12')).toEqual({ type: 'bio', amount: 12 });
    expect(parseCarrierState('bio:012')).toBeNull();
    expect(parseCarrierState('bio:0')).toBeNull();
    expect(parseCarrierState('bio:1001')).toBeNull();
    expect(parseCarrierState(':1')).toBeNull();
  });
});

describe('tree canvas', () => {
  const doc = normalize('ResearchTree', { Branches: [
    { Id: 'a', Name: 'A', Nodes: [{ Id: 'r', Name: 'R', Tier: 1 }, { Id: 'c', Name: 'C', Tier: 2, Parents: ['r', 'x'] }] },
    { Id: 'b', Name: 'B', Nodes: [{ Id: 'x', Name: 'X', Tier: 1 }] },
  ] });
  it('lays columns by tier and draws a ghost for a parent in another branch', () => {
    const m = buildTreeCanvas(doc, 0);
    expect(m.tiers).toEqual([1, 2, 3]);
    expect(m.cards.map((c) => [c.node.Id, c.x, c.y])).toEqual([['r', 0, 48], ['c', 290, 48]]);
    expect(m.ghosts.map((g) => [g.id, g.branchLabel, g.x, g.y])).toEqual([['x', 'B', 0, 168]]);
    expect(m.edges.map((e) => [e.source, e.target, e.cross])).toEqual([['n:0:0', 'n:0:1', false], ['g:x', 'n:0:1', true]]);
  });
  it('maps a dragged x back to a tier and caps absurd tiers', () => {
    expect(tierForX(300, [1, 2, 3])).toBe(2);
    expect(tierForX(-100, [1, 2, 3])).toBe(1);
    expect(columnTiers([1, 99999]).length).toBe(3);
  });
  it('finds the cycle a new parent would close', () => {
    expect(cyclePath(doc, 'r', 'c')).toEqual(['c', 'r']);
    expect(cyclePath(doc, 'c', 'x')).toBeNull();
  });
});

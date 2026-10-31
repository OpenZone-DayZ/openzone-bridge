import { describe, expect, it } from 'vitest';
import { LATEST, NAMES, normalize, parseText, rowsOf, serialize, withRow, blank, RULE } from './schema';
import { validate, worst } from './validate';
import { buildTreeCanvas, columnTiers, cyclePath, tierForX, unreachable } from './treeModel';

describe('schema', () => {
  it('knows the seven configs the mod loads, at their versions', () => {
    expect([...NAMES]).toEqual(['ResearchSettings', 'ResearchPointTypes', 'ResearchOwners', 'ResearchRules', 'ResearchTree', 'ResearchModules', 'ResearchStatics']);
    expect(LATEST).toEqual({ ResearchSettings: 1, ResearchPointTypes: 3, ResearchOwners: 1, ResearchRules: 3, ResearchTree: 2, ResearchModules: 2, ResearchStatics: 1 });
  });
  it('normalizes a text into the class order with defaults', () => {
    const doc = normalize('ResearchSettings', { TreeVisibilityDepth: '3', Extra: 1 });
    expect(Object.keys(doc)).toEqual(['Version', 'DefaultOwner', 'ResearchPost', 'BasePost', 'TreeVisibilityDepth']);
    expect(doc.DefaultOwner).toBe('loner');
    expect(doc.TreeVisibilityDepth).toBe(3);
  });
  it('fills nested rows the way the classes initialise them and keeps lists typed', () => {
    const doc = normalize('ResearchRules', { Version: 3, Groups: [{ Id: 'g', Rules: [{ Id: 'r', TimeSec: '12', Outputs: [{ Classname: 'Rag' }], InputItem: { Content: 'old' } }] }] });
    const rule = rowsOf('ResearchRules', doc)[0].row;
    expect(rule.Enabled).toBe(true);
    expect(rule.TimeSec).toBe(12);
    expect(rule.Purity).toBe(-1);
    expect(rule.InputItem).toEqual({ Classname: '', Quantity: 1, ConsumeInput: true, RequireFullQuantity: false });
    expect((rule.Outputs as Record<string, unknown>[])[0]).toEqual({ Classname: 'Rag', Quantity: 1, Chance: 1, Points: 0 });
    expect(Object.keys(rule)).toEqual(RULE.map((f) => f.key));
    const pt = normalize('ResearchPointTypes', { PointTypes: [{ Id: 'bio', Name: 'Bio', Tier: 2, Category: 'x' }] });
    expect((pt.PointTypes as Record<string, unknown>[])[0]).toEqual({ Id: 'bio', Name: 'Bio', Icon: '', Color: '', SortOrder: 0, BasePurity: 0.7 });
    expect(Object.keys(pt)).toEqual(['Version', 'PointTypes']);
    const owner = normalize('ResearchOwners', { Owners: [{ Id: 'duty', TreeBackground: 'x' }] });
    expect((owner.Owners as Record<string, unknown>[])[0]).toEqual({ Id: 'duty', TerminalClasses: [], DeviceClasses: [], Skin: '' });
    const mod = normalize('ResearchModules', { Modules: [{ Classname: 'OZL_Tool_Optics', Devices: ['x'] }] });
    expect((mod.Modules as Record<string, unknown>[])[0]).toEqual({ Classname: 'OZL_Tool_Optics', PurityBonus: 0.1, DoubleChance: 0.1, Notes: '' });
  });
  it('serializes the way the game writes: four spaces, the class order, bools as numbers, the latest version', () => {
    const text = serialize('ResearchSettings', { DefaultOwner: 'bandit', Version: 1 });
    expect(text.split('\n')[1]).toBe('    "Version": 1,');
    expect(JSON.parse(text).DefaultOwner).toBe('bandit');
    const rules = JSON.parse(serialize('ResearchRules', { Version: 1, Groups: [{ Id: 'g', Rules: [{ Id: 'r', Enabled: true, InputItem: { ConsumeInput: false } }] }] }));
    expect(rules.Version).toBe(3);
    expect([rules.Groups[0].Rules[0].Enabled, rules.Groups[0].Rules[0].InputItem.ConsumeInput, rules.Groups[0].Rules[0].InputItem.RequireFullQuantity]).toEqual([1, 0, 0]);
    expect(JSON.parse(serialize('ResearchTree', {})).Version).toBe(2);
  });
  it('converts the versions the game converts: rules 2 (Purity 0.7 is the line), point types 2 (0.7 a line)', () => {
    const v2 = parseText('ResearchRules', JSON.stringify({ Version: 2, Groups: [{ Id: 'g', Rules: [{ Id: 'a', Purity: 0.7 }, { Id: 'b', Purity: 0.5 }, { Id: 'c', Purity: 0.70000001 }] }] }));
    expect(v2.version).toBe(2);
    expect(rowsOf('ResearchRules', v2.doc).map((r) => r.row.Purity)).toEqual([-1, 0.5, -1]);
    const v3 = parseText('ResearchRules', JSON.stringify({ Version: 3, Groups: [{ Id: 'g', Rules: [{ Id: 'a', Purity: 0.7 }] }] }));
    expect(rowsOf('ResearchRules', v3.doc)[0].row.Purity).toBe(0.7);
    const pt2 = parseText('ResearchPointTypes', JSON.stringify({ Version: 2, PointTypes: [{ Id: 'bio', Name: 'Bio' }] }));
    expect([pt2.version, pt2.doc.Version, (pt2.doc.PointTypes as Record<string, unknown>[])[0].BasePurity]).toEqual([2, 3, 0.7]);
  });
  it('reports text that is not json without throwing', () => {
    expect(parseText('ResearchOwners', '{oops').why).not.toBe('');
    expect(parseText('ResearchOwners', '[]').why).toBe('not an object');
    expect(parseText('ResearchOwners', '{}').version).toBe(0);
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
  it('mirrors the point types checks: drops keep the last duplicate, the base purity of a line', () => {
    const doc = normalize('ResearchPointTypes', { PointTypes: [
      { Id: 'bio', Name: 'A' }, { Id: 'bio', Name: 'B' }, { Id: '', Name: 'C' }, { Id: 'anomaly', Name: '' },
      { Id: 'khabar', Name: 'K', BasePurity: 0 }, { Id: 'trails', Name: 'T', BasePurity: 1.5, Color: 'red' }, { Id: 'custom', Name: 'X' },
    ] });
    const p = validate('ResearchPointTypes', doc);
    expect(p.filter((x) => x.severity === 'drop').map((x) => x.path)).toEqual(['PointTypes[0]', 'PointTypes[2]', 'PointTypes[3]']);
    expect(p.filter((x) => x.severity === 'warn').map((x) => [x.path, x.message.includes('not set') || x.message.includes('above 1')])).toEqual([
      ['PointTypes[4].BasePurity', true], ['PointTypes[5].BasePurity', true],
    ]);
    expect(p.find((x) => x.path === 'PointTypes[5].Color')?.severity).toBe('info');
    expect(p.find((x) => x.path === 'PointTypes[6]')?.message).toContain('no line of the mod');
    expect(p.find((x) => x.path === 'PointTypes')?.message).toContain('anomaly, electronics, ballistics, protection');
    expect(worst(p)).toBe('drop');
  });
  it('mirrors the owners checks, the skins and the shared stations', () => {
    const doc = normalize('ResearchOwners', { Owners: [
      { Id: 'a b' }, { Id: 'loner', TerminalClasses: ['T', ''], DeviceClasses: ['D'] }, { Id: 'bandit', Skin: 'pink', DeviceClasses: ['D'] }, { Id: 'stalker', Skin: 'duty' },
    ] });
    const p = validate('ResearchOwners', doc);
    expect(p.map((x) => [x.severity, x.path])).toEqual([
      ['drop', 'Owners[0]'],
      ['warn', 'Owners[1].Skin'], ['warn', 'Owners[1].TerminalClasses'],
      ['warn', 'Owners[2].Skin'],
      ['info', 'Owners[1]'],
      ['warn', 'Owners[2]'], ['warn', 'Owners[3]'], ['warn', 'Owners[3]'],
    ]);
    expect(p[3].message).toContain("unknown Skin 'pink'");
    expect(p[1].message).toContain('neutral');
    expect(p[4].message).toContain('share the device D');
  });
  it('disables a rule the way the game does, lines included', () => {
    const rule = (id: string, extra: Record<string, unknown>) => ({ Id: id, TimeSec: 10, ...extra });
    const doc = normalize('ResearchRules', { Groups: [{ Id: 'g', Rules: [
      rule('pack', { Device: 'OZL_Eco_Pack_Bio', InputItem: { Classname: 'Rag' }, Outputs: [{ Classname: 'OZL_Sample_Bio', Points: 5 }] }),
      rule('proc', { Device: 'OZL_Eco_Proc_Bio', InputItem: { Classname: 'OZL_Sample_Bio' }, Outputs: [{ Classname: 'OZL_Carrier_Bio' }] }),
      rule('cross', { Device: 'OZL_Eco_Pack_Anom', InputItem: { Classname: 'Rag' }, Outputs: [{ Classname: 'OZL_Sample_Bio', Points: 5 }] }),
      rule('nopoints', { Device: 'OZL_Eco_Pack_Bio', InputItem: { Classname: 'Rag' }, Outputs: [{ Classname: 'OZL_Sample_Bio' }] }),
      rule('carrier', { Device: 'OZL_Eco_Pack_Bio', InputItem: { Classname: 'Rag' }, Outputs: [{ Classname: 'OZL_Carrier_Bio' }] }),
      rule('procpoints', { Device: 'OZL_Eco_Proc_Bio', InputItem: { Classname: 'OZL_Sample_Bio' }, Outputs: [{ Classname: 'OZL_Carrier_Bio', Points: 3 }] }),
      rule('procwrong', { Device: 'OZL_Eco_Proc_Anom', InputItem: { Classname: 'OZL_Sample_Bio' }, Outputs: [{ Classname: 'OZL_Carrier_Bio' }] }),
      rule('pure', { Purity: 1.5, Device: 'OZL_Eco_Pack_Bio', InputItem: { Classname: 'Rag' }, Outputs: [{ Classname: 'OZL_Sample_Bio', Points: 5 }] }),
      rule('zero', { Purity: 0, Device: 'OZL_Eco_Pack_Bio', InputItem: { Classname: 'Rag' }, Outputs: [{ Classname: 'OZL_Sample_Bio', Points: 5 }] }),
      rule('exact', { Device: 'OZL_Eco_Pack_Bio', InputItem: { Classname: 'Rag' }, Outputs: [{ Classname: 'OZL_Sample_Bio|1', Points: 5 }] }),
      rule('eat', { Device: 'OZL_Eco_Pack_Bio', InputItem: { Classname: 'Rag' }, Consumables: [{ Classname: 'OZL_Sample_Anom' }], Outputs: [{ Classname: 'OZL_Sample_Bio', Points: 5 }] }),
      rule('fast', { TimeSec: 2, Device: 'OZL_Eco_Pack_Bio', InputItem: { Classname: 'Rag' } }),
      rule('ragpoints', { Device: 'OZL_Eco_Pack_Bio', InputItem: { Classname: 'Rag' }, Outputs: [{ Classname: 'Rag', Points: 2 }] }),
      { Id: 'off', Enabled: false },
    ] }] });
    const ids = ['pack', 'proc', 'cross', 'nopoints', 'carrier', 'procpoints', 'procwrong', 'pure', 'zero', 'exact', 'eat', 'fast', 'ragpoints', 'off'];
    const p = validate('ResearchRules', doc, { pointTypes: new Set(['bio']) });
    const at = (id: string) => `Groups[0].Rules[${ids.indexOf(id)}]`;
    const by = (id: string) => p.filter((x) => x.path === at(id) || x.path.startsWith(`${at(id)}.`));
    const why = (id: string) => by(id).filter((x) => x.severity === 'disable').map((x) => x.message.replace(/^rule '[^']+' is disabled by the game: /, ''));
    expect(by('pack')).toEqual([]);
    expect(by('proc')).toEqual([]);
    expect(why('cross')).toEqual(["sample 'OZL_Sample_Bio' comes out of 'OZL_Eco_Pack_Anom', which is not a packer of its line"]);
    expect(why('nopoints')).toEqual(["sample output 'OZL_Sample_Bio' needs Points 1..1000"]);
    expect(why('carrier')).toEqual(["carrier 'OZL_Carrier_Bio' comes out of something other than the analysis of a sample"]);
    expect(why('procpoints')).toEqual(['Points on an analysis output: a carrier takes the points of its sample']);
    expect(why('procwrong')).toEqual(["sample 'OZL_Sample_Bio' goes into 'OZL_Eco_Proc_Anom', which is not an analyzer of its line"]);
    expect(why('pure')[0]).toContain('Purity above 1');
    expect(by('zero')).toEqual([]);
    expect(why('exact')[0]).toContain("unknown Output 'OZL_Sample_Bio|1'");
    expect(why('eat')).toEqual(['a sample or a carrier cannot be a consumable']);
    expect(why('fast')[0]).toContain('TimeSec below the minimum');
    expect(why('ragpoints')).toEqual(["Points given for 'Rag', which is not a sample"]);
    expect(by('off').map((x) => x.severity)).toEqual(['info']);
  });
  it('warns where the game would, and where a rule can never run', () => {
    const doc = normalize('ResearchRules', { Groups: [
      { Id: 'g', Rules: [
        { Id: 'dup', Device: 'OZL_Eco_Pack_Bio', InputItem: { Classname: 'Rag' }, Outputs: [{ Classname: 'OZL_Sample_Bio', Points: 1 }] },
        { Id: 'khabar', Device: 'OZL_Bnd_Proc_Khabar', InputItem: { Classname: 'OZL_Sample_Khabar' }, Outputs: [{ Classname: 'OZL_Carrier_Khabar' }], RequiredTools: ['OZL_Tool_Dosimeter'] },
        { Id: 'tool', Device: 'OZL_Eco_Pack_Bio', InputItem: { Classname: 'Rag' }, Outputs: [{ Classname: 'OZL_Sample_Bio', Points: 1 }], RequiredTools: ['OZL_Tool_Dosimeter'], RequiredNode: 'nope', RequiredFactions: ['ghost'] },
        { Id: 'mutant', Device: 'OZL_Eco_Pack_Bio', InputItem: { Classname: 'Rag' }, Outputs: [{ Classname: 'OZL_Sample_Mutant', Points: 1 }] },
      ] },
      { Id: 'h', Rules: [{ Id: 'dup', Device: 'OZL_Eco_Pack_Bio', InputItem: { Classname: 'Rag' }, Outputs: [{ Classname: 'OZL_Sample_Bio', Points: 1 }] }] },
    ] });
    const owners = normalize('ResearchOwners', { Owners: [{ Id: 'ecolog', DeviceClasses: ['OZL_Eco_Pack_Bio'] }] });
    const p = validate('ResearchRules', doc, { pointTypes: new Set(['bio']), nodeIds: new Set(['n1']), owners: new Set(['ecolog']), ownersDoc: owners, classes: new Set(['Rag', 'OZL_Eco_Pack_Bio', 'OZL_Sample_Bio']) });
    expect(p.find((x) => x.path === 'Groups[0].Rules[0]')?.severity).toBe('drop');
    expect(p.some((x) => x.path.startsWith('Groups[1]'))).toBe(false);
    const khabar = p.filter((x) => x.path.startsWith('Groups[0].Rules[1]')).map((x) => x.message);
    expect(khabar.some((m) => m.includes("line 'khabar' has no point type"))).toBe(true);
    expect(khabar.some((m) => m.includes('has no module slots'))).toBe(true);
    expect(khabar.some((m) => m.includes("no owner lists 'OZL_Bnd_Proc_Khabar'"))).toBe(true);
    expect(khabar.some((m) => m.includes("device 'OZL_Bnd_Proc_Khabar' is not in the server's class list"))).toBe(true);
    const tool = p.filter((x) => x.path.startsWith('Groups[0].Rules[2]')).map((x) => [x.severity, x.path]);
    expect(tool).toEqual([
      ['warn', 'Groups[0].Rules[2].RequiredTools[0]'],
      ['warn', 'Groups[0].Rules[2].RequiredNode'], ['warn', 'Groups[0].Rules[2].RequiredFactions'], ['warn', 'Groups[0].Rules[2].RequiredTools[0]'],
    ]);
    const mutant = p.filter((x) => x.path.startsWith('Groups[0].Rules[3]'));
    expect(mutant.map((x) => x.severity)).toEqual(['warn', 'warn']);
    expect(mutant[1].message).toContain("does not know the line of 'OZL_Sample_Mutant'");
  });
  it('drops a tree node the way the game does and counts what it dropped as missing', () => {
    const doc = normalize('ResearchTree', { Branches: [{ Id: 'b', Nodes: [
      { Id: 'root', Name: 'Root', Cost: [{ Type: 'bio', Amount: 1 }, { Type: 'bio', Amount: 2 }] },
      { Id: 'child', Name: 'Child', Parents: ['nope'] },
      { Id: 'loop1', Name: 'L1', Parents: ['loop2'] },
      { Id: 'loop2', Name: 'L2', Parents: ['loop1'] },
      { Id: 'anyok', Name: 'Any', Parents: ['ok', 'nope'], ParentsMode: 'any' },
      { Id: 'ok', Name: 'Ok', ItemCost: [{ Classname: 'Rag', Quantity: 2 }] },
      { Id: 'afterroot', Name: 'After', Parents: ['root'] },
    ] }, { Id: 'c', Nodes: [{ Id: 'ok', Name: 'Twin' }] }] });
    const p = validate('ResearchTree', doc, { pointTypes: new Set(['bio']) });
    expect(p.find((x) => x.path === 'Branches[0].Nodes[0].Cost[1]')?.severity).toBe('drop');
    expect(p.find((x) => x.path === 'Branches[0].Nodes[5]')?.message).toContain('the game keeps the last one');
    expect(p.filter((x) => x.path.startsWith('node:')).map((x) => x.path)).toEqual(['node:child', 'node:loop1', 'node:loop2', 'node:afterroot']);
    expect(unreachable(doc)).toEqual(['child', 'loop1', 'loop2']);
  });
  it('knows the modules of the mod and their limits', () => {
    const doc = normalize('ResearchModules', { Modules: [
      { Classname: 'OZL_Tool_Optics' }, { Classname: 'Rag' }, { Classname: 'OZL_Tool_Dosimeter', DoubleChance: 1.5 }, { Classname: 'OZL_Tool_Optics', PurityBonus: 0.2 },
    ] });
    const p = validate('ResearchModules', doc);
    expect(p.filter((x) => x.severity === 'drop').map((x) => x.path)).toEqual(['Modules[0]', 'Modules[1]', 'Modules[2]']);
    const missing = p.find((x) => x.path === 'Modules')!.message;
    expect([missing.includes('OZL_Tool_Centrifuge'), missing.includes('OZL_Tool_Optics'), missing.includes('OZL_Tool_Dosimeter')]).toEqual([true, false, true]);
  });
  it('mirrors the statics checks', () => {
    const doc = normalize('ResearchStatics', { Entries: [{ Id: 'a', ClassName: 'X', Pos: [1, 2] }, { Id: 'b', ClassName: 'OZL_Eco_Terminal', Pos: [1, 2, 3] }, { Id: 'b', ClassName: '' }] });
    const p = validate('ResearchStatics', doc, { classes: new Set(['OZL_Eco_Terminal']) });
    expect(p.map((x) => [x.severity, x.path])).toEqual([['drop', 'Entries[0]'], ['drop', 'Entries[2]']]);
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
    expect(m.cards.map((c) => [c.node.Id, c.x, c.y])).toEqual([['r', 0, 52], ['c', 316, 52]]);
    expect(m.ghosts.map((g) => [g.id, g.branchLabel, g.x, g.y])).toEqual([['x', 'B', 0, 184]]);
    expect(m.edges.map((e) => [e.source, e.target, e.cross])).toEqual([['n:0:0', 'n:0:1', false], ['g:x', 'n:0:1', true]]);
  });
  it('maps a dragged x back to a tier and caps absurd tiers', () => {
    expect(tierForX(330, [1, 2, 3])).toBe(2);
    expect(tierForX(-100, [1, 2, 3])).toBe(1);
    expect(columnTiers([1, 99999]).length).toBe(3);
  });
  it('finds the cycle a new parent would close', () => {
    expect(cyclePath(doc, 'r', 'c')).toEqual(['c', 'r']);
    expect(cyclePath(doc, 'c', 'x')).toBeNull();
  });
});

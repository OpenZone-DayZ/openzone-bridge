import { describe, expect, it } from 'vitest';
import { normalize } from './schema';
import { balance, canEarn, cyclesFor } from './balance';
import { classFacts } from './lines';

describe('the balance of the lines', () => {
  const tree = normalize('ResearchTree', { Branches: [
    { Id: 'a', Owners: ['ecolog'], Nodes: [{ Id: 'n1', Name: 'N1', Cost: [{ Type: 'bio', Amount: 10 }] }, { Id: 'n2', Name: 'N2', Cost: [{ Type: 'bio', Amount: 5 }], RequiredFactions: ['duty'] }] },
    { Id: 'b', Nodes: [{ Id: 'n3', Name: 'N3', Cost: [{ Type: 'anomaly', Amount: 2 }] }] },
  ] });
  const rules = normalize('ResearchRules', { Groups: [{ Id: 'g', Rules: [
    { Id: 'pack1', Device: 'OZL_Eco_Pack_Bio', InputItem: { Classname: 'Rag' }, Outputs: [{ Classname: 'OZL_Sample_Bio', Points: 1 }] },
    { Id: 'pack25', Device: 'OZL_Eco_Pack_Bio', Purity: 0.5, InputItem: { Classname: 'Apple' }, Outputs: [{ Classname: 'OZL_Sample_Bio', Points: 25, Chance: 0.8 }] },
    { Id: 'off', Enabled: false, Device: 'OZL_Eco_Pack_Bio', InputItem: { Classname: 'Pear' }, Outputs: [{ Classname: 'OZL_Sample_Bio', Points: 1000 }] },
    { Id: 'proc', Device: 'OZL_Eco_Proc_Bio', InputItem: { Classname: 'OZL_Sample_Bio' }, Outputs: [{ Classname: 'OZL_Carrier_Bio' }] },
    { Id: 'anom', Device: 'OZL_Eco_Pack_Anom', InputItem: { Classname: 'Rag' }, Outputs: [{ Classname: 'OZL_Sample_Anom', Points: 2 }] },
  ] }] });
  const pts = normalize('ResearchPointTypes', { PointTypes: [{ Id: 'bio', Name: 'Biology', BasePurity: 0.6 }, { Id: 'anomaly', Name: 'Anomalies' }, { Id: 'trails', Name: 'Trails' }] });
  const owners = normalize('ResearchOwners', { Owners: [
    { Id: 'ecolog', DeviceClasses: ['OZL_Eco_Pack_Bio', 'OZL_Eco_Proc_Bio', 'OZL_Eco_Pack_Anom'] },
    { Id: 'duty', DeviceClasses: ['OZL_Dty_Pack_Ball'] },
  ] });
  const rows = balance(tree, rules, pts, owners, classFacts(null));
  const bio = rows.find((r) => r.type === 'bio')!;
  const anom = rows.find((r) => r.type === 'anomaly')!;

  it('counts what makes a line and what the tree spends of it, per owner', () => {
    expect([bio.name, bio.basePurity, bio.packers, bio.pointsMin, bio.pointsMax, bio.analyzers, bio.spent, bio.nodes]).toEqual(['Biology', 0.6, 2, 1, 25, 1, 15, 2]);
    expect([...bio.spentBy]).toEqual([['ecolog', 10], ['duty', 5]]);
    expect(anom.spentBy.get('*')).toBe(2);
    expect(rows.find((r) => r.type === 'trails')!.spent).toBe(0);
  });
  it('takes the best cycle with the rule purity or the line base, and the cycles the spending needs', () => {
    // pack25: 25 points x 0.8 chance x its own purity 0.5 = 10; pack1: 1 x 0.6.
    expect(bio.bestCycle).toBe(10);
    expect(cyclesFor(bio)).toBe(2);
    expect([anom.packers, anom.analyzers, anom.bestCycle, cyclesFor(anom)]).toEqual([1, 0, 0, null]);
  });
  it('knows who can earn a line: a packer and an analyzer of it among the owner devices', () => {
    expect([canEarn(bio, 'ecolog'), canEarn(bio, 'duty'), canEarn(bio, '*')]).toEqual([true, false, true]);
    expect(canEarn(anom, 'ecolog')).toBe(false);
    const free = balance(tree, rules, pts, null, classFacts(null)).find((r) => r.type === 'bio')!;
    expect([canEarn(free, 'duty'), [...free.earners]]).toEqual([true, ['*']]);
  });
});

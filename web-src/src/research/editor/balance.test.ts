import { describe, expect, it } from 'vitest';
import { normalize } from './schema';
import { balance } from './balance';

describe('balance', () => {
  it('adds up what grants and what spends, per owner', () => {
    const tree = normalize('ResearchTree', { Branches: [
      { Id: 'a', Owners: ['loner'], Nodes: [{ Id: 'n1', Name: 'N1', Cost: [{ Type: 'bio', Amount: 10 }] }, { Id: 'n2', Name: 'N2', Cost: [{ Type: 'bio', Amount: 5 }], RequiredFactions: ['bandit'] }] },
      { Id: 'b', Nodes: [{ Id: 'n3', Name: 'N3', Cost: [{ Type: 'ano', Amount: 2 }] }] },
    ] });
    const data = normalize('ResearchDataItems', { Items: [{ Id: 'OZL_Data_01', Name: 'x', Points: [{ Type: 'bio', Amount: 3 }] }, { Id: 'OZL_Data_02', Name: 'y', Enabled: false, Points: [{ Type: 'bio', Amount: 99 }] }] });
    const rules = normalize('ResearchRules', { Groups: [{ Id: 'g', Rules: [{ Id: 'r', Outputs: [{ Classname: 'OZL_Carrier_Science', Content: 'bio:4', Quantity: 2 }] }] }] });
    const pts = normalize('ResearchPointTypes', { PointTypes: [{ Id: 'bio', Name: 'Biology' }, { Id: 'ano', Name: 'Anomalies' }, { Id: 'ele', Name: 'Electronics' }] });
    const rows = balance(tree, data, rules, pts);
    const bio = rows.find((r) => r.type === 'bio')!;
    expect([bio.name, bio.fromData, bio.fromRules, bio.spent, bio.nodes]).toEqual(['Biology', 3, 8, 15, 2]);
    expect([...bio.spentBy]).toEqual([['loner', 10], ['bandit', 5]]);
    expect(rows.find((r) => r.type === 'ano')!.spentBy.get('*')).toBe(2);
    expect(rows.find((r) => r.type === 'ele')!.spent).toBe(0);
  });
});

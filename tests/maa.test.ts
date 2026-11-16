import test from 'node:test';
import assert from 'node:assert/strict';
import { convertMaaOperBox, isMaaOperBox } from '../src/importers/maa.ts';
import { createDemoDataset } from '../src/demo.ts';

test('MAA 幹員辨識：持有者帶入精英、等級、潛能，未持有者標為未持有', async () => {
  const dataset = await createDemoDataset();
  const [a, b, c] = dataset.operators;
  const details = { done: true, own_opers: [{ id: a.id, name: a.displayName, own: true, elite: 2, level: 60, potential: 3, rarity: 6 }, { id: 'char_x', name: b.displayName, own: true, elite: 9, level: 1, potential: 1, rarity: 5 }, { id: 'char_y', name: '不存在', own: true, elite: 0, level: 1, potential: 1, rarity: 3 }],
    all_oper: [{ id: c.id, name: c.displayName, own: false, rarity: 4 }] };
  assert.ok(isMaaOperBox({ details }) && isMaaOperBox(details) && !isMaaOperBox({ format: 'x' }));
  const { document, unmatched } = await convertMaaOperBox({ details }, { dataset, importedAt: '2026-11-16T00:00:00.000Z' });
  const row = (id: string) => document.candidates.find(item => item.operatorId === id)!;
  assert.deepEqual([row(a.id).fields.elite?.value, row(a.id).fields.level?.value, row(a.id).fields.potential?.value], [2, 60, 3]);
  assert.equal(row(b.id).fields.elite, undefined, '精英 9 不合理 → 不帶入');
  assert.equal(row(c.id).fields.owned?.value, false);
  assert.deepEqual(unmatched, ['不存在']);
  assert.equal(row(a.id).fields.elite?.manuallyConfirmed, false);
});

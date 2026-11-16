import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoDataset, createDemoImport } from '../src/demo.ts';
import { canonical, createEmptyState, known, sealDataset, unknown, type AppState, type Evidence, type ImportDocument } from '../src/domain/model.ts';
import { applyImport, previewImport } from '../src/domain/import.ts';
import { moduleIssuesFor, moduleProblems } from '../src/domain/module-consistency.ts';

const createdAt = '2026-11-16T00:00:00.000Z';

async function fixture(): Promise<AppState> {
  const dataset = await createDemoDataset(), empty = createEmptyState(dataset);
  const preview = await previewImport(empty, createDemoImport(dataset));
  const base = applyImport(empty, preview, Object.fromEntries(preview.conflicts.map(item => [item.id, 'incoming'])));
  const operators = base.dataset.operators.map((op, index) => ({ ...op, modules: op.modules.map(module => ({ ...module, name: `合成模組${index + 1}`, kind: 'SUM-X', type: 'advanced' as const })) }));
  const state = { ...base, dataset: await sealDataset({ ...base.dataset, operators }) };
  for (const row of state.roster) {
    const module = state.dataset.operators.find(op => op.id === row.operatorId)!.modules[0];
    if (!module) continue;
    row.fields[`moduleUnlocked:${module.id}`] = known(false, '合成未解鎖');
    row.fields[`moduleLevel:${module.id}`] = known(0, '合成零級');
    row.fields.equippedModule = known('none', '合成未裝備');
  }
  return state;
}

function target(state: AppState) {
  const row = state.roster.find(item => state.dataset.operators.find(op => op.id === item.operatorId)!.modules.length)!;
  return { row, module: state.dataset.operators.find(op => op.id === row.operatorId)!.modules[0] };
}

function manual(state: AppState, operatorId: string, fields: Record<string, Evidence>, source = '使用者在本機手動更正'): ImportDocument {
  return { format: 'arknights-roster-import', schemaVersion: 1, product: 'arknights', server: 'tw', namespace: state.dataset.metadata.namespace, dataset: state.dataset,
    candidates: [{ operatorId, fields }], completeness: 'partial', source, adapterVersion: 'manual-1', createdAt };
}
const decideAll = (conflicts: { id: string }[], decision: 'keep' | 'incoming') => Object.fromEntries(conflicts.map(conflict => [conflict.id, decision]));

test('DATA-03：單人更正提出未解鎖卻升級時，預覽列出矛盾且保存被阻擋', async () => {
  const state = await fixture(), { row, module } = target(state), before = canonical(state);
  const preview = await previewImport(state, manual(state, row.operatorId, { [`moduleLevel:${module.id}`]: known(2, '使用者在本機手動更正', { manuallyConfirmed: true, importedAt: createdAt }) }));
  assert.equal(preview.moduleIssues.length, 1);
  assert.match(preview.moduleIssues[0].message, /未解鎖/);
  assert.throws(() => applyImport(state, preview, decideAll(preview.conflicts, 'incoming')), /矛盾.*原資料未修改/);
  assert.equal(canonical(state), before);
  // 選擇保留既有值即可消除矛盾並保存。
  assert.doesNotThrow(() => applyImport(state, preview, decideAll(preview.conflicts, 'keep')));
});

test('DATA-03：一般匯入未解鎖卻裝備、原始證章升級都阻擋', async () => {
  const state = await fixture(), { row, module } = target(state);
  const equip = await previewImport(state, manual(state, row.operatorId, { equippedModule: known(module.id, '外部研究', { importedAt: createdAt, manuallyConfirmed: true }) }, '外部研究'));
  assert.ok(equip.moduleIssues.some(issue => /裝備/.test(issue.message)));
  assert.throws(() => applyImport(state, equip, decideAll(equip.conflicts, 'incoming')), /矛盾/);

  const original = { ...module, type: 'original' as const, kind: 'ORIGINAL', levels: undefined };
  assert.deepEqual(moduleProblems(original, { [`moduleLevel:${module.id}`]: known(1, '合成') }), ['是原始證章，不可升級。']);
  assert.deepEqual(moduleProblems(original, { [`moduleLevel:${module.id}`]: known(0, '合成'), [`moduleUnlocked:${module.id}`]: known(true, '合成'), equippedModule: known(module.id, '合成') }), []);
});

test('DATA-03：一致的同步調整可保存；未知值不推論為矛盾', async () => {
  const state = await fixture(), { row, module } = target(state);
  const meta = { importedAt: createdAt, manuallyConfirmed: true };
  const preview = await previewImport(state, manual(state, row.operatorId, {
    [`moduleUnlocked:${module.id}`]: known(true, '使用者在本機手動更正', meta), [`moduleLevel:${module.id}`]: known(2, '使用者在本機手動更正', meta), equippedModule: known(module.id, '使用者在本機手動更正', meta),
  }));
  assert.deepEqual(preview.moduleIssues, []);
  const saved = applyImport(state, preview, decideAll(preview.conflicts, 'incoming'));
  assert.equal(saved.roster.find(item => item.operatorId === row.operatorId)!.fields[`moduleLevel:${module.id}`].value, 2);

  const definition = state.dataset.operators.find(op => op.id === row.operatorId)!;
  assert.deepEqual(moduleIssuesFor(definition, { [`moduleUnlocked:${module.id}`]: unknown('合成'), [`moduleLevel:${module.id}`]: known(3, '合成'), equippedModule: known(module.id, '合成') }), []);
});

test('DATA-03：既有但本次未觸及的矛盾不阻擋其他欄位修正', async () => {
  const state = await fixture(), { row, module } = target(state);
  row.fields[`moduleLevel:${module.id}`] = known(2, '合成既有矛盾');
  const preview = await previewImport(state, manual(state, row.operatorId, { level: known(40, '使用者在本機手動更正', { importedAt: createdAt, manuallyConfirmed: true }) }));
  assert.deepEqual(preview.moduleIssues, []);
  assert.doesNotThrow(() => applyImport(state, preview, decideAll(preview.conflicts, 'incoming')));
});

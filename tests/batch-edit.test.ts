import test from 'node:test';
import assert from 'node:assert/strict';
import { createBatchEdit, createGridEdit, type GridChange } from '../src/domain/batch-edit.ts';
import { createDemoDataset, createDemoImport } from '../src/demo.ts';
import { createEmptyState, canonical, sealDataset, known } from '../src/domain/model.ts';
import { applyImport, previewImport, undoLastImport } from '../src/domain/import.ts';

async function fixture() {
  const dataset = await createDemoDataset(), empty = createEmptyState(dataset);
  const preview = await previewImport(empty, createDemoImport(dataset));
  return applyImport(empty, preview, Object.fromEntries(preview.conflicts.map(item => [item.id, 'incoming'])));
}
test('批次修正只處理選取欄位與幹員，預覽不寫入，保存與撤銷保留其他資料', async () => {
  const state = await fixture(), before = canonical(state);
  const ids = state.roster.slice(0, 2).map(row => row.operatorId);
  const input = createBatchEdit(state, ids, { level: { status: 'known', value: 42 }, trust: { status: 'unknown' } });
  const preview = await previewImport(state, input);
  assert.equal(canonical(state), before);
  const result = applyImport(state, preview, Object.fromEntries(preview.conflicts.map(item => [item.id, 'incoming'])));
  for (const row of result.roster) {
    const old = state.roster.find(item => item.operatorId === row.operatorId)!;
    if (!ids.includes(row.operatorId)) assert.deepEqual(row, old);
    else {
      assert.equal(row.fields.level.status, 'known'); assert.equal(row.fields.level.value, 42);
      assert.equal(row.fields.level.manuallyConfirmed, true); assert.equal(row.fields.trust.status, 'unknown');
      for (const key of Object.keys(old.fields).filter(key => !['level', 'trust'].includes(key))) assert.deepEqual(row.fields[key], old.fields[key]);
    }
  }
  assert.deepEqual(undoLastImport(result).roster, state.roster);
  assert.equal(canonical(state), before);
});
test('批次拒絕空選取、重複或不存在幹員、錯誤欄位與越界數值', async () => {
  const state = await fixture(), ids = [state.roster[0].operatorId], changes = { level: { status: 'known' as const, value: 1 } };
  for (const selection of [[], [ids[0], ids[0]], ['char_missing']]) assert.throws(() => createBatchEdit(state, selection, changes));
  for (const value of [0, 91, NaN, 1.1]) assert.throws(() => createBatchEdit(state, ids, { level: { status: 'known', value } }));
  assert.throws(() => createBatchEdit(state, ids, {}));
  assert.throws(() => createBatchEdit(state, ids, { equippedSkill: { status: 'known', value: 1 } } as never));
  assert.throws(() => createBatchEdit(state, ids, { trust: { status: 'unknown', value: 0 } } as never));
});
test('同值批次確認有紀錄；預覽後他分頁修訂變更會拒絕保存', async () => {
  const state = await fixture(), id = state.roster[0].operatorId;
  const preview = await previewImport(state, createBatchEdit(state, [id], { potential: { status: 'known', value: 1 } }));
  assert.throws(() => applyImport({ ...state, revision: state.revision + 1 }, preview, {}), /修訂|過期/);
});

async function moduleFixture() {
  const original = await fixture();
  const dataset = await sealDataset({ ...original.dataset, operators: original.dataset.operators.map((op, index) => ({ ...op, modules: op.modules.map(module => ({ ...module, name: `合成模組${index + 1}`, kind: index % 2 ? 'GUA-X' : 'SUM-X', type: 'advanced' as const })) })) });
  const state = { ...original, dataset };
  for (const row of state.roster) {
    const module = dataset.operators.find(op => op.id === row.operatorId)!.modules[0];
    row.fields[`moduleUnlocked:${module.id}`] = known(false, '合成未解鎖');
    row.fields[`moduleLevel:${module.id}`] = known(0, '合成零級');
    row.fields.equippedModule = known('none', '合成未裝備');
  }
  return state;
}

test('批次模組按各幹員唯一種類映射不同ID，完整預覽、保存與撤銷', async () => {
  const state = await moduleFixture(), before = canonical(state), ids = state.roster.slice(0, 2).map(row => row.operatorId);
  const input = createBatchEdit(state, ids, {}, undefined, { kind: 'X', unlocked: 'yes', level: { status: 'known', value: 3 }, equipped: 'selected' });
  for (const candidate of input.candidates) {
    const module = state.dataset.operators.find(op => op.id === candidate.operatorId)!.modules[0];
    assert.equal(candidate.fields.equippedModule.value, module.id);
    assert.equal(candidate.fields[`moduleLevel:${module.id}`].value, 3);
    assert.equal(candidate.fields[`moduleUnlocked:${module.id}`].value, true);
  }
  const preview = await previewImport(state, input);
  assert.equal(canonical(state), before);
  const result = applyImport(state, preview, Object.fromEntries(preview.conflicts.map(item => [item.id, 'incoming'])));
  assert.deepEqual(result.roster.filter(row => !ids.includes(row.operatorId)), state.roster.filter(row => !ids.includes(row.operatorId)));
  assert.deepEqual(undoLastImport(result).roster, state.roster);
});

test('模組缺少或歧義對應、原始模組、越界與互相矛盾狀態皆阻擋', async () => {
  const state = await moduleFixture(), ids = [state.roster[0].operatorId], edit = { kind: 'X', level: { status: 'known' as const, value: 3 } };
  assert.throws(() => createBatchEdit(state, ids, {}, undefined, edit), /矛盾/);
  assert.throws(() => createBatchEdit(state, ids, {}, undefined, { kind: 'Y', unlocked: 'yes' }), /唯一對應/);
  assert.throws(() => createBatchEdit(state, ids, {}, undefined, { kind: 'X' }), /欄位/);
  for (const value of [-1, 4, NaN, 1.5]) assert.throws(() => createBatchEdit(state, ids, {}, undefined, { kind: 'X', level: { status: 'known', value } }), /等級/);
  const changed = structuredClone(state), op = changed.dataset.operators.find(op => op.id === ids[0])!;
  op.modules.push({ ...op.modules[0], id: 'demo-extra-module' });
  assert.throws(() => createBatchEdit(changed, ids, {}, undefined, { kind: 'X', unlocked: 'yes' }), /唯一對應/);
  op.modules = [{ ...op.modules[0], type: 'original' }];
  assert.throws(() => createBatchEdit(changed, ids, {}, undefined, { kind: 'X', unlocked: 'yes' }), /唯一對應/);
  assert.throws(() => createBatchEdit(state, ids, {}, undefined, { kind: 'X', level: undefined } as never), /欄位/);
  for (const level of [false, 0, '', [], '3']) assert.throws(() => createBatchEdit(state, ids, {}, undefined, { kind: 'X', level } as never), /格式/);
});

const gridTime = '2026-11-13T12:00:00.000Z';

test('表格多列不同欄位與值形成單次候選，預覽不改原紀錄，保存與撤銷保持未選欄位', async () => {
  const state = await fixture(), before = canonical(state), [first, second] = state.roster;
  const firstDefinition = state.dataset.operators.find(op => op.id === first.operatorId)!;
  const edits: Record<string, Record<string, GridChange>> = {
    [first.operatorId]: { level: { status: 'known', value: 42 }, [`mastery:${firstDefinition.skills[0].id}`]: { status: 'known', value: 1 }, equippedSkill: { status: 'known', value: firstDefinition.skills[1].id } },
    [second.operatorId]: { level: { status: 'known', value: 35 }, trust: { status: 'known', value: 75 }, owned: { status: 'known', value: true } },
  };
  const beforeEdits = structuredClone(edits), input = createGridEdit(state, edits, gridTime);
  assert.equal(input.completeness, 'partial'); assert.equal(input.candidates.length, 2);
  for (const candidate of input.candidates) {
    assert.deepEqual(Object.keys(candidate.fields).sort(), Object.keys(edits[candidate.operatorId]).sort());
    for (const [field, evidence] of Object.entries(candidate.fields)) {
      assert.equal(evidence.status, 'known'); assert.equal(evidence.value, (edits[candidate.operatorId][field] as { value: unknown }).value);
      assert.equal(evidence.manuallyConfirmed, true); assert.equal(evidence.importedAt, gridTime); assert.equal(evidence.observedAt, gridTime);
    }
  }
  const preview = await previewImport(state, input);
  assert.equal(canonical(state), before); assert.deepEqual(edits, beforeEdits);
  const result = applyImport(state, preview, Object.fromEntries(preview.conflicts.map(conflict => [conflict.id, 'incoming'])));
  assert.equal(result.batches.length, state.batches.length + 1);
  for (const row of result.roster) {
    const previous = state.roster.find(old => old.operatorId === row.operatorId)!;
    for (const [field, evidence] of Object.entries(row.fields)) {
      const changed = edits[row.operatorId]?.[field];
      if (changed?.status === 'known') { assert.equal(evidence.value, changed.value); assert.equal(evidence.manuallyConfirmed, true); }
      else assert.deepEqual(evidence, previous.fields[field]);
    }
  }
  assert.deepEqual(undoLastImport(result).roster, state.roster); assert.equal(canonical(state), before);
});

test('表格未知與不適用不帶值，已知零與布林 false 保持不同語意', async () => {
  const state = await fixture(), row = state.roster[0], definition = state.dataset.operators.find(op => op.id === row.operatorId)!;
  const input = createGridEdit(state, { [row.operatorId]: { level: { status: 'unknown' }, [`mastery:${definition.skills[1].id}`]: { status: 'not-applicable' }, trust: { status: 'known', value: 0 }, owned: { status: 'known', value: false } } }, gridTime);
  const preview = await previewImport(state, input), result = applyImport(state, preview, Object.fromEntries(preview.conflicts.map(conflict => [conflict.id, 'incoming'])));
  const fields = result.roster.find(item => item.operatorId === row.operatorId)!.fields;
  assert.equal(fields.level.status, 'unknown'); assert.equal(Object.hasOwn(fields.level, 'value'), false);
  assert.equal(fields[`mastery:${definition.skills[1].id}`].status, 'not-applicable'); assert.equal(Object.hasOwn(fields[`mastery:${definition.skills[1].id}`], 'value'), false);
  assert.equal(fields.trust.value, 0); assert.equal(fields.owned.value, false);
});

test('表格拒絕空集合、空列、未建檔 ID、非一般物件與未允許欄位', async () => {
  const state = await fixture(), id = state.roster[0].operatorId, before = canonical(state);
  const change = { status: 'known', value: 1 };
  for (const edits of [{}, { [id]: {} }, { 'demo-not-owned': { level: change } }, [], null, 'value', new Date(),
    { [id]: [] }, { [id]: null }, { [id]: 'value' }, { [id]: { arbitrary: change } }, { [id]: { 'mastery:not-this-skill': change } },
    { [id]: { 'moduleLevel:not-this-module': change } }, { [id]: { level: undefined } }, Object.create({ [id]: { level: change } })]) {
    assert.throws(() => createGridEdit(state, edits as never, gridTime));
  }
  assert.equal(canonical(state), before);
});

test('表格欄位型別、範圍、額外鍵與三種狀態皆在候選建立時嚴格驗證', async () => {
  const state = await fixture(), id = state.roster[0].operatorId, definition = state.dataset.operators.find(op => op.id === id)!;
  const badKnown: [string, unknown][] = [['elite', 3], ['level', 0], ['level', 91], ['level', NaN], ['level', Infinity], ['level', '50'], ['potential', 0], ['trust', 201], ['skillLevel', 8],
    ['owned', 1], ['equippedSkill', definition.modules[0].id], ['equippedModule', definition.skills[0].id], [`mastery:${definition.skills[0].id}`, 4],
    [`moduleAvailable:${definition.modules[0].id}`, 'yes'], [`moduleUnlocked:${definition.modules[0].id}`, 0], [`moduleLevel:${definition.modules[0].id}`, 4]];
  for (const [field, value] of badKnown) assert.throws(() => createGridEdit(state, { [id]: { [field]: { status: 'known', value } } } as never, gridTime));
  for (const change of [{}, { status: 'known' }, { status: 'invalid' }, { status: 'unknown', value: 0 }, { status: 'not-applicable', value: null },
    { status: 'known', value: 50, manuallyConfirmed: false }, { status: 'known', value: 50, source: '冒充來源' }, { status: 'known', value: 50, extra: true },
    { status: 'known', value: undefined }, false, 0, '', [], null]) {
    assert.throws(() => createGridEdit(state, { [id]: { level: change } } as never, gridTime));
  }
  assert.throws(() => createGridEdit(state, { [id]: { level: { status: 'known', value: 50 } } }, 'invalid-date'));
});

test('表格模組以新舊合併結果檢查矛盾，僅保存明確變更而不自動推斷欄位', async () => {
  const state = await moduleFixture(), id = state.roster[0].operatorId, module = state.dataset.operators.find(op => op.id === id)!.modules[0];
  for (const fields of [{ [`moduleLevel:${module.id}`]: { status: 'known', value: 1 } }, { [`moduleUnlocked:${module.id}`]: { status: 'known', value: true } }, { equippedModule: { status: 'known', value: module.id } }]) {
    assert.throws(() => createGridEdit(state, { [id]: fields } as never, gridTime), /矛盾/);
  }
  const fields: Record<string, GridChange> = { [`moduleUnlocked:${module.id}`]: { status: 'known', value: true }, [`moduleLevel:${module.id}`]: { status: 'known', value: 2 }, equippedModule: { status: 'known', value: module.id } };
  const input = createGridEdit(state, { [id]: fields }, gridTime);
  const preview = await previewImport(state, input), active = applyImport(state, preview, Object.fromEntries(preview.conflicts.map(conflict => [conflict.id, 'incoming'])));
  assert.throws(() => createGridEdit(active, { [id]: { [`moduleUnlocked:${module.id}`]: { status: 'known', value: false } } }, gridTime), /矛盾/);
  assert.throws(() => createGridEdit(active, { [id]: { [`moduleLevel:${module.id}`]: { status: 'known', value: 0 } } }, gridTime), /矛盾/);
  assert.doesNotThrow(() => createGridEdit(active, { [id]: { [`moduleUnlocked:${module.id}`]: { status: 'known', value: false }, [`moduleLevel:${module.id}`]: { status: 'known', value: 0 }, equippedModule: { status: 'known', value: 'none' } } }, gridTime));
  const partial = createGridEdit(state, { [id]: { [`moduleUnlocked:${module.id}`]: { status: 'unknown' }, [`moduleLevel:${module.id}`]: { status: 'known', value: 3 } } }, gridTime);
  assert.deepEqual(Object.keys(partial.candidates[0].fields).sort(), [`moduleLevel:${module.id}`, `moduleUnlocked:${module.id}`].sort());
  assert.equal(partial.candidates[0].fields[`moduleUnlocked:${module.id}`].status, 'unknown');
  const notApplicable = createGridEdit(state, { [id]: { [`moduleLevel:${module.id}`]: { status: 'not-applicable' } } }, gridTime);
  assert.equal(notApplicable.candidates[0].fields[`moduleLevel:${module.id}`].status, 'not-applicable');
});

test('表格原始模組不允許升級，零級原始證章可明示已解鎖及已裝備', async () => {
  const state = await moduleFixture(), id = state.roster[0].operatorId;
  state.dataset = await sealDataset({ ...state.dataset, operators: state.dataset.operators.map(op => op.id !== id ? op : { ...op, modules: op.modules.map(module => ({ ...module, type: 'original', kind: 'ORIGINAL' })) }) });
  const module = state.dataset.operators.find(op => op.id === id)!.modules[0];
  for (const value of [1, 2, 3]) assert.throws(() => createGridEdit(state, { [id]: { [`moduleLevel:${module.id}`]: { status: 'known', value } } }, gridTime), /原始|升級/);
  assert.doesNotThrow(() => createGridEdit(state, { [id]: { [`moduleLevel:${module.id}`]: { status: 'known', value: 0 }, [`moduleUnlocked:${module.id}`]: { status: 'known', value: true }, equippedModule: { status: 'known', value: module.id } } }, gridTime));
});

test('表格任一列失敗整批不產生候選且原始 state 與 edits 不變；未涉及模組不被順帶修正', async () => {
  const state = await moduleFixture(), [first, second] = state.roster, definition = state.dataset.operators.find(op => op.id === first.operatorId)!;
  first.fields[`moduleLevel:${definition.modules[0].id}`] = known(2, '合成既有矛盾');
  const before = canonical(state), edits = { [first.operatorId]: { level: { status: 'known', value: 50 } }, [second.operatorId]: { level: { status: 'known', value: 91 } } };
  const snapshot = structuredClone(edits);
  assert.throws(() => createGridEdit(state, edits as never, gridTime)); assert.equal(canonical(state), before); assert.deepEqual(edits, snapshot);
  assert.doesNotThrow(() => createGridEdit(state, { [first.operatorId]: { level: { status: 'known', value: 50 } } }, gridTime));
});

test('表格預覽後修訂或原狀態改變會拒絕套用，回傳候選不與編輯值共用可變物件', async () => {
  const state = await fixture(), id = state.roster[0].operatorId;
  const edits: Record<string, Record<string, GridChange>> = { [id]: { level: { status: 'known', value: 50 } } };
  const input = createGridEdit(state, edits, gridTime), before = canonical(state);
  (edits[id].level as { value: number }).value = 40;
  assert.equal(input.candidates[0].fields.level.value, 50); assert.notEqual(input.dataset, state.dataset);
  const preview = await previewImport(state, input), decisions = Object.fromEntries(preview.conflicts.map(conflict => [conflict.id, 'incoming' as const]));
  assert.throws(() => applyImport({ ...state, revision: state.revision + 1 }, preview, decisions), /過期|修訂/);
  const changed = structuredClone(state); changed.roster[1].fields.level = known(1, '合成其他分頁更正');
  assert.throws(() => applyImport(changed, preview, decisions), /過期|修訂/); assert.equal(canonical(state), before);
});

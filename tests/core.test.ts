import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, known, unknown, sealDataset, validateAppState, validateImportDocument, parseImportText, MAX_IMPORT_BYTES, type ImportDocument, type Dataset } from '../src/domain/model.ts';
import { previewImport, applyImport, undoLastImport } from '../src/domain/import.ts';
import { createBackup, parseBackup } from '../src/storage/backup.ts';

const date = '2026-11-13T00:00:00.000Z';
async function fixture(): Promise<{ dataset: Dataset; input: ImportDocument }> {
  const dataset = await sealDataset({
    metadata: { id: 'demo-set', version: '1.0.0', product: 'arknights', server: 'tw', namespace: 'demo', validFrom: date, acquiredAt: date, source: '自製虛構資料', licenseStatus: 'self-authored' },
    operators: [1, 2].map(i => ({ id: `demo-${i}`, displayName: `測試幹員${i}`, aliases: [], rarity: 6 as const, profession: '先鋒', branch: '虛構分支', faction: '測試', skills: [{ id: `demo-s${i}`, name: '測試技能' }], modules: [{ id: `demo-m${i}`, name: '測試模組', kind: 'X' }], availability: 'unknown' as const })),
  });
  return { dataset, input: { format: 'arknights-roster-import', schemaVersion: 1, product: 'arknights', server: 'tw', namespace: 'demo', dataset, candidates: [{ operatorId: 'demo-1', fields: { owned: known(true, '自製測試', { importedAt: date }), level: known(50, '自製測試', { importedAt: date, observedAt: date }), 'mastery:demo-s1': unknown('自製測試', date) } }], completeness: 'partial', source: '自製測試', adapterVersion: '1.0.0', createdAt: date } };
}

test('首次匯入及相同內容重匯：不重複幹員，仍保留兩筆批次', async () => {
  const { dataset, input } = await fixture();
  const original = createEmptyState(dataset);
  const preview = await previewImport(original, input);
  assert.equal(preview.counts.added, 1);
  assert.ok(preview.counts.missing > 0);
  const first = applyImport(original, preview, {});
  const secondPreview = await previewImport(first, input);
  assert.equal(secondPreview.counts.repeated, 1);
  const second = applyImport(first, secondPreview, {});
  assert.equal(second.roster.length, 1);
  assert.equal(second.batches.length, 2);
  assert.equal(second.batches[1].duplicateOf, first.batches[0].id);
  assert.equal(second.roster[0].fields['mastery:demo-s1'].status, 'unknown');
  assert.equal(original.roster.length, 0);
});

test('同批重複列補齊缺漏；兩個不同值集中確認，三值明確阻擋', async () => {
  const { dataset, input } = await fixture();
  input.candidates.push({ operatorId: 'demo-1', fields: { elite: known(2, '測試', { importedAt: date }) } });
  const preview = await previewImport(createEmptyState(dataset), input);
  assert.equal(preview.candidates.length, 1);
  assert.equal(preview.candidates[0].fields.elite.status, 'known');
  input.candidates.push({ operatorId: 'demo-1', fields: { level: known(90, '測試', { importedAt: date }) } });
  const empty = createEmptyState(dataset);
  const conflictPreview = await previewImport(empty, input);
  assert.equal(conflictPreview.conflicts.length, 1);
  assert.throws(() => applyImport(empty, conflictPreview, {}), /確認/);
  const chosen = applyImport(empty, conflictPreview, { [conflictPreview.conflicts[0].id]: 'incoming' });
  assert.equal(chosen.roster[0].fields.level.status === 'known' && chosen.roster[0].fields.level.value, 90);
  const first = applyImport(empty, conflictPreview, { [conflictPreview.conflicts[0].id]: 'keep' });
  assert.equal(first.roster[0].fields.level.status === 'known' && first.roster[0].fields.level.value, 50);
  input.candidates.push({ operatorId: 'demo-1', fields: { level: known(80, '第三份圖', { importedAt: date }) } });
  await assert.rejects(previewImport(empty, input), /三個以上/);
});

test('同值人工確認不遺失，模組開放、解鎖與裝備為不同欄位', async () => {
  const { dataset, input } = await fixture();
  const empty = createEmptyState(dataset);
  const state = applyImport(empty, await previewImport(empty, input), {});
  const confirmed = structuredClone(input);
  confirmed.candidates[0].fields.level = known(50, '人工核對', { importedAt: date, manuallyConfirmed: true });
  confirmed.candidates[0].fields['moduleAvailable:demo-m1'] = known(true, '測試');
  confirmed.candidates[0].fields['moduleUnlocked:demo-m1'] = known(false, '測試');
  confirmed.candidates[0].fields.equippedModule = known('none', '測試');
  const preview = await previewImport(state, confirmed);
  assert.equal(preview.counts.changed, 1);
  const result = applyImport(state, preview, {});
  assert.equal(result.roster[0].fields.level.manuallyConfirmed, true);
  assert.equal(result.roster[0].fields['moduleLevel:demo-m1'].status, 'unknown');
  assert.deepEqual((await parseBackup(await createBackup(result))).roster, result.roster);
});

test('人工明確撤回已知值為未知必須確認，普通缺漏仍不可蓋掉已知', async () => {
  const { dataset, input } = await fixture();
  const empty = createEmptyState(dataset);
  const state = applyImport(empty, await previewImport(empty, input), {});
  const correction = structuredClone(input);
  correction.candidates[0].fields.level = { ...unknown('人工撤回', date), manuallyConfirmed: true };
  const preview = await previewImport(state, correction);
  assert.equal(preview.conflicts.length, 1);
  assert.throws(() => applyImport(state, preview, {}), /確認/);
  const result = applyImport(state, preview, { [preview.conflicts[0].id]: 'incoming' });
  assert.equal(result.roster[0].fields.level.status, 'unknown');
  assert.equal(result.roster[0].fields.level.manuallyConfirmed, true);
  assert.deepEqual(undoLastImport(result).roster, state.roster);
  const later = await previewImport(result, input);
  assert.equal(later.conflicts.length, 1);
  assert.match(later.conflicts[0].reasons.join(' '), /人工確認/);
  assert.throws(() => applyImport(result, later, {}), /確認/);
});

test('舊圖不能蓋掉人工確認，必須逐欄決策；未知與局部不刪除', async () => {
  const { dataset, input } = await fixture();
  input.candidates[0].fields.level = known(70, '人工確認', { importedAt: date, observedAt: date, manuallyConfirmed: true });
  input.candidates.push({ operatorId: 'demo-2', fields: { owned: known(true, '測試', { importedAt: date }) } });
  const empty = createEmptyState(dataset);
  const state = applyImport(empty, await previewImport(empty, input), {});
  const next = structuredClone(input);
  next.candidates = [{ operatorId: 'demo-1', fields: { level: known(30, '舊圖', { importedAt: date, observedAt: '2025-01-01T00:00:00.000Z', confidence: 0.2 }), owned: unknown('裁切', date) } }];
  const preview = await previewImport(state, next);
  assert.equal(preview.conflicts.length, 1);
  assert.throws(() => applyImport(state, preview, {}), /確認/);
  const merged = applyImport(state, preview, { [preview.conflicts[0].id]: 'keep' });
  assert.equal(merged.roster.length, 2);
  assert.deepEqual(merged.roster[0].fields.level, state.roster[0].fields.level);
  assert.deepEqual(merged.roster[0].fields.owned, state.roster[0].fields.owned);
  const accepted = applyImport(state, preview, { [preview.conflicts[0].id]: 'incoming' });
  assert.equal(accepted.roster[0].fields.level.manuallyConfirmed, true);
  assert.deepEqual(undoLastImport(accepted).roster, state.roster);
});

test('預覽過期、不同服別、示範混入私人資料拒絕', async () => {
  const { dataset, input } = await fixture();
  const state = createEmptyState(dataset);
  const preview = await previewImport(state, input);
  assert.throws(() => applyImport({ ...state, revision: 4 }, preview, {}), /過期/);
  assert.throws(() => validateImportDocument({ ...input, server: 'cn' }), /服別/);
  await assert.rejects(previewImport(state, { ...input, namespace: 'personal' }), /命名空間/);
});

test('格式白名單、欄位範圍、未知不帶值及模組 ID 驗證', async () => {
  const { input } = await fixture();
  assert.throws(() => validateImportDocument({ ...input, token: '秘密' }), /未允許/);
  assert.throws(() => validateImportDocument({ ...input, schemaVersion: 999 }), /版本/);
  const bad = structuredClone(input);
  bad.candidates[0].fields.level = known(900, '測試');
  assert.throws(() => validateImportDocument(bad), /範圍/);
  bad.candidates[0].fields.level = { ...unknown('測試'), value: 0 } as never;
  assert.throws(() => validateImportDocument(bad), /未知.*值/);
  bad.candidates[0].fields.level = unknown('測試');
  bad.candidates[0].fields['moduleLevel:does-not-exist'] = known(1, '測試');
  assert.throws(() => validateImportDocument(bad), /未允許欄位.*moduleLevel/);
});

test('備份復原保留未知、人工證據、設定、批次及撤銷；破損與未來版本不接受', async () => {
  const { dataset, input } = await fixture();
  input.candidates[0].fields.level.manuallyConfirmed = true;
  const empty = createEmptyState(dataset);
  const state = applyImport(empty, await previewImport(empty, input), {});
  const text = await createBackup(state);
  assert.equal(text.includes('\n'), false);
  assert.deepEqual(await parseBackup(text), state);
  const broken = JSON.parse(text);
  broken.state.roster[0].fields.level.value = 55;
  await assert.rejects(parseBackup(JSON.stringify(broken)), /校驗/);
  broken.formatVersion = 999;
  await assert.rejects(parseBackup(JSON.stringify(broken)), /版本/);
  await assert.rejects(parseBackup('{bad'), /JSON/);
});

test('100 筆合成批次完整走預覽、合併、重匯、撤銷、備份復原', async () => {
  const { dataset: base, input } = await fixture();
  const dataset = await sealDataset({ metadata: { ...base.metadata, id: 'demo-100', version: '100-test' }, operators: Array.from({ length: 100 }, (_, i) => ({ ...base.operators[0], id: `demo-batch-${i}`, displayName: `合成測試 ${i}` })) });
  input.dataset = dataset;
  input.candidates = dataset.operators.map((op, i) => ({ operatorId: op.id, fields: { owned: known(true, '合成測試', { importedAt: date }), level: known(i % 90 + 1, '合成測試', { importedAt: date }) } }));
  const empty = createEmptyState(dataset);
  const preview = await previewImport(empty, input);
  assert.equal(preview.counts.added, 100);
  assert.equal(preview.counts.conflicts, 0);
  const state = applyImport(empty, preview, {});
  const repeated = await previewImport(state, input);
  assert.equal(repeated.counts.repeated, 100);
  const next = applyImport(state, repeated, {});
  assert.equal(next.roster.length, 100);
  assert.deepEqual((await parseBackup(await createBackup(next))).roster, state.roster);
  assert.deepEqual(undoLastImport(next).roster, state.roster);
});

test('新幹員低信心欄位不自動接受；保留未知與採用候選分別有效', async () => {
  const { dataset, input } = await fixture();
  input.candidates[0].fields.level = known(40, '低信心辨識測試', { confidence: 0.3, importedAt: date });
  const empty = createEmptyState(dataset);
  const preview = await previewImport(empty, input);
  assert.equal(preview.conflicts.length, 1);
  const kept = applyImport(empty, preview, { [preview.conflicts[0].id]: 'keep' });
  assert.equal(kept.roster[0].fields.level.status, 'unknown');
  const accepted = applyImport(empty, preview, { [preview.conflicts[0].id]: 'incoming' });
  assert.equal(accepted.roster[0].fields.level.status === 'known' && accepted.roster[0].fields.level.value, 40);
  assert.equal(accepted.roster[0].fields.level.manuallyConfirmed, true);
});

test('既有未知欄位遇同批兩候選，選左側也能實際補入', async () => {
  const { dataset, input } = await fixture();
  input.candidates[0].fields.level = unknown('缺漏', date);
  const empty = createEmptyState(dataset);
  const state = applyImport(empty, await previewImport(empty, input), {});
  input.candidates = [{ operatorId: 'demo-1', fields: { level: known(40, '第一圖') } }, { operatorId: 'demo-1', fields: { level: known(60, '第二圖') } }];
  const preview = await previewImport(state, input);
  const result = applyImport(state, preview, { [preview.conflicts[0].id]: 'keep' });
  assert.equal(result.roster[0].fields.level.status === 'known' && result.roster[0].fields.level.value, 40);
  assert.equal(result.roster[0].fields.level.manuallyConfirmed, true);
});

test('人工確認未知遇同批兩個已知候選，視為三個狀態並保留原更正', async () => {
  const { dataset, input } = await fixture();
  input.candidates[0].fields.level = { ...unknown('人工保留未知', date), manuallyConfirmed: true };
  const empty = createEmptyState(dataset);
  const state = applyImport(empty, await previewImport(empty, input), {});
  const before = structuredClone(state);
  input.candidates = [{ operatorId: 'demo-1', fields: { level: known(40, '第一圖') } }, { operatorId: 'demo-1', fields: { level: known(60, '第二圖') } }];
  await assert.rejects(previewImport(state, input), /三個不同值.*拆分/);
  assert.deepEqual(state, before);
  assert.equal(state.roster[0].fields.level.status, 'unknown');
  assert.equal(state.roster[0].fields.level.manuallyConfirmed, true);
});

test('專精不適用、已知零與未知不能互換', async () => {
  const { dataset, input } = await fixture();
  input.candidates[0].fields['mastery:demo-s1'] = { ...unknown('不適用測試', date), status: 'not-applicable' };
  const empty = createEmptyState(dataset);
  const state = applyImport(empty, await previewImport(empty, input), {});
  input.candidates[0].fields['mastery:demo-s1'] = known(0, '已核對未專精', { importedAt: date });
  const preview = await previewImport(state, input);
  assert.equal(preview.conflicts.length, 1);
  const next = applyImport(state, preview, { [preview.conflicts[0].id]: 'incoming' });
  assert.equal(next.roster[0].fields['mastery:demo-s1'].status === 'known' && next.roster[0].fields['mastery:demo-s1'].value, 0);
  assert.equal(next.roster[0].fields.elite.status, 'unknown');
});

test('資料包異動先核對 checksum，非空庫版本變更拒絕靜默遷移', async () => {
  const { dataset, input } = await fixture();
  const empty = createEmptyState(dataset);
  const state = applyImport(empty, await previewImport(empty, input), {});
  const tampered = structuredClone(input);
  tampered.dataset.operators[0].displayName = '被改動';
  await assert.rejects(previewImport(state, tampered), /校驗/);
  tampered.dataset = await sealDataset({ ...tampered.dataset, metadata: { ...tampered.dataset.metadata, version: '2' } });
  await assert.rejects(previewImport(state, tampered), /版本不同/);
  const fresh = createEmptyState(await sealDataset({ metadata: { ...dataset.metadata, id: 'demo-empty' }, operators: [] }));
  assert.equal((await previewImport(fresh, input)).counts.added, 1);
  assert.equal(fresh.roster.length, 0);
});

test('深層多餘欄位、帳號資料及檔案容量上限在寫入前拒絕', async () => {
  const { input } = await fixture();
  const extra = structuredClone(input) as unknown as Record<string, unknown>;
  (extra.dataset as { metadata: Record<string, unknown> }).metadata.email = '不能進入備份';
  assert.throws(() => validateImportDocument(extra), /未允許/);
  const pii = structuredClone(input);
  pii.source = 'account@example.invalid';
  assert.throws(() => validateImportDocument(pii), /帳號識別資訊/);
  assert.throws(() => parseImportText(' '.repeat(MAX_IMPORT_BYTES + 1)), /過大/);
  assert.throws(() => validateImportDocument({ ...input, schemaVersion: 0 }), /版本/);
});

test('明確批次接受低信心新值保留未人工確認，逐欄接受仍標為已核對', async () => {
  const { dataset, input } = await fixture();
  input.candidates[0].fields.level = known(40, '研究來源', { confidence: 0, importedAt: date });
  input.candidates[0].fields.trust = known(100, '研究來源', { confidence: 0.3, importedAt: date });
  const state = createEmptyState(dataset);
  const preview = await previewImport(state, input);
  const decisions = Object.fromEntries(preview.conflicts.map(conflict => [conflict.id, 'incoming' as const]));
  const result = applyImport(state, preview, decisions, { sourceAcceptedIds: ['demo-1/level'] });
  assert.deepEqual(result.roster[0].fields.level, input.candidates[0].fields.level);
  assert.equal(result.roster[0].fields.level.manuallyConfirmed, false);
  assert.equal(result.roster[0].fields.trust.manuallyConfirmed, true);
  assert.equal(result.batches[0].candidates[0].fields.level.manuallyConfirmed, false);
  const restored = await parseBackup(await createBackup(result));
  assert.equal(restored.roster[0].fields.level.manuallyConfirmed, false);
  assert.deepEqual(state.roster, []);
});

test('批次來源接受拒絕未知或重複 ID、非 incoming 決策與無效選項', async () => {
  const { dataset, input } = await fixture();
  input.candidates[0].fields.level = known(40, '研究來源', { confidence: 0, importedAt: date });
  const state = createEmptyState(dataset), before = structuredClone(state);
  const preview = await previewImport(state, input);
  const id = preview.conflicts[0].id;
  for (const sourceAcceptedIds of [['unknown'], ['demo-1/owned'], [id, id], [1], 'not-array', null]) {
    assert.throws(() => applyImport(state, preview, { [id]: 'incoming' }, { sourceAcceptedIds } as never), /來源|批次|欄位|選項/);
  }
  for (const options of [null, {}, { sourceAcceptedIds: [id], extra: true }]) assert.throws(() => applyImport(state, preview, { [id]: 'incoming' }, options as never), /來源|批次|欄位|選項|格式/);
  assert.throws(() => applyImport(state, preview, { [id]: 'keep' }, { sourceAcceptedIds: [id] }), /來源|批次|欄位/);
  assert.deepEqual(state, before);
});

test('真正衝突及同批矛盾不能冒充低信心新值，竄改理由也不得降級', async () => {
  const { dataset, input } = await fixture();
  const empty = createEmptyState(dataset);
  const state = applyImport(empty, await previewImport(empty, input), {});
  input.candidates[0].fields.level = known(40, '研究來源', { confidence: 0, importedAt: date });
  const preview = await previewImport(state, input);
  const id = 'demo-1/level';
  assert.throws(() => applyImport(state, preview, { [id]: 'incoming' }, { sourceAcceptedIds: [id] }), /來源|批次|衝突/);
  const tampered = structuredClone(preview);
  tampered.conflicts[0].current = unknown('尚無資料', date);
  tampered.conflicts[0].reasons = ['來源信心較低，須人工確認'];
  assert.throws(() => applyImport(state, tampered, { [id]: 'incoming' }, { sourceAcceptedIds: [id] }), /來源|批次|衝突/);
  input.candidates.push({ operatorId: 'demo-1', fields: { level: known(60, '另一研究來源', { confidence: 0, importedAt: date }) } });
  const duplicates = await previewImport(empty, input);
  duplicates.conflicts[0].current = unknown('尚無資料', date);
  duplicates.conflicts[0].reasons = ['來源信心較低，須人工確認'];
  assert.throws(() => applyImport(empty, duplicates, { [id]: 'incoming' }, { sourceAcceptedIds: [id] }), /來源|批次|衝突/);
});

test('批次來源接受後仍可人工核對，後續來源不得繞過人工保護', async () => {
  const { dataset, input } = await fixture();
  input.candidates[0].fields.level = known(40, '研究來源', { confidence: 0, importedAt: date });
  const empty = createEmptyState(dataset);
  const firstPreview = await previewImport(empty, input);
  const id = 'demo-1/level';
  const initial = applyImport(empty, firstPreview, { [id]: 'incoming' }, { sourceAcceptedIds: [id] });
  const manual = structuredClone(input);
  manual.candidates = [{ operatorId: 'demo-1', fields: { level: known(40, '使用者人工核對', { importedAt: date, manuallyConfirmed: true, confidence: 1 }) } }];
  const confirmed = applyImport(initial, await previewImport(initial, manual), {});
  assert.equal(confirmed.roster[0].fields.level.manuallyConfirmed, true);
  input.candidates[0].fields.level = known(45, '後續研究來源', { confidence: 0, importedAt: date });
  const later = await previewImport(confirmed, input);
  assert.ok(later.conflicts[0].reasons.some(reason => reason.includes('人工確認')));
  assert.throws(() => applyImport(confirmed, later, { [id]: 'incoming' }, { sourceAcceptedIds: [id] }), /來源|批次|衝突/);
  const kept = applyImport(confirmed, later, { [id]: 'keep' });
  assert.equal(kept.roster[0].fields.level.status === 'known' && kept.roster[0].fields.level.value, 40);
  assert.equal(kept.roster[0].fields.level.manuallyConfirmed, true);
});

async function catalogFixture() {
  const source = (await fixture()).dataset;
  const dataset = await sealDataset({ metadata: { ...source.metadata, id: 'arknights-tw-public-catalog', namespace: 'personal', version: 'commit-one' }, operators: source.operators.map((op, index) => ({ ...op, id: `char_${index + 1}`, skills: [{ id: `skill_${index + 1}`, name: '合成技能' }], modules: [{ id: `module_${index + 1}`, name: '合成模組', kind: 'X' }] })) });
  const input: ImportDocument = { format: 'arknights-roster-import', schemaVersion: 1, product: 'arknights', server: 'tw', namespace: 'personal', dataset, completeness: 'partial', source: '合成公開資料集測試', adapterVersion: 'test-1', createdAt: date, candidates: [{ operatorId: 'char_1', fields: {
    owned: known(true, '合成資料', { importedAt: date }), level: known(50, '合成資料', { importedAt: date }),
    equippedSkill: known('skill_1', '合成資料', { importedAt: date }), equippedModule: known('module_1', '合成資料', { importedAt: date }),
    'mastery:skill_1': known(2, '合成資料', { importedAt: date }),
  } }] };
  const empty = createEmptyState(dataset);
  const state = applyImport(empty, await previewImport(empty, input), {});
  return { dataset, input, state };
}

test('指定繁中公開資料集可於相同來源日期升版，新增幹員與技能並保留舊值', async () => {
  const { dataset, input, state } = await catalogFixture();
  const before = structuredClone(state);
  const upgraded = await sealDataset({ metadata: { ...dataset.metadata, version: 'commit-two' }, operators: [
    { ...dataset.operators[0], skills: [...dataset.operators[0].skills, { id: 'skill_added[2]', name: '新增合成技能' }] },
    dataset.operators[1], { ...dataset.operators[1], id: 'char_added', displayName: '新增合成幹員' },
  ] });
  const incoming: ImportDocument = { ...input, dataset: upgraded, candidates: [
    { operatorId: 'char_1', fields: { 'mastery:skill_added[2]': known(1, '合成資料', { importedAt: date }) } },
    { operatorId: 'char_added', fields: { owned: known(true, '合成資料', { importedAt: date }), level: known(20, '合成資料', { importedAt: date }) } },
  ] };
  const preview = await previewImport(state, incoming);
  const tampered = structuredClone(preview);
  tampered.dataset.operators[0].displayName = '預覽後竄改';
  assert.throws(() => applyImport(state, tampered, {}), /預覽.*變更|校驗/);
  const result = applyImport(state, preview, {});
  assert.equal(result.dataset.metadata.version, 'commit-two');
  assert.deepEqual(result.roster.find(row => row.operatorId === 'char_1')!.fields.level, state.roster[0].fields.level);
  assert.equal(result.roster.find(row => row.operatorId === 'char_1')!.fields['mastery:skill_added[2]'].status, 'known');
  assert.ok(result.roster.some(row => row.operatorId === 'char_added'));
  assert.deepEqual(state, before);
  const undone = undoLastImport(result);
  assert.deepEqual(undone.roster, state.roster);
  assert.deepEqual(undone.dataset, upgraded);
  assert.deepEqual(undone.batches.slice(0, result.batches.length), result.batches);
  assert.equal(undone.batches.at(-1)?.kind, 'undo');
  assert.equal(validateAppState(undone), undone);
  assert.deepEqual((await parseBackup(await createBackup(undone))).roster, state.roster);
});

test('公開資料集只有名稱更新時撤銷回復原定義與校驗，仍保留全部歷史', async () => {
  const { dataset, input, state } = await catalogFixture();
  const upgraded = await sealDataset({ metadata: { ...dataset.metadata, version: 'commit-two', validFrom: '2026-11-14T00:00:00.000Z' }, operators: dataset.operators.map(op => ({ ...op, displayName: '更新後合成名稱' })) });
  const result = applyImport(state, await previewImport(state, { ...input, dataset: upgraded, candidates: [] }), {});
  assert.equal(result.dataset.operators[0].displayName, '更新後合成名稱');
  const undone = undoLastImport(result);
  assert.deepEqual(undone.dataset, dataset);
  assert.deepEqual(undone.roster, state.roster);
  assert.deepEqual(undone.batches.slice(0, result.batches.length), result.batches);
  assert.equal(validateAppState(undone), undone);
  assert.deepEqual((await parseBackup(await createBackup(undone))).dataset, dataset);
});

test('公開資料集升版拒絕移除現有技能、裝備與歷史所需 ID，原狀態不變', async () => {
  const { dataset, input, state } = await catalogFixture();
  for (const change of ['skill', 'module', 'operator', 'history-skill'] as const) {
    const existing = structuredClone(state);
    if (change === 'history-skill') {
      delete existing.roster[0].fields['mastery:skill_1'];
      existing.roster[0].fields.equippedSkill = unknown('測試目前缺值', date);
    }
    const before = structuredClone(existing);
    const operators = change === 'operator' ? [dataset.operators[1]] : dataset.operators.map((op, index) => index ? op : { ...op, ...(change === 'module' ? { modules: [] } : { skills: [] }) });
    const upgraded = await sealDataset({ metadata: { ...dataset.metadata, version: 'commit-two' }, operators });
    await assert.rejects(previewImport(existing, { ...input, dataset: upgraded, candidates: [] }), /資料集|定義|相容|既有/);
    assert.deepEqual(existing, before);
  }
});

test('較舊來源日期及其他資料集不適用公開升版例外，checksum 仍驗證', async () => {
  const { dataset, input, state } = await catalogFixture();
  for (const metadata of [
    { ...dataset.metadata, version: 'commit-old', validFrom: '2026-11-12T00:00:00.000Z' },
    { ...dataset.metadata, validFrom: '2026-11-12T00:00:00.000Z' },
    { ...dataset.metadata, id: 'other-public-catalog', version: 'commit-two' },
  ]) {
    const incoming = await sealDataset({ metadata, operators: dataset.operators });
    await assert.rejects(previewImport(state, { ...input, dataset: incoming, candidates: [] }), /資料集|版本|日期|來源/);
  }
  const invalid = structuredClone(dataset); invalid.operators[0].displayName = '未重算校驗';
  await assert.rejects(previewImport(state, { ...input, dataset: invalid, candidates: [] }), /校驗/);
});

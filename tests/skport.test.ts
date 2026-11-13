import test from 'node:test';
import assert from 'node:assert/strict';
import { sealDataset, type Dataset } from '../src/domain/model.ts';
import { createEmptyState } from '../src/domain/model.ts';
import { previewImport } from '../src/domain/import.ts';
import { convertSkportOffline } from '../src/importers/skport.ts';

const importedAt = '2026-11-13T00:00:00.000Z';
const confirmation = { product: 'arknights', server: 'tw', confirmedByUser: true } as const;

async function dataset(): Promise<Dataset> {
  return sealDataset({
    metadata: { id: 'synthetic-skport', version: '1', product: 'arknights', server: 'tw', namespace: 'personal', validFrom: importedAt, acquiredAt: importedAt, source: '自製測試定義，不代表正式資料包', licenseStatus: 'self-authored' },
    operators: [{ id: 'char_test', displayName: '合成測試幹員', aliases: [], rarity: 6, profession: '測試職業', branch: '測試分支', faction: '測試陣營', skills: [{ id: 'skill_test', name: '合成技能' }], modules: [{ id: 'module_test', name: '合成模組', kind: 'X' }], availability: 'unknown' }],
  });
}

function wrapper(chars: unknown[] = []) {
  return { format: 'skport-offline-research', schemaVersion: 1, gameData: { code: 0, data: { chars } } };
}

function character(overrides: Record<string, unknown> = {}) {
  return { charId: 'char_test', level: 90, evolvePhase: 0, favorPercent: 0, mainSkillLvl: 7, potentialRank: 0, defaultSkillId: 'skill_test', skills: [{ id: 'skill_test', specializeLevel: 0 }], defaultEquipId: 'module_test', equip: [{ id: 'module_test', level: 3, locked: false }], ...overrides };
}

test('拒絕未標示研究格式、未明確確認產品與服別的輸入', async () => {
  const definitions = await dataset();
  const options = { dataset: definitions, confirmation, importedAt };
  for (const input of [null, undefined, [], {}, { chars: [] }, { format: 'official-skport-export', schemaVersion: 1, gameData: {} }]) {
    await assert.rejects(convertSkportOffline(input, options), /研究格式/);
  }
  const input = { format: 'skport-offline-research', schemaVersion: 1, gameData: { chars: [] } };
  for (const invalid of [undefined, {}, { ...confirmation, confirmedByUser: false }, { ...confirmation, server: 'cn' }, { ...confirmation, product: 'endfield' }]) {
    const invalidOptions = invalid === undefined ? { dataset: definitions, importedAt } : { ...options, confirmation: invalid };
    await assert.rejects(convertSkportOffline(input, invalidOptions as never), /明確確認/);
  }
});

test('驗證定義校驗與私人命名空間，不由來源名稱產生新定義', async () => {
  const definitions = await dataset();
  const input = wrapper();
  const tampered = structuredClone(definitions);
  tampered.operators[0].displayName = '已竄改';
  await assert.rejects(convertSkportOffline(input, { dataset: tampered, confirmation, importedAt }), /資料集/);
  const demo = await sealDataset({ ...definitions, metadata: { ...definitions.metadata, namespace: 'demo' }, operators: [] });
  await assert.rejects(convertSkportOffline(input, { dataset: demo, confirmation, importedAt }), /私人/);
});

test('資料集模組的召喚物 isToken 布林條件可轉換，原始輸入同名欄位仍拒絕', async () => {
  const original = await dataset();
  original.operators[0].modules[0].levels = [{
    level: 1, attributes: [], costs: [],
    effects: [true, false].map(isToken => ({ kind: 'trait', name: '合成條件', description: '合成效果', elite: 2, level: 60, potential: 1, isToken })),
  }];
  const definitions = await sealDataset(original);
  const options = { dataset: definitions, confirmation, importedAt };
  const result = await convertSkportOffline(wrapper([character()]), options);
  assert.deepEqual(result.document.dataset, definitions);
  assert.equal(result.document.candidates.length, 1);
  for (const key of ['isToken', 'token']) {
    await assert.rejects(convertSkportOffline(wrapper([character({ metadata: { [key]: true } })]), options), /憑證/);
  }
  await assert.rejects(convertSkportOffline({ ...wrapper(), dataset: definitions }, options), /憑證/);

  const malformed = structuredClone(definitions);
  const effect = malformed.operators[0].modules[0].levels![0].effects[0];
  (effect as unknown as Record<string, unknown>).isToken = '非布林值不能使用白名單';
  await assert.rejects(convertSkportOffline(wrapper(), { ...options, dataset: malformed }), /憑證/);
  await assert.rejects(convertSkportOffline(wrapper(), { ...options, isToken: true } as never), /憑證/);
  await assert.rejects(convertSkportOffline(wrapper(), { ...options, dataset: { ...definitions, isToken: true } } as never), /憑證/);
  const credential = structuredClone(definitions);
  (credential.operators[0].modules[0].levels![0].effects[0] as unknown as Record<string, unknown>).token = '不可出現在錯誤';
  await assert.rejects(convertSkportOffline(wrapper(), { ...options, dataset: credential }), /憑證/);
});

test('大型分級模組圖鑑使用獨立結構預算，不放寬原始研究輸入的節點上限', async () => {
  const original = await dataset();
  const template = original.operators[0];
  template.modules[0].levels = [1, 2, 3].map(level => ({
    level: level as 1 | 2 | 3, attributes: [], costs: [],
    effects: Array.from({ length: 6 }, () => ({ kind: 'trait' as const, name: '合成條件', description: '合成效果', elite: 2 as const, level: 60, potential: 1 as const, isToken: false })),
  }));
  const definitions = await sealDataset({ ...original, operators: Array.from({ length: 800 }, (_, index) => ({ ...structuredClone(template), id: `char_test_${index}` })) });
  const options = { dataset: definitions, confirmation, importedAt };
  const result = await convertSkportOffline(wrapper(), options);
  assert.equal(result.document.dataset.operators.length, 800);
  const oversizedRaw = { ...wrapper(), gameData: { code: 0, data: { chars: [], padding: Array.from({ length: 100_001 }, () => 0) } } };
  await assert.rejects(convertSkportOffline(oversizedRaw, options), /JSON 結構限制/);
});

test('呼叫後修改來源或定義，不得改變已驗證中的轉換快照', async () => {
  const definitions = await dataset();
  const row = character();
  const raw = wrapper([row]);
  const pending = convertSkportOffline(raw, { dataset: definitions, confirmation, importedAt });
  row.level = 1;
  definitions.operators[0].displayName = '呼叫後竄改';
  const result = await pending;
  assert.equal(result.document.dataset.operators[0].displayName, '合成測試幹員');
  const level = result.document.candidates[0].fields.level;
  assert.equal(level.status === 'known' && level.value, 90);
});

test('只投影已知欄位，零與缺值分開；潛能與模組狀態未驗證即保留未知', async () => {
  const definitions = await dataset();
  const raw = wrapper([character()]);
  const before = structuredClone(raw);
  const result = await convertSkportOffline(raw, { dataset: definitions, confirmation, importedAt });
  assert.equal(result.document.completeness, 'partial');
  assert.equal(result.document.namespace, 'personal');
  assert.match(result.document.source, /研究.*未驗證/);
  const fields = result.document.candidates[0].fields;
  for (const key of ['elite', 'trust', 'mastery:skill_test']) {
    assert.equal(fields[key].status, 'known');
    assert.equal(fields[key].status === 'known' && fields[key].value, 0);
  }
  assert.equal(fields.level.status === 'known' && fields.level.value, 90);
  assert.equal(fields.owned.status === 'known' && fields.owned.value, true);
  assert.equal(fields.equippedSkill.status === 'known' && fields.equippedSkill.value, 'skill_test');
  assert.equal(fields.equippedModule.status === 'known' && fields.equippedModule.value, 'module_test');
  for (const key of ['potential', 'moduleAvailable:module_test', 'moduleUnlocked:module_test', 'moduleLevel:module_test']) {
    assert.equal(fields[key].status, 'unknown');
    assert.equal(Object.hasOwn(fields[key], 'value'), false);
  }
  assert.ok(result.issues.some(issue => issue.code === 'unsupported-potential'));
  assert.ok(result.issues.some(issue => issue.code === 'unsupported-module-state'));
  assert.deepEqual(raw, before);
  result.document.dataset.operators[0].displayName = '輸出可獨立編輯';
  assert.equal(definitions.operators[0].displayName, '合成測試幹員');
});

test('缺欄與 null 不補成零，不由空技能與空模組清單推定未解鎖或未裝備', async () => {
  const result = await convertSkportOffline(wrapper([{ charId: 'char_test', level: null, skills: [], equip: [] }]), { dataset: await dataset(), confirmation, importedAt });
  const fields = result.document.candidates[0].fields;
  assert.equal(fields.owned.status, 'known');
  for (const [key, evidence] of Object.entries(fields)) if (key !== 'owned') {
    assert.equal(evidence.status, 'unknown', key);
    assert.equal(Object.hasOwn(evidence, 'value'), false, key);
  }
  assert.ok(result.issues.some(issue => issue.code === 'missing-field'));
});

test('輸入確認不等於來源驗證，每個已知候選欄位仍需預覽人工決策', async () => {
  const definitions = await dataset();
  const result = await convertSkportOffline(wrapper([character()]), { dataset: definitions, confirmation, importedAt });
  const preview = await previewImport(createEmptyState(definitions), result.document);
  const knownFields = Object.values(result.document.candidates[0].fields).filter(value => value.status === 'known');
  assert.equal(preview.conflicts.length, knownFields.length);
  assert.ok(knownFields.every(value => value.confidence === 0 && value.manuallyConfirmed === false));
  assert.ok(result.issues.some(issue => issue.code === 'unverified-source'));
});

test('值域與型別錯誤拒絕，錯誤不得帶回原始值', async () => {
  const options = { dataset: await dataset(), confirmation, importedAt };
  for (const [field, values] of Object.entries({ level: [0, 91, '帳號秘密', 1.5], evolvePhase: [-1, 3], favorPercent: [-1, 201], mainSkillLvl: [0, 8] })) {
    for (const value of values) await assert.rejects(convertSkportOffline(wrapper([character({ [field]: value })]), options), error => {
      assert.match((error as Error).message, /欄位值/);
      assert.doesNotMatch((error as Error).message, /帳號秘密/);
      return true;
    });
  }
  for (const value of [-1, 4, '0']) await assert.rejects(convertSkportOffline(wrapper([character({ skills: [{ id: 'skill_test', specializeLevel: value }] })]), options), /欄位值/);
  for (const value of [0, 200]) {
    const result = await convertSkportOffline(wrapper([character({ favorPercent: value })]), options);
    assert.equal(result.document.candidates[0].fields.trust.status === 'known' && result.document.candidates[0].fields.trust.value, value);
  }
});

test('缺少穩定定義、序號、假裝 none、重複幹員與重複子 ID 均阻擋整批', async () => {
  const options = { dataset: await dataset(), confirmation, importedAt };
  for (const row of [character({ charId: 'unknown' }), character({ charId: 123 }), character({ skills: [{ id: '1', specializeLevel: 2 }] }), character({ equip: [{ id: 'unknown' }] }), character({ defaultSkillId: 0 }), character({ defaultEquipId: 'none' })]) {
    await assert.rejects(convertSkportOffline(wrapper([row]), options), /穩定 ID/);
  }
  await assert.rejects(convertSkportOffline(wrapper([character(), character()]), options), /重複/);
  await assert.rejects(convertSkportOffline(wrapper([character({ skills: [{ id: 'skill_test' }, { id: 'skill_test' }] })]), options), /重複/);
  await assert.rejects(convertSkportOffline(wrapper([character({ equip: [{ id: 'module_test' }, { id: 'module_test' }] })]), options), /重複/);
});

test('空預設技能與模組 ID 保留未知並回報缺值，不推定 none', async () => {
  const result = await convertSkportOffline(wrapper([character({ defaultSkillId: '', defaultEquipId: '', skills: [], equip: [] })]), { dataset: await dataset(), confirmation, importedAt });
  const fields = result.document.candidates[0].fields;
  for (const field of ['equippedSkill', 'equippedModule']) {
    assert.equal(fields[field].status, 'unknown');
    assert.equal(Object.hasOwn(fields[field], 'value'), false);
    assert.ok(result.issues.some(issue => issue.code === 'missing-field' && issue.row === 1 && issue.field === field));
  }
  assert.equal(fields['mastery:skill_test'].status, 'unknown');
});

test('沒有技能的正式定義可轉換空技能清單，不產生虛構專精欄位', async () => {
  const original = await dataset();
  const definitions = await sealDataset({ metadata: original.metadata, operators: [{ ...original.operators[0], skills: [] }] });
  const result = await convertSkportOffline(wrapper([character({ defaultSkillId: '', skills: [] })]), { dataset: definitions, confirmation, importedAt });
  assert.equal(result.document.candidates[0].fields.equippedSkill.status, 'unknown');
  assert.equal(Object.keys(result.document.candidates[0].fields).some(key => key.startsWith('mastery:')), false);
});

test('轉換保留技能方括號 ID 與預設技能的精確對應', async () => {
  const original = await dataset();
  const id = 'skcom_atk_up[2]';
  const definitions = await sealDataset({ metadata: original.metadata, operators: [{ ...original.operators[0], skills: [{ id, name: '合成共用技能' }] }] });
  const result = await convertSkportOffline(wrapper([character({ defaultSkillId: id, skills: [{ id, specializeLevel: 2 }] })]), { dataset: definitions, confirmation, importedAt });
  const fields = result.document.candidates[0].fields;
  assert.equal(fields.equippedSkill.status === 'known' && fields.equippedSkill.value, id);
  assert.equal(fields[`mastery:${id}`].status === 'known' && fields[`mastery:${id}`].value, 2);
  assert.equal(fields[`mastery:${id}`].confidence, 0);
});

test('僅助戰不能轉成持有庫；chars 空陣列也不宣稱完整', async () => {
  const options = { dataset: await dataset(), confirmation, importedAt };
  const onlyAssist = { ...wrapper(), gameData: { code: 0, data: { assistChars: [character()] } } };
  await assert.rejects(convertSkportOffline(onlyAssist, options), /chars/);
  const result = await convertSkportOffline({ ...wrapper(), gameData: { code: 0, data: { chars: [], assistChars: [character()] } } }, options);
  assert.deepEqual(result.document.candidates, []);
  assert.equal(result.document.completeness, 'partial');
});

test('PII 與未列入白名單的欄位剔除，憑證在任何層級均拒絕且不洩漏', async () => {
  const options = { dataset: await dataset(), confirmation, importedAt };
  const raw = wrapper([character({ nickname: '私人暱稱', uid: '1234567', email: 'private@example.invalid', url: 'https://not-trusted.invalid' })]);
  const result = await convertSkportOffline({ ...raw, gameData: { ...raw.gameData, data: { ...raw.gameData.data, status: { uid: '654321', name: '私人帳號' } } } }, options);
  assert.doesNotMatch(JSON.stringify(result), /私人暱稱|1234567|private@example|not-trusted|654321|私人帳號/);
  for (const key of ['token', 'access_token', 'password', 'Cookie', 'Authorization', 'cred', 'sessionId']) {
    await assert.rejects(convertSkportOffline(wrapper([character({ metadata: { [key]: '秘密不可出現在錯誤' } })]), options), error => {
      assert.match((error as Error).message, /憑證/);
      assert.doesNotMatch((error as Error).message, /秘密不可/);
      return true;
    });
  }
});

test('格式錯誤、回應失敗、不明欄位與未觀測形狀安全拒絕', async () => {
  const options = { dataset: await dataset(), confirmation, importedAt };
  for (const raw of [
    { ...wrapper(), extra: true }, { ...wrapper(), schemaVersion: 2 },
    { ...wrapper(), gameData: { code: 1, message: '私人帳號不可洩漏', data: { chars: [] } } },
    { ...wrapper(), gameData: { code: '0', data: { chars: [] } } },
    { ...wrapper(), gameData: { chars: [] } },
    { ...wrapper(), gameData: { code: 0, data: { content: 'eyJjaGFycyI6W119' } } },
    { ...wrapper(), gameData: { code: 0, data: { chars: {} } } },
    wrapper([null]), wrapper([character({ skills: {} })]), wrapper([character({ equip: [null] })]),
  ]) await assert.rejects(convertSkportOffline(raw, options), error => {
    assert.doesNotMatch((error as Error).message, /私人帳號不可洩漏/);
    return true;
  });
  await assert.rejects(convertSkportOffline(wrapper(), { ...options, importedAt: '今天' }), /時間/);
});

test('資料集多餘欄位及來源偽造不可繞過；回應宣稱完整也只輸出局部', async () => {
  const definitions = await dataset();
  const options = { dataset: definitions, confirmation, importedAt };
  const badDataset = { ...definitions, arbitrary: '私密內容不進錯誤' } as Dataset;
  await assert.rejects(convertSkportOffline(wrapper(), { ...options, dataset: badDataset }), error => {
    assert.match((error as Error).message, /資料集/);
    assert.doesNotMatch((error as Error).message, /私密內容/);
    return true;
  });
  await assert.rejects(convertSkportOffline(wrapper(), { ...options, source: '官方已驗證' } as never), /未允許/);
  await assert.rejects(convertSkportOffline(wrapper(), { ...options, confirmation: { ...confirmation, verified: true } } as never), /未允許/);
  const input = wrapper([character()]);
  const result = await convertSkportOffline({ ...input, gameData: { ...input.gameData, data: { ...input.gameData.data, complete: true, source: '官方已驗證' } } }, options);
  assert.equal(result.document.completeness, 'partial');
  assert.doesNotMatch(JSON.stringify(result), /官方已驗證/);
});

test('非 JSON 物件、循環、getter、過深與過量資料在轉換前拒絕', async () => {
  const options = { dataset: await dataset(), confirmation, importedAt };
  let accessed = false;
  const getter = { get code() { accessed = true; return 0; } };
  const circular: Record<string, unknown> = {}; circular.self = circular;
  let deep: unknown = {};
  for (let i = 0; i < 30; i++) deep = { nested: deep };
  for (const bad of [getter, circular, deep, new Date(), { code: Infinity }, { code: undefined }, { code: () => 0 }]) {
    await assert.rejects(convertSkportOffline({ ...wrapper(), gameData: bad }, options), /JSON|限制/);
  }
  assert.equal(accessed, false);
  await assert.rejects(convertSkportOffline(wrapper(Array.from({ length: 2001 }, () => character())), options), /限制/);
});

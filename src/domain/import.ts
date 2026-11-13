import { canonical, fieldKeys, hashValue, object, unknown, validateAppState, validateImportDocument, verifyDatasetChecksum, type AppState, type BatchRecord, type Dataset, type Evidence, type FieldConflict, type ImportCounts, type ImportDocument, type OwnedOperator } from './model.ts';

export interface ImportPreview {
  input: ImportDocument;
  dataset: Dataset;
  candidates: OwnedOperator[];
  conflicts: FieldConflict[];
  counts: ImportCounts;
  baseRevision: number;
  contentHash: string;
  datasetSignature: string;
  duplicateOf?: string;
  baseSignature: string;
}
export interface ImportAcceptanceOptions { sourceAcceptedIds: string[] }
const sameValue = (left: Evidence, right: Evidence): boolean => left.status === right.status && (left.status !== 'known' || (right.status === 'known' && left.value === right.value));
const conflictId = (operatorId: string, field: string): string => `${operatorId}/${field}`;

function conflictReasons(current: Evidence, incoming: Evidence): string[] {
  if ((incoming.status === 'unknown' && !incoming.manuallyConfirmed) || sameValue(current, incoming)) return [];
  const reasons: string[] = [];
  if (current.status !== 'unknown') reasons.push('同欄位有不同值或不同適用狀態');
  if (current.manuallyConfirmed) reasons.push('既有資料已人工確認，包含明確保留未知');
  if (current.observedAt && incoming.observedAt && Date.parse(incoming.observedAt) < Date.parse(current.observedAt)) reasons.push('新匯入來源的資料時間較舊');
  if ((incoming.confidence !== undefined && incoming.confidence < 0.8) || (current.confidence !== undefined && incoming.confidence !== undefined && incoming.confidence < current.confidence)) reasons.push('來源信心較低，須人工確認');
  return reasons;
}

function normalizeCandidates(input: ImportDocument): { candidates: OwnedOperator[]; duplicates: Map<string, FieldConflict> } {
  const result = new Map<string, OwnedOperator>();
  const duplicates = new Map<string, FieldConflict>();
  for (const candidate of input.candidates) {
    let row = result.get(candidate.operatorId);
    if (!row) { row = { operatorId: candidate.operatorId, fields: {} }; result.set(candidate.operatorId, row); }
    for (const [key, incoming] of Object.entries(candidate.fields)) {
      const previous = row.fields[key];
      if (!previous || (previous.status === 'unknown' && !previous.manuallyConfirmed)) row.fields[key] = structuredClone(incoming);
      else if ((incoming.status !== 'unknown' || incoming.manuallyConfirmed) && !sameValue(previous, incoming)) {
        const id = conflictId(candidate.operatorId, key);
        const duplicate = duplicates.get(id);
        if (duplicate && !sameValue(duplicate.incoming, incoming)) throw new Error(`同批幹員 ${candidate.operatorId} 的 ${key} 有三個以上不同值；目前只支援兩個候選的集中確認，請拆分匯入或修正候選檔。`);
        duplicates.set(id, { id, operatorId: candidate.operatorId, field: key, current: structuredClone(previous), incoming: structuredClone(incoming), reasons: ['同一批次重複列有不同值，請依來源選擇'] });
      }
      else if (sameValue(previous, incoming) && incoming.manuallyConfirmed && !previous.manuallyConfirmed) row.fields[key] = structuredClone(incoming);
    }
  }
  const definitions = new Map(input.dataset.operators.map(op => [op.id, op]));
  for (const row of result.values()) for (const key of fieldKeys(definitions.get(row.operatorId)!)) row.fields[key] ??= unknown(input.source, input.createdAt);
  return { candidates: [...result.values()].sort((a, b) => a.operatorId.localeCompare(b.operatorId)), duplicates };
}

function isPublicTwCatalog(dataset: Dataset): boolean {
  const meta = dataset.metadata;
  return meta.id === 'arknights-tw-public-catalog' && meta.namespace === 'personal' && meta.product === 'arknights' && meta.server === 'tw';
}

function validateDatasetTransition(state: AppState, incoming: Dataset): void {
  const currentMeta = state.dataset.metadata, incomingMeta = incoming.metadata;
  const publicCatalog = isPublicTwCatalog(state.dataset) && isPublicTwCatalog(incoming);
  if (publicCatalog && Date.parse(incomingMeta.validFrom) < Date.parse(currentMeta.validFrom)) throw new Error('公開資料集來源日期較舊，不能覆蓋目前版本。');
  const changed = currentMeta.id !== incomingMeta.id || currentMeta.version !== incomingMeta.version || currentMeta.checksum !== incomingMeta.checksum;
  if (!changed || (state.roster.length === 0 && state.batches.length === 0)) return;
  if (!publicCatalog) throw new Error('資料集版本不同，不能直接合併；請先備份並另行驗證資料包遷移。');
  // 新定義必須承接目前幹員與完整批次證據；舊撤銷快照仍使用它自己的資料集。
  try { validateAppState({ ...state, dataset: incoming }); }
  catch { throw new Error('新版公開資料集無法相容既有幹員或批次證據，原資料未修改。'); }
}

export async function previewImport(state: AppState, inputValue: ImportDocument): Promise<ImportPreview> {
  validateAppState(state);
  const input = structuredClone(validateImportDocument(inputValue));
  await verifyDatasetChecksum(input.dataset);
  if (state.dataset.metadata.namespace !== input.namespace) throw new Error('示範與私人命名空間不能混合；請切換正確的資料庫。');
  validateDatasetTransition(state, input.dataset);
  const { candidates, duplicates } = normalizeCandidates(input);
  const existing = new Map(state.roster.map(row => [row.operatorId, row]));
  const counts: ImportCounts = { added: 0, changed: 0, repeated: 0, conflicts: 0, missing: 0 };
  const conflicts: FieldConflict[] = [];
  for (const candidate of candidates) {
    const current = existing.get(candidate.operatorId);
    let changed = false;
    let rowConflict = false;
    for (const [field, incoming] of Object.entries(candidate.fields)) {
      if (incoming.status === 'unknown') { counts.missing++; if (!incoming.manuallyConfirmed) continue; }
      const previous = current?.fields[field] ?? unknown('尚無資料', input.createdAt);
      const duplicate = duplicates.get(conflictId(candidate.operatorId, field));
      if (duplicate) {
        const conflict = structuredClone(duplicate);
        if (previous.status !== 'unknown' || previous.manuallyConfirmed) {
          if (sameValue(previous, conflict.current)) conflict.current = structuredClone(previous);
          else if (sameValue(previous, conflict.incoming)) { conflict.incoming = conflict.current; conflict.current = structuredClone(previous); }
          else throw new Error(`同批候選與既有 ${candidate.operatorId} 的 ${field} 形成三個不同值；請拆分匯入以逐次確認，原資料未修改。`);
        }
        conflicts.push(conflict); rowConflict = true; continue;
      }
      const reasons = conflictReasons(previous, incoming);
      if (reasons.length) { conflicts.push({ id: conflictId(candidate.operatorId, field), operatorId: candidate.operatorId, field, current: structuredClone(previous), incoming: structuredClone(incoming), reasons }); rowConflict = true; }
      else if (!sameValue(previous, incoming) || (incoming.manuallyConfirmed && !previous.manuallyConfirmed)) changed = true;
    }
    if (!current) counts.added++;
    else if (changed || rowConflict) counts.changed++;
    else counts.repeated++;
  }
  counts.conflicts = conflicts.length;
  const contentHash = await hashValue(input);
  const duplicateOf = state.batches.find(batch => batch.kind === 'import' && batch.contentHash === contentHash)?.id;
  return { input, dataset: input.dataset, candidates, conflicts, counts, baseRevision: state.revision, contentHash, datasetSignature: canonical(input.dataset), ...(duplicateOf ? { duplicateOf } : {}), baseSignature: canonical(state) };
}

function sourceAcceptedFields(state: AppState, preview: ImportPreview, decisions: Record<string, 'keep' | 'incoming'>, conflicts: Map<string, FieldConflict>, options?: ImportAcceptanceOptions): Set<string> {
  if (options === undefined) return new Set();
  const input = object(options, ['sourceAcceptedIds']);
  const ids = input.sourceAcceptedIds;
  if (!Array.isArray(ids) || ids.length > preview.conflicts.length || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error('批次來源接受選項無效。');
  // 重新依原候選與目前資料核對，不能只信任畫面提供的衝突理由。
  const normalized = normalizeCandidates(preview.input);
  const original = new Map(normalized.candidates.map(row => [row.operatorId, row.fields]));
  const projected = new Map(preview.candidates.map(row => [row.operatorId, row.fields]));
  const current = new Map(state.roster.map(row => [row.operatorId, row.fields]));
  const reason = '來源信心較低，須人工確認';
  for (const id of ids as string[]) {
    const conflict = conflicts.get(id);
    if (!conflict || id !== conflictId(conflict.operatorId, conflict.field) || decisions[id] !== 'incoming' || normalized.duplicates.has(id)) throw new Error('批次來源接受包含不適用的衝突欄位。');
    const incoming = original.get(conflict.operatorId)?.[conflict.field];
    const previous = current.get(conflict.operatorId)?.[conflict.field] ?? unknown('尚無資料', preview.input.createdAt);
    if (previous.status !== 'unknown' || previous.manuallyConfirmed || !incoming || incoming.status !== 'known' || incoming.manuallyConfirmed
      || typeof incoming.confidence !== 'number' || incoming.confidence >= 0.8
      || canonical(conflict.current) !== canonical(previous) || canonical(conflict.incoming) !== canonical(incoming)
      || canonical(projected.get(conflict.operatorId)?.[conflict.field]) !== canonical(incoming)
      || conflict.reasons.length !== 1 || conflict.reasons[0] !== reason
      || canonical(conflictReasons(previous, incoming)) !== canonical([reason])) throw new Error('批次來源接受只能用於未核對的低信心新值，不能降級真正衝突。');
  }
  return new Set(ids as string[]);
}

export function applyImport(state: AppState, preview: ImportPreview, decisions: Record<string, 'keep' | 'incoming'>, options?: ImportAcceptanceOptions): AppState {
  validateAppState(state);
  if (state.revision !== preview.baseRevision || canonical(state) !== preview.baseSignature) throw new Error('預覽已過期，請重新預覽後再合併。');
  validateImportDocument(preview.input);
  if (canonical(preview.input.dataset) !== preview.datasetSignature || canonical(preview.dataset) !== preview.datasetSignature) throw new Error('資料集預覽已變更，請重新校驗與預覽。');
  validateDatasetTransition(state, preview.dataset);
  const conflictMap = new Map(preview.conflicts.map(conflict => [conflict.id, conflict]));
  for (const conflict of preview.conflicts) if (!Object.hasOwn(decisions, conflict.id) || !['keep', 'incoming'].includes(decisions[conflict.id])) throw new Error('請確認全部衝突欄位，再接受匯入。');
  for (const key of Object.keys(decisions)) if (!conflictMap.has(key)) throw new Error('衝突決策含未知欄位，請重新預覽。');
  const sourceAccepted = sourceAcceptedFields(state, preview, decisions, conflictMap, options);
  const result = structuredClone(state);
  result.dataset = structuredClone(preview.dataset);
  const roster = new Map(result.roster.map(row => [row.operatorId, row]));
  for (const candidate of preview.candidates) {
    const row = roster.get(candidate.operatorId) ?? { operatorId: candidate.operatorId, fields: {} };
    for (const [field, incoming] of Object.entries(candidate.fields)) {
      const previous = row.fields[field];
      const decision = decisions[conflictId(candidate.operatorId, field)];
      const conflict = conflictMap.get(conflictId(candidate.operatorId, field));
      if (decision === 'keep') { row.fields[field] = previous && sameValue(previous, conflict!.current) ? previous : { ...structuredClone(conflict!.current), manuallyConfirmed: conflict!.current.status !== 'unknown' }; continue; }
      if (decision === 'incoming') { row.fields[field] = { ...structuredClone(conflict!.incoming), manuallyConfirmed: !sourceAccepted.has(conflict!.id) }; continue; }
      if (!previous || (previous.status === 'unknown' && incoming.status !== 'unknown')) row.fields[field] = structuredClone(incoming);
      else if (sameValue(previous, incoming) && incoming.manuallyConfirmed && !previous.manuallyConfirmed) row.fields[field] = structuredClone(incoming);
    }
    roster.set(row.operatorId, row);
  }
  result.roster = [...roster.values()].sort((a, b) => a.operatorId.localeCompare(b.operatorId));
  const batch: BatchRecord = { id: `batch-${crypto.randomUUID()}`, kind: 'import', source: preview.input.source, contentHash: preview.contentHash, createdAt: new Date().toISOString(), completeness: preview.input.completeness, adapterVersion: preview.input.adapterVersion, counts: { ...preview.counts }, decisions: { ...decisions }, candidates: structuredClone(preview.candidates), conflicts: structuredClone(preview.conflicts), ...(preview.duplicateOf ? { duplicateOf: preview.duplicateOf } : {}) };
  result.batches.push(batch);
  result.undo = { batchId: batch.id, roster: structuredClone(state.roster), dataset: structuredClone(state.dataset) };
  result.revision++;
  return validateAppState(result);
}

export function undoLastImport(state: AppState): AppState {
  validateAppState(state);
  if (!state.undo) throw new Error('目前沒有可撤銷的合併。');
  const result = structuredClone(state);
  const original = state.batches.find(batch => batch.id === state.undo!.batchId)!;
  result.roster = structuredClone(state.undo.roster);
  result.batches.push({ id: `undo-${crypto.randomUUID()}`, kind: 'undo', source: '撤銷上次合併', contentHash: original.contentHash, createdAt: new Date().toISOString(), completeness: 'partial', adapterVersion: '1.0.0', counts: { added: 0, changed: 0, repeated: 0, conflicts: 0, missing: 0 }, decisions: {}, candidates: [], conflicts: [], revertedBatchId: original.id });
  delete result.undo;
  result.revision++;
  if (isPublicTwCatalog(state.dataset) && isPublicTwCatalog(state.undo.dataset)) {
    // 純名稱等更新可回復舊定義；若本次批次新增 ID，保留新版定義才能解釋完整歷史。
    // 撤銷一律回復舊幹員資料，不刪除或改寫已保存的批次證據。
    const prior = { ...result, dataset: structuredClone(state.undo.dataset) };
    try { validateAppState(prior); result.dataset = prior.dataset; }
    catch { /* 舊定義無法承接保留的歷史時，沿用新版定義。 */ }
  }
  return validateAppState(result);
}

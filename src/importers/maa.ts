import { validateImportDocument, verifyDatasetChecksum, type Dataset, type Evidence, type ImportDocument, type OwnedOperator } from '../domain/model.ts';

/* ------------------------------------------------------------------ */
/* MAA「幹員辨識」（OperBox）結果 → 本工具匯入格式。                         */
/* 依 MAA 官方《回呼訊息協定》：details.own_opers[] 含 id、name、own、elite、level、potential、rarity；      */
/* all_oper[] 含 own（未持有者標為未持有）。只投影這些欄位，其他養成欄位維持未知。 */
/* ------------------------------------------------------------------ */
const SOURCE = 'MAA 幹員辨識（OperBox，畫面辨識結果）';
type Row = Record<string, unknown>;

export function isMaaOperBox(value: unknown): boolean {
  const row = value as Row | null;
  return !!row && typeof row === 'object' && (Array.isArray(row.own_opers) || Array.isArray((row.details as Row | undefined)?.own_opers));
}

export async function convertMaaOperBox(value: unknown, options: { dataset: Dataset; importedAt: string }): Promise<{ document: ImportDocument; unmatched: string[] }> {
  const root = value as Row;
  const details = (Array.isArray(root.own_opers) ? root : root.details) as Row;
  const own = details.own_opers as Row[], all = Array.isArray(details.all_oper) ? details.all_oper as Row[] : [];
  if (own.length > 2000 || all.length > 2000) throw new Error('幹員數量超出上限。');
  const ids = new Set(options.dataset.operators.map(op => op.id));
  const byName = new Map(options.dataset.operators.map(op => [op.displayName, op.id]));
  const meta = { source: SOURCE, importedAt: options.importedAt, manuallyConfirmed: false } as const;
  const known = <T extends number | boolean>(value: T): Evidence => ({ ...meta, status: 'known', value });
  const unmatched: string[] = [];
  const resolve = (row: Row) => { const id = typeof row.id === 'string' && ids.has(row.id) ? row.id : typeof row.name === 'string' ? byName.get(row.name) : undefined; if (!id) unmatched.push(String(row.name ?? row.id ?? '?')); return id; };
  const candidates = new Map<string, OwnedOperator>();
  const integer = (input: unknown, min: number, max: number) => Number.isInteger(input) && (input as number) >= min && (input as number) <= max ? input as number : undefined;
  for (const row of own) {
    if (!row || typeof row !== 'object' || row.own === false) continue;
    const id = resolve(row);
    if (!id || candidates.has(id)) continue;
    const fields: Record<string, Evidence> = { owned: known(true) };
    const elite = integer(row.elite, 0, 2), level = integer(row.level, 1, 90), potential = integer(row.potential, 1, 6);
    if (elite !== undefined) fields.elite = known(elite);
    if (level !== undefined) fields.level = known(level);
    if (potential !== undefined) fields.potential = known(potential);
    candidates.set(id, { operatorId: id, fields });
  }
  for (const row of all) {
    if (!row || typeof row !== 'object' || row.own !== false) continue;
    const id = resolve(row);
    if (id && !candidates.has(id)) candidates.set(id, { operatorId: id, fields: { owned: known(false) } });
  }
  if (!candidates.size) throw new Error('沒有可對應到繁中圖鑑的幹員。');
  const document: ImportDocument = {
    format: 'arknights-roster-import', schemaVersion: 1, product: 'arknights', server: 'tw', namespace: options.dataset.metadata.namespace,
    dataset: structuredClone(options.dataset), candidates: [...candidates.values()], completeness: 'partial', source: SOURCE, adapterVersion: 'maa-operbox-1', createdAt: options.importedAt,
  };
  validateImportDocument(document);
  try { await verifyDatasetChecksum(document.dataset); } catch { throw new Error('資料集校驗值不符，已拒絕轉換。'); }
  return { document, unmatched: [...new Set(unmatched)] };
}

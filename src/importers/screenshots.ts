/** 本機 OCR 核對格式；不產生正式幹員 ID、不推定帳號持有、不寫入幹員庫。 */
export interface Bounds { x: number; y: number; width: number; height: number }
export interface OcrWord { text: string; bounds: Bounds }
export interface OcrVariant { name: string; scale: number; elapsedMs: number; lines: { text: string; words: OcrWord[] }[] }
export interface OcrImage { assetId: string; sha256: string; label: string; width: number; height: number; variants: OcrVariant[] }
export interface OcrBatch { format: 'arknights-local-ocr'; schemaVersion: 1; createdAt: string; engine: { name: string; language: string; version: string }; images: OcrImage[] }
export interface OcrEvidence { assetId: string; variant: string; rawText: string; bounds: Bounds }
export interface OcrField { status: 'candidate' | 'unknown' | 'conflict'; value?: number; evidence: OcrEvidence[] }
export interface ScreenshotRow {
  candidateId: string; name: string | null; nameEvidence: OcrEvidence[]; mappingStatus: 'unmapped';
  fields: { level: OcrField; trust: OcrField; skillLevel: OcrField };
  sources: { assetId: string; rowIndex: number; bounds: Bounds; variant: string }[]; issues: string[];
}
export interface ScreenshotReview {
  format: 'arknights-screenshot-review'; schemaVersion: 1; product: 'arknights'; server: 'tw'; createdAt: string;
  engine: OcrBatch['engine']; images: Omit<OcrImage, 'variants'>[]; rows: ScreenshotRow[];
  summary: { imageCount: number; rowOccurrences: number; uniqueCandidates: number; overlapOccurrences: number; partialRows: number; unmapped: number };
}

type ObjectValue = Record<string, unknown>;
const MAX_BYTES = 10 * 1024 * 1024;
const BODY_TOP = 258, BODY_BOTTOM = 1237, ROW_HEIGHT = 102.7;
const fieldLimits = { level: [1, 90], trust: [0, 200], skillLevel: [1, 7] } as const;
const iconIssue = '精英化、專精、潛能與模組圖示未辨識，保留未知';
const partialIssue = '截圖邊緣半列，遮住的欄位保留未知';

function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('辨識結果格式無效。');
  return value as ObjectValue;
}
function keys(value: ObjectValue, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('辨識結果包含未允許欄位。');
}
function textValue(value: unknown, max = 300): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw new Error('辨識結果文字格式無效。');
}
function integer(value: unknown, min: number, max: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error('辨識結果數值格式無效。');
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('辨識結果陣列格式無效。');
  return value;
}
function bounds(value: unknown, width: number, height: number): void {
  const rect = object(value); keys(rect, ['x', 'y', 'width', 'height']);
  for (const key of ['x', 'y', 'width', 'height']) if (typeof rect[key] !== 'number' || !Number.isFinite(rect[key]) || rect[key] < 0) throw new Error('辨識結果座標無效。');
  if ((rect.width as number) <= 0 || (rect.height as number) <= 0 || (rect.x as number) + (rect.width as number) > width + 1 || (rect.y as number) + (rect.height as number) > height + 1) throw new Error('辨識結果座標超出原圖。');
}
function metadata(value: ObjectValue): void {
  if (value.schemaVersion !== 1) throw new Error('辨識結果版本不支援。');
  textValue(value.createdAt, 40);
  if (!Number.isFinite(Date.parse(value.createdAt))) throw new Error('辨識結果日期格式無效。');
  const engine = object(value.engine); keys(engine, ['name', 'language', 'version']);
  for (const key of ['name', 'language', 'version']) textValue(engine[key]);
}
function imageMetadata(value: unknown): Omit<OcrImage, 'variants'> {
  const item = object(value);
  textValue(item.assetId, 100); textValue(item.label, 200);
  if (!/^image-[A-Za-z0-9_-]+$/u.test(item.assetId)) throw new Error('圖片識別碼格式無效。');
  if (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sha256)) throw new Error('圖片 SHA-256 格式無效。');
  integer(item.width, 1, 4000); integer(item.height, 1, 4000);
  return { assetId: item.assetId, label: item.label, sha256: item.sha256, width: item.width, height: item.height };
}
function validateBatch(value: unknown): OcrBatch {
  const input = object(value); keys(input, ['format', 'schemaVersion', 'createdAt', 'engine', 'images']); metadata(input);
  if (input.format !== 'arknights-local-ocr') throw new Error('本機 OCR 格式不支援。');
  const images = list(input.images, 100);
  if (!images.length) throw new Error('沒有可辨識圖片。');
  for (const entry of images) {
    const item = object(entry); keys(item, ['assetId', 'sha256', 'label', 'width', 'height', 'variants']);
    const image = imageMetadata(item);
    if (image.width !== 589 || image.height !== 1280) throw new Error('目前只驗證 589 × 1280 的幹員清單版型；其他解析度尚未支援。');
    const variants = list(item.variants, 100);
    if (!variants.length) throw new Error('圖片缺少辨識結果。');
    const names = new Set<string>();
    for (const candidate of variants) {
      const variant = object(candidate); keys(variant, ['name', 'scale', 'elapsedMs', 'lines']); textValue(variant.name, 100);
      if (!/^[A-Za-z0-9_-]+$/u.test(variant.name)) throw new Error('辨識變體名稱格式無效。');
      if (names.has(variant.name)) throw new Error('同圖辨識變體重複。'); names.add(variant.name);
      if (typeof variant.scale !== 'number' || !Number.isFinite(variant.scale) || variant.scale <= 0 || variant.scale > 4) throw new Error('辨識縮放比例無效。');
      integer(variant.elapsedMs, 0, 600000);
      for (const entry of list(variant.lines, 10000)) {
        const line = object(entry); keys(line, ['text', 'words']); textValue(line.text, 2000);
        for (const entry of list(line.words, 1000)) {
          const word = object(entry); keys(word, ['text', 'bounds']); textValue(word.text, 300);
          bounds(word.bounds, image.width * variant.scale, image.height * variant.scale);
        }
      }
    }
  }
  return value as OcrBatch;
}

function union(items: Bounds[]): Bounds {
  const x = Math.min(...items.map(item => item.x)), y = Math.min(...items.map(item => item.y));
  return { x, y, width: Math.max(...items.map(item => item.x + item.width)) - x, height: Math.max(...items.map(item => item.y + item.height)) - y };
}
function field(evidence: OcrEvidence[], min: number, max: number): OcrField {
  const valid = evidence.filter(item => /^\d{1,3}$/u.test(item.rawText) && Number(item.rawText) >= min && Number(item.rawText) <= max);
  const values = [...new Set(valid.map(item => Number(item.rawText)))];
  return values.length === 1 ? { status: 'candidate', value: values[0], evidence } : { status: values.length ? 'conflict' : 'unknown', evidence };
}
function normalizedWords(image: OcrImage): OcrEvidence[] {
  return image.variants.flatMap(variant => variant.lines.flatMap(line => line.words.map(word => ({
    assetId: image.assetId, variant: variant.name, rawText: word.text,
    bounds: { x: word.bounds.x / variant.scale, y: word.bounds.y / variant.scale, width: word.bounds.width / variant.scale, height: word.bounds.height / variant.scale },
  }))));
}
function nameLines(words: OcrEvidence[]): OcrEvidence[] {
  const candidates = words.filter(item => item.bounds.x >= 105 && item.bounds.x + item.bounds.width <= 250 && item.bounds.y >= BODY_TOP && item.bounds.y < BODY_BOTTOM && item.bounds.height >= 8 && /^[\p{Script=Han}A-Za-z·・]+$/u.test(item.rawText));
  const lines: OcrEvidence[][] = [];
  for (const item of candidates.sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x)) {
    const group = lines.find(line => line[0].variant === item.variant && Math.abs(line[0].bounds.y - item.bounds.y) < 7);
    if (group) group.push(item); else lines.push([item]);
  }
  return lines.map(line => ({ ...line[0], rawText: line.sort((a, b) => a.bounds.x - b.bounds.x).map(item => item.rawText).join(''), bounds: union(line.map(item => item.bounds)) }))
    .filter(item => /\p{Script=Han}/u.test(item.rawText) || item.rawText === 'W' || /^[A-Za-z]{2,}$/u.test(item.rawText));
}

/** 版型座標只適用本次六張 589 × 1280 研究樣本。 */
export function createScreenshotReview(value: OcrBatch): ScreenshotReview {
  const input = validateBatch(value);
  const images: OcrImage[] = [], hashes = new Set<string>(), assetIds = new Set<string>();
  for (const image of input.images) {
    if (hashes.has(image.sha256)) continue;
    if (assetIds.has(image.assetId)) throw new Error('不同圖片使用相同 assetId。');
    hashes.add(image.sha256); assetIds.add(image.assetId); images.push(image);
  }
  const occurrences: ScreenshotRow[] = [];
  let partialRows = 0;
  for (const image of images) {
    const words = normalizedWords(image).filter(item => item.bounds.y >= BODY_TOP && item.bounds.y + item.bounds.height <= BODY_BOTTOM);
    const names = nameLines(words);
    const levelWords = words.filter(item => item.bounds.x >= 133 && item.bounds.x + item.bounds.width <= 168 && item.bounds.height >= 10);
    const trustWords = words.filter(item => item.bounds.x >= 392 && item.bounds.x + item.bounds.width <= 437 && item.bounds.height >= 10);
    const rankWords = words.filter(item => item.bounds.x >= 327 && item.bounds.x + item.bounds.width <= 347 && item.bounds.height <= 15);
    const anchors = [...names.map(item => item.bounds.y), ...levelWords.map(item => item.bounds.y - 35), ...trustWords.map(item => item.bounds.y - 19)];
    if (!anchors.length) continue;
    // 可見列採固定間距，排除不在列位置上的圖示碎字。
    const distance = (a: number, b: number) => Math.abs(a - b - Math.round((a - b) / ROW_HEIGHT) * ROW_HEIGHT);
    const phase = [...anchors].sort((a, b) => anchors.filter(y => distance(y, b) < 7).length - anchors.filter(y => distance(y, a) < 7).length)[0];
    const groups = new Map<number, number[]>();
    for (const y of anchors.filter(y => distance(y, phase) < 7)) {
      const index = Math.round((y - phase) / ROW_HEIGHT);
      groups.set(index, [...(groups.get(index) ?? []), y]);
    }
    const rowYs = [...groups.values()].map(group => group.sort((a, b) => a - b)[Math.floor(group.length / 2)]).sort((a, b) => a - b);
    const firstVisibleY = phase + Math.ceil((BODY_TOP - 7 - phase) / ROW_HEIGHT) * ROW_HEIGHT;
    for (const y of rowYs) {
      const nameEvidence = names.filter(item => Math.abs(item.bounds.y - y) < 8);
      const nameSet = [...new Set(nameEvidence.map(item => item.rawText))];
      // 不以多數決讓重複的前處理錯字覆蓋其他文字；分歧一律留待核對。
      const name = nameSet.length === 1 ? nameSet[0] : null;
      const level = field(levelWords.filter(item => Math.abs(item.bounds.y - y - 35) < 8), 1, 90);
      const trust = field(trustWords.filter(item => Math.abs(item.bounds.y - y - 19) < 8), 0, 200);
      const skillLevel = field(rankWords.filter(item => Math.abs(item.bounds.y - y - 43) < 8), 1, 7);
      const issues = [iconIssue];
      if (nameSet.length > 1) issues.push('姓名辨識變體有分歧；保留全部文字證據，需人工核對');
      if (!name) issues.push('姓名未知或候選並列，未跨圖合併');
      if (y + 48 > BODY_BOTTOM || y < BODY_TOP + 10) { issues.push(partialIssue); partialRows++; }
      if (Object.values({ level, trust, skillLevel }).some(item => item.status === 'unknown')) issues.push('部分文字未辨識或超出範圍，保留未知');
      const top = Math.max(BODY_TOP, Math.floor(y - 15)), bottom = Math.min(BODY_BOTTOM, Math.ceil(y + ROW_HEIGHT - 15));
      occurrences.push({ candidateId: '', name, nameEvidence, mappingStatus: 'unmapped', fields: { level, trust, skillLevel },
        sources: [{ assetId: image.assetId, rowIndex: Math.round((y - firstVisibleY) / ROW_HEIGHT) + 1, bounds: { x: 20, y: top, width: 550, height: bottom - top }, variant: image.variants.map(item => item.name).join('+') }], issues });
    }
  }
  if (!occurrences.length) throw new Error('未找到受支援版型的幹員文字，未產生成功結果。');
  const rows: ScreenshotRow[] = [];
  for (const occurrence of occurrences) {
    // 顯示姓名分組不代表穩定 ID 對應。
    const existing = occurrence.name ? rows.find(row => row.name === occurrence.name && !row.sources.some(source => source.assetId === occurrence.sources[0].assetId)) : undefined;
    if (!existing) { rows.push({ ...occurrence, candidateId: `candidate-${rows.length + 1}` }); continue; }
    existing.nameEvidence.push(...occurrence.nameEvidence); existing.sources.push(...occurrence.sources);
    existing.issues = [...new Set([...existing.issues, ...occurrence.issues, '跨圖完整姓名相同，僅分組候選；尚未對應正式 ID'])];
    for (const key of ['level', 'trust', 'skillLevel'] as const) existing.fields[key] = field([...existing.fields[key].evidence, ...occurrence.fields[key].evidence], fieldLimits[key][0], fieldLimits[key][1]);
  }
  for (const row of rows) if (Object.values(row.fields).some(item => item.status === 'conflict')) row.issues.push('同組數值有衝突，未自行選值');
  return { format: 'arknights-screenshot-review', schemaVersion: 1, product: 'arknights', server: 'tw', createdAt: input.createdAt, engine: input.engine,
    images: images.map(({ variants: _, ...image }) => image), rows,
    summary: { imageCount: images.length, rowOccurrences: occurrences.length, uniqueCandidates: rows.length, overlapOccurrences: occurrences.length - rows.length, partialRows, unmapped: rows.length } };
}

function validateReview(value: unknown): ScreenshotReview {
  const input = object(value); keys(input, ['format', 'schemaVersion', 'product', 'server', 'createdAt', 'engine', 'images', 'rows', 'summary']); metadata(input);
  if (input.format !== 'arknights-screenshot-review' || input.product !== 'arknights') throw new Error('辨識結果格式或產品不支援。');
  if (input.server !== 'tw') throw new Error('辨識結果服別不支援。');
  const images = list(input.images, 100).map(entry => { const item = object(entry); keys(item, ['assetId', 'sha256', 'label', 'width', 'height']); return imageMetadata(item); });
  if (!images.length || new Set(images.map(item => item.assetId)).size !== images.length || new Set(images.map(item => item.sha256)).size !== images.length) throw new Error('圖片清單為空或重複。');
  function evidence(value: unknown): OcrEvidence[] {
    return list(value, 1000).map(entry => { const item = object(entry); keys(item, ['assetId', 'variant', 'rawText', 'bounds']); textValue(item.variant, 100); textValue(item.rawText, 300);
      const image = images.find(image => image.assetId === item.assetId); if (!image) throw new Error('證據引用未知圖片。'); bounds(item.bounds, image.width, image.height); return item as unknown as OcrEvidence; });
  }
  const rows = list(input.rows, 2000); if (!rows.length) throw new Error('辨識結果缺少候選列。');
  const ids = new Set<string>(), sourceKeys = new Set<string>(); let occurrences = 0;
  for (const entry of rows) {
    const row = object(entry); keys(row, ['candidateId', 'name', 'nameEvidence', 'mappingStatus', 'fields', 'sources', 'issues']); textValue(row.candidateId, 100);
    if (ids.has(row.candidateId)) throw new Error('辨識候選 ID 重複。'); ids.add(row.candidateId);
    if (row.name !== null) textValue(row.name, 100);
    if (row.mappingStatus !== 'unmapped') throw new Error('此格式不接受正式 ID 對應。');
    const names = evidence(row.nameEvidence), distinctNames = [...new Set(names.map(item => item.rawText))];
    if (row.name !== (distinctNames.length === 1 ? distinctNames[0] : null)) throw new Error('候選姓名與文字證據不符。');
    const fields = object(row.fields); keys(fields, ['level', 'trust', 'skillLevel']);
    for (const key of ['level', 'trust', 'skillLevel'] as const) {
      const item = object(fields[key]); keys(item, ['status', 'value', 'evidence']); const entries = evidence(item.evidence);
      if (!['candidate', 'unknown', 'conflict'].includes(String(item.status))) throw new Error('候選狀態無效。');
      if (item.status === 'candidate') { integer(item.value, fieldLimits[key][0], fieldLimits[key][1]); if (!entries.length) throw new Error('候選數值缺少證據。'); }
      else if ('value' in item) throw new Error('未知或衝突欄位不得含值。');
      const computed = field(entries, fieldLimits[key][0], fieldLimits[key][1]);
      if (computed.status !== item.status || computed.value !== item.value) throw new Error('候選數值與文字證據不符。');
    }
    const sources = list(row.sources, 100); if (!sources.length) throw new Error('候選列缺少來源。');
    for (const entry of sources) {
      const source = object(entry); keys(source, ['assetId', 'rowIndex', 'bounds', 'variant']); const image = images.find(image => image.assetId === source.assetId);
      if (!image) throw new Error('候選列引用未知圖片。'); integer(source.rowIndex, 1, 2000); textValue(source.variant, 2000); bounds(source.bounds, image.width, image.height);
      const key = `${source.assetId}:${source.rowIndex}`; if (sourceKeys.has(key)) throw new Error('同一來源列重複出現。'); sourceKeys.add(key); occurrences++;
    }
    const allEvidence = [...names, ...(['level', 'trust', 'skillLevel'] as const).flatMap(key => (fields[key] as unknown as OcrField).evidence)];
    for (const item of allEvidence) {
      const matchingSource = sources.some(entry => {
        const source = entry as ScreenshotRow['sources'][number];
        return source.assetId === item.assetId && source.variant.split('+').includes(item.variant) &&
          item.bounds.x >= source.bounds.x && item.bounds.y >= source.bounds.y &&
          item.bounds.x + item.bounds.width <= source.bounds.x + source.bounds.width + 1 &&
          item.bounds.y + item.bounds.height <= source.bounds.y + source.bounds.height + 1;
      });
      if (!matchingSource) throw new Error('文字證據不屬於此候選列的來源範圍。');
    }
    list(row.issues, 100).forEach(item => textValue(item, 500));
  }
  const summary = object(input.summary); keys(summary, ['imageCount', 'rowOccurrences', 'uniqueCandidates', 'overlapOccurrences', 'partialRows', 'unmapped']);
  for (const key of Object.keys(summary)) integer(summary[key], 0, 200000);
  if (summary.imageCount !== images.length || summary.rowOccurrences !== occurrences || summary.uniqueCandidates !== rows.length || summary.overlapOccurrences !== occurrences - rows.length || summary.unmapped !== rows.length || typeof summary.partialRows !== 'number' || summary.partialRows > occurrences) throw new Error('辨識結果統計與候選內容不符。');
  return input as unknown as ScreenshotReview;
}

export function parseScreenshotReviewText(text: string): ScreenshotReview {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_BYTES) throw new Error('辨識結果超出 10 MB 限制。');
  let value: unknown; try { value = JSON.parse(text); } catch { throw new Error('辨識結果不是有效 JSON。'); }
  return validateReview(value);
}

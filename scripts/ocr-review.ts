/** 把私人 OCR 原始文字轉成核對結果；不寫入正式幹員庫。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScreenshotReview, parseScreenshotReviewText, type OcrBatch } from '../src/importers/screenshots.ts';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const privateRoot = path.join(project, 'private-fixtures');

function confined(file: string): string {
  const target = path.resolve(file), relative = path.relative(privateRoot, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.extname(target).toLowerCase() !== '.json') throw new Error('輸入及輸出只能是 private-fixtures 內的 JSON。');
  let current = target;
  for (;;) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('不允許經符號連結或 junction 讀寫結果。');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  return target;
}

try {
  const args = process.argv.slice(2), inputs: string[] = []; let output: string | undefined;
  while (args.length) {
    const option = args.shift(), value = args.shift();
    if (!value || !['--input', '--output'].includes(option ?? '')) throw new Error('用法：--input raw-ocr.json [--input raw-ocr-2.json] --output review.json');
    if (option === '--input') inputs.push(confined(value));
    else if (output) throw new Error('只能提供一個輸出檔。'); else output = confined(value);
  }
  if (!inputs.length || inputs.length > 10 || !output || inputs.includes(output)) throw new Error('需要 1 至 10 個輸入，並指定不同的新輸出檔。');
  let batch: OcrBatch | undefined;
  for (const input of inputs) {
    if (fs.statSync(input).size > 10 * 1024 * 1024) throw new Error('單一 OCR JSON 上限為 10 MB。');
    const next = JSON.parse(fs.readFileSync(input, 'utf8')) as OcrBatch;
    // 先獨立驗證各份結果，再合併同一原圖的不同辨識變體。
    createScreenshotReview(next);
    if (!batch) { batch = next; continue; }
    if (JSON.stringify(batch.engine) !== JSON.stringify(next.engine)) throw new Error('不同引擎的結果不能直接合併。');
    for (const image of next.images) {
      const existing = batch.images.find(item => item.sha256 === image.sha256);
      if (!existing) batch.images.push(image);
      else {
        if (existing.assetId !== image.assetId || existing.width !== image.width || existing.height !== image.height) throw new Error('同一圖片的識別資訊不一致。');
        existing.variants.push(...image.variants);
      }
    }
  }
  const result = createScreenshotReview(batch!);
  const json = JSON.stringify(result, null, 2); parseScreenshotReviewText(json);
  fs.writeFileSync(output, json, { encoding: 'utf8', flag: 'wx' });
  console.log(JSON.stringify(result.summary));
} catch (error) {
  console.error(error instanceof Error ? error.message : '無法產生核對結果。'); process.exitCode = 1;
}

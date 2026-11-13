import { readFile, stat, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertSkportOffline } from '../src/importers/skport.ts';
import { MAX_IMPORT_BYTES, validateDataset, verifyDatasetChecksum } from '../src/domain/model.ts';

const HELP = `用法：node --experimental-strip-types scripts/convert-skport.ts --input <研究封裝.json> --dataset <資料集.json> --out <private-fixtures/結果.json> --confirm-arknights-tw

僅處理已合法取得的本機研究資料，不會登入或讀取網路。
--confirm-arknights-tw 表示你已核對輸入屬於本作繁中服；不是自動服別驗證或官方使用授權。
輸出限專案 private-fixtures 目錄，拒絕覆寫既有檔案。`;

async function readJson(filename: string): Promise<unknown> {
  if ((await stat(filename)).size > MAX_IMPORT_BYTES) throw new Error('輸入檔超過 10 MB。');
  const text = await readFile(filename, 'utf8');
  if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) throw new Error('輸入檔超過 10 MB。');
  return JSON.parse(text);
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { process.stdout.write(`${HELP}\n`); return; }
  const options = new Map<string, string>();
  let confirmed = false;
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--confirm-arknights-tw' && !confirmed) { confirmed = true; continue; }
    if (!['--input', '--dataset', '--out'].includes(key) || options.has(key) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('參數錯誤。');
    options.set(key, args[++index]);
  }
  if (!confirmed || options.size !== 3) throw new Error('需要全部參數與明確的產品／服別確認。');
  const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const privateRoot = path.join(project, 'private-fixtures');
  const output = path.resolve(project, options.get('--out')!);
  if (!within(privateRoot, output) || path.extname(output) !== '.json') throw new Error('輸出必須是專案 private-fixtures 內的 JSON。');

  const dataset = validateDataset(await readJson(options.get('--dataset')!));
  await verifyDatasetChecksum(dataset);
  const result = await convertSkportOffline(await readJson(options.get('--input')!), {
    dataset, confirmation: { product: 'arknights', server: 'tw', confirmedByUser: true }, importedAt: new Date().toISOString(),
  });
  await mkdir(privateRoot, { recursive: true });
  // 僅允許既有真實子目錄，拒絕 symlink/junction 導向專案之外。
  const rootReal = await realpath(privateRoot);
  if (rootReal.toLowerCase() !== privateRoot.toLowerCase()) throw new Error('私人輸出目錄不可為外部連結。');
  const parentReal = await realpath(path.dirname(output));
  if (parentReal.toLowerCase() !== rootReal.toLowerCase() && !within(rootReal, parentReal)) throw new Error('輸出目錄不在私人素材範圍。');
  await writeFile(output, JSON.stringify(result.document, null, 2), { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(`已產生 ${result.document.candidates.length} 筆局部候選；${result.issues.length} 項研究限制。請在網站個人庫選擇輸出 JSON，逐欄預覽確認。尚未登入或驗證帳號完整性。\n`);
}

main().catch(() => {
  // 不輸出來源內容、解析片段或可能帶有帳號識別的例外。
  process.stderr.write(`轉換失敗，未覆寫既有輸出。請檢查參數、格式、校驗值、穩定 ID 定義與輸出目錄。\n${HELP}\n`);
  process.exitCode = 1;
});

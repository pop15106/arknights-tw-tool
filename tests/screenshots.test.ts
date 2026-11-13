import test from 'node:test';
import assert from 'node:assert/strict';
import { createScreenshotReview, parseScreenshotReviewText, type OcrBatch, type OcrWord } from '../src/importers/screenshots.ts';

const word = (text: string, x: number, y: number, width = 30, height = 18): OcrWord => ({ text, bounds: { x, y, width, height } });
function fixture(): OcrBatch {
  return {
    format: 'arknights-local-ocr', schemaVersion: 1, createdAt: '2026-11-13T06:00:00.000Z',
    engine: { name: '測試引擎', language: 'zh-Hant-TW', version: 'test-1' },
    images: [{ assetId: 'image-test1', sha256: 'a'.repeat(64), label: '虛構圖片甲', width: 589, height: 1280,
      variants: [{ name: 'original', scale: 1, elapsedMs: 1, lines: [
        { text: '測試甲', words: [word('測試甲', 108, 280, 72)] },
        { text: '90', words: [word('90', 137, 318)] },
        { text: '200', words: [word('200', 397, 303)] },
        { text: 'RANK 7', words: [word('RANK', 300, 332, 30, 10), word('7', 334, 332, 8, 10)] },
      ] }] }],
  };
}

test('截圖解析保留候選、座標與未知，不捏造穩定 ID 或圖示狀態', () => {
  const result = createScreenshotReview(fixture());
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].name, '測試甲');
  assert.equal(result.rows[0].mappingStatus, 'unmapped');
  assert.equal(result.rows[0].fields.level.value, 90);
  assert.equal(result.rows[0].fields.trust.value, 200);
  assert.equal(result.rows[0].fields.skillLevel.value, 7);
  assert.equal(result.rows[0].fields.level.status, 'candidate');
  assert.equal(result.rows[0].fields.level.evidence[0].assetId, 'image-test1');
  assert.equal('operatorId' in result.rows[0], false);
  assert.ok(result.rows[0].issues.some(issue => issue.includes('圖示')));
});

test('跨圖片精確同名合併且保留來源，部分字串與異格不合併', () => {
  const input = fixture();
  const second = structuredClone(input.images[0]); second.assetId = 'image-test2'; second.sha256 = 'b'.repeat(64);
  const third = structuredClone(input.images[0]); third.assetId = 'image-test3'; third.sha256 = 'c'.repeat(64);
  third.variants[0].lines[0].words[0].text = '測試甲異格';
  input.images.push(second, third);
  const result = createScreenshotReview(input);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].sources.length, 2);
  assert.equal(result.summary.overlapOccurrences, 1);
});

test('重複圖片以內容雜湊去重，不重算處理量', () => {
  const input = fixture(); input.images.push(structuredClone(input.images[0]));
  const result = createScreenshotReview(input);
  assert.equal(result.images.length, 1);
  assert.equal(result.rows[0].sources.length, 1);
});

test('相同名稱的不同等級保留衝突，不自行取最大值', () => {
  const input = fixture();
  const second = structuredClone(input.images[0]); second.assetId = 'image-test2'; second.sha256 = 'b'.repeat(64);
  second.variants[0].lines[1].words[0].text = '80'; input.images.push(second);
  const result = createScreenshotReview(input);
  assert.equal(result.rows[0].fields.level.status, 'conflict');
  assert.equal(result.rows[0].fields.level.value, undefined);
  assert.equal(result.rows[0].fields.level.evidence.length, 2);
});

test('缺漏和超出數字範圍保留未知；不把未辨識當成零', () => {
  const input = fixture();
  input.images[0].variants[0].lines[1].words[0].text = '9O';
  input.images[0].variants[0].lines[2].words[0].text = '201';
  input.images[0].variants[0].lines[3].words[1].text = '9';
  const row = createScreenshotReview(input).rows[0];
  assert.equal(row.fields.level.status, 'unknown');
  assert.equal(row.fields.trust.status, 'unknown');
  assert.equal(row.fields.skillLevel.status, 'unknown');
  assert.equal(row.fields.level.value, undefined);
});

test('半列保留名字與問題，不補上遮住的養成數字', () => {
  const input = fixture();
  input.images[0].variants[0].lines = [{ text: '測試尾列', words: [word('測試尾列', 108, 1207, 80)] }];
  const result = createScreenshotReview(input);
  assert.equal(result.rows[0].name, '測試尾列');
  assert.equal(result.rows[0].fields.level.status, 'unknown');
  assert.equal(result.summary.partialRows, 1);
});

test('放大版座標還原到原圖且不重複列出同一圖的幹員', () => {
  const input = fixture();
  const enlarged = structuredClone(input.images[0].variants[0]); enlarged.name = 'upscale2'; enlarged.scale = 2;
  for (const line of enlarged.lines) for (const entry of line.words) for (const key of ['x', 'y', 'width', 'height'] as const) entry.bounds[key] *= 2;
  input.images[0].variants.push(enlarged);
  const result = createScreenshotReview(input);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].sources.length, 1);
  assert.equal(result.rows[0].nameEvidence.length, 2);
  assert.equal(result.summary.rowOccurrences, 1);
});

test('空白、未支援版型及錯誤 JSON 均不回報匯入成功', () => {
  assert.throws(() => createScreenshotReview({ ...fixture(), images: [] }), /圖片/);
  const small = fixture(); small.images[0].width = 100;
  assert.throws(() => createScreenshotReview(small), /版型|解析度/);
  assert.throws(() => parseScreenshotReviewText('null'), /格式/);
  assert.throws(() => parseScreenshotReviewText('{'), /JSON/);
});

test('review 格式可重讀但拒絕版本、命名空間及額外登入資訊', () => {
  const review = createScreenshotReview(fixture());
  assert.deepEqual(parseScreenshotReviewText(JSON.stringify(review)), review);
  assert.throws(() => parseScreenshotReviewText(JSON.stringify({ ...review, schemaVersion: 2 })), /版本/);
  assert.throws(() => parseScreenshotReviewText(JSON.stringify({ ...review, server: 'cn' })), /服別/);
  assert.throws(() => parseScreenshotReviewText(JSON.stringify({ ...review, token: '不應保存' })), /未允許|欄位/);
});

test('拒絕竄改數值、姓名及證據來源的 review', () => {
  const review = createScreenshotReview(fixture());
  const wrongNumber = structuredClone(review); wrongNumber.rows[0].fields.level.value = 1;
  assert.throws(() => parseScreenshotReviewText(JSON.stringify(wrongNumber)), /證據/);
  const wrongName = structuredClone(review); wrongName.rows[0].name = '另一位幹員';
  assert.throws(() => parseScreenshotReviewText(JSON.stringify(wrongName)), /證據/);
  const wrongLocation = structuredClone(review); wrongLocation.rows[0].fields.level.evidence[0].bounds.y += 300;
  assert.throws(() => parseScreenshotReviewText(JSON.stringify(wrongLocation)), /來源範圍/);
  const wrongVariant = structuredClone(review); wrongVariant.rows[0].fields.level.evidence[0].variant = 'never-run';
  assert.throws(() => parseScreenshotReviewText(JSON.stringify(wrongVariant)), /來源範圍/);
});

test('處理變體的重複錯字不以多數決覆蓋另一姓名', () => {
  const input = fixture();
  for (const name of ['upscale2', 'invert2']) {
    const variant = structuredClone(input.images[0].variants[0]); variant.name = name;
    variant.lines[0].words[0].text = '測試'; input.images[0].variants.push(variant);
  }
  const result = createScreenshotReview(input);
  assert.equal(result.rows[0].name, null);
  assert.equal(result.rows[0].nameEvidence.length, 3);
  assert.ok(result.rows[0].issues.some(item => item.includes('分歧')));
});

test('缺少姓名的列仍保留數字證據但不跨圖合併', () => {
  const input = fixture(); input.images[0].variants[0].lines.shift();
  const second = structuredClone(input.images[0]); second.assetId = 'image-test2'; second.sha256 = 'b'.repeat(64); input.images.push(second);
  const result = createScreenshotReview(input);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].name, null);
  assert.equal(result.rows[0].fields.level.value, 90);
  assert.equal(result.summary.overlapOccurrences, 0);
});

test('中間整列未辨識時保留原圖列次，不把後續列往前移', () => {
  const input = fixture();
  const third = structuredClone(input.images[0].variants[0].lines);
  for (const line of third) for (const entry of line.words) entry.bounds.y += 205.4;
  third[0].words[0].text = '測試第三列'; third[0].words[0].bounds.width = 100;
  input.images[0].variants[0].lines.push(...third);
  const result = createScreenshotReview(input);
  assert.deepEqual(result.rows.map(row => row.sources[0].rowIndex), [1, 3]);
});

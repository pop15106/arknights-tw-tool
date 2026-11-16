import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoDataset } from '../src/demo.ts';
import { createEmptyState, MAX_BACKUP_BYTES, type BatchRecord } from '../src/domain/model.ts';
import { createBackup } from '../src/storage/backup.ts';
import { describeCapacity, MAX_BATCH_RECORDS, measureCapacity } from '../src/storage/capacity.ts';

function batch(index: number): BatchRecord {
  return { id: `batch-${index}`, kind: 'import', source: '合成批次', contentHash: `sha256:${'0'.repeat(64)}`, createdAt: '2026-11-16T00:00:00.000Z', completeness: 'partial', adapterVersion: 'test',
    counts: { added: 0, changed: 0, repeated: 1, conflicts: 0, missing: 0 }, decisions: {}, candidates: [], conflicts: [] };
}

test('STORE-01：空庫為正常，估計值不低於實際備份大小', async () => {
  const state = createEmptyState(await createDemoDataset());
  const report = measureCapacity(state);
  assert.equal(report.level, 'ok');
  assert.ok(report.backupBytes >= new TextEncoder().encode(await createBackup(state)).byteLength);
  assert.equal(report.backupLimit, MAX_BACKUP_BYTES);
});

test('STORE-01：接近批次上限時依比例升級警示，且不修改原狀態', async () => {
  const state = createEmptyState(await createDemoDataset());
  state.batches = Array.from({ length: Math.ceil(MAX_BATCH_RECORDS * 0.8) }, (_, index) => batch(index));
  const before = JSON.stringify(state);
  assert.equal(measureCapacity(state).level, 'warn');
  assert.match(describeCapacity(measureCapacity(state)), /八成/);
  assert.equal(JSON.stringify(state), before, '量測只讀，不封存或刪除歷史');
  state.batches = Array.from({ length: Math.ceil(MAX_BATCH_RECORDS * 0.95) }, (_, index) => batch(index));
  assert.equal(measureCapacity(state).level, 'critical');
  assert.match(describeCapacity(measureCapacity(state)), /上限/);
});

import { MAX_BACKUP_BYTES, type AppState } from '../domain/model.ts';

// 與 validateAppState 的批次上限一致；超過後無法保存新批次。
export const MAX_BATCH_RECORDS = 1000;
export const CAPACITY_WARN_RATIO = 0.8;
export const CAPACITY_CRITICAL_RATIO = 0.95;
// 備份外層欄位（格式、時間、校驗值）的保守估計。
const ENVELOPE_BYTES = 256;

export interface CapacityReport {
  batches: number;
  batchLimit: number;
  backupBytes: number;
  backupLimit: number;
  /** 兩項中較高的使用比例 */
  ratio: number;
  level: 'ok' | 'warn' | 'critical';
}

/** 估計目前工作區距離批次與備份上限多遠；只讀，不修改或封存任何歷史。 */
export function measureCapacity(state: AppState): CapacityReport {
  const backupBytes = new TextEncoder().encode(JSON.stringify(state)).byteLength + ENVELOPE_BYTES;
  const ratio = Math.max(state.batches.length / MAX_BATCH_RECORDS, backupBytes / MAX_BACKUP_BYTES);
  const level = ratio >= CAPACITY_CRITICAL_RATIO ? 'critical' : ratio >= CAPACITY_WARN_RATIO ? 'warn' : 'ok';
  return { batches: state.batches.length, batchLimit: MAX_BATCH_RECORDS, backupBytes, backupLimit: MAX_BACKUP_BYTES, ratio, level };
}

export function describeCapacity(report: CapacityReport): string {
  const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(2);
  const usage = `批次紀錄 ${report.batches}／${report.batchLimit} 筆，備份約 ${mb(report.backupBytes)}／${mb(report.backupLimit)} MB`;
  if (report.level === 'critical') return `${usage}。即將達到保存上限，超過後新批次會被拒絕；請先下載備份，並避免重複匯入相同內容。`;
  if (report.level === 'warn') return `${usage}。已超過八成，建議先下載備份並減少重複匯入。`;
  return `${usage}。`;
}

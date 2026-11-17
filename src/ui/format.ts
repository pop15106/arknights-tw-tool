import { FieldError } from '../domain/model';
import type { Evidence, FieldConflict, OperatorDefinition } from '../domain/model';

export function formatDate(value?: string): string {
  if (!value) return '尚無紀錄';
  return new Intl.DateTimeFormat('zh-TW', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Taipei' }).format(new Date(value));
}

/** 台北時區的 YYYY-MM-DD，用於檔名。 */
export function taipeiDate(value: string | Date = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(typeof value === 'string' ? new Date(value) : value);
}

export function valueText(evidence?: Evidence, field?: string, definition?: OperatorDefinition): string {
  if (!evidence || evidence.status === 'unknown') return '未知';
  if (evidence.status === 'not-applicable') return '不適用';
  if (typeof evidence.value === 'boolean') return evidence.value ? '是' : '否';
  if (evidence.value === 'none') return field === 'equippedSkill' ? '未選用' : '未裝備';
  if (field === 'equippedSkill') return definition?.skills.find(s => s.id === evidence.value)?.name ?? String(evidence.value);
  if (field === 'equippedModule') return definition?.modules.find(m => m.id === evidence.value)?.name ?? String(evidence.value);
  return String(evidence.value);
}

export function fieldLabel(field: string, definition?: OperatorDefinition): string {
  const basic: Record<string, string> = { owned: '已持有', elite: '精英階段', level: '等級', potential: '潛能', trust: '信賴', skillLevel: '技能等級', equippedSkill: '選用技能', equippedModule: '裝備模組' };
  if (basic[field]) return basic[field];
  const [type, id] = field.split(':');
  if (type === 'mastery') return `${definition?.skills.find(s => s.id === id)?.name ?? id}・專精`;
  const moduleName = definition?.modules.find(m => m.id === id)?.name ?? id;
  return `${moduleName}・${type === 'moduleAvailable' ? '本服開放' : type === 'moduleUnlocked' ? '已解鎖' : '等級'}`;
}

export function isNewSourceConflict(conflict: FieldConflict): boolean {
  return conflict.current.status === 'unknown' && !conflict.current.manuallyConfirmed &&
    conflict.incoming.status === 'known' && !conflict.incoming.manuallyConfirmed &&
    conflict.incoming.confidence !== undefined && conflict.incoming.confidence < 0.8 &&
    conflict.reasons.length === 1 && conflict.reasons[0] === '來源信心較低，須人工確認';
}

export function friendlyError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') return '本機儲存空間不足，本次變更沒有保存。請先下載備份，再釋出空間後重試。';
  if (error instanceof Error && /revision|另一|修訂|並行|過期|stale|concurrent/i.test(error.message)) return `${error.message} 請重新整理以讀取最新資料，再重新預覽。`;
  // 只顯示本工具自行拋出的訊息；瀏覽器內建錯誤（TypeError、DOMException 等）多為英文且不易理解。
  return error instanceof Error && (error.constructor === Error || error instanceof FieldError) ? error.message : '操作未完成，原資料未修改。請重試或先下載備份。';
}

export const mb = (bytes: number, digits = 2) => (bytes / 1024 / 1024).toFixed(digits);

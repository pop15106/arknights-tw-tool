import { useState } from 'preact/hooks';
import type { Evidence, OperatorDefinition } from '../domain/model';
import { isOriginalModule } from '../domain/module-consistency';
import { fieldLabel, formatDate, valueText } from './format';

const RANGES: Record<string, [number, number]> = { elite: [0, 2], level: [1, 90], potential: [1, 6], trust: [0, 200], skillLevel: [1, 7] };

export function FieldEditor({ field, evidence, definition, busy, onPreview }: { field: string; evidence: Evidence; definition: OperatorDefinition; busy: boolean; onPreview: (field: string, evidence: Evidence) => void }) {
  const [status, setStatus] = useState<Evidence['status']>(evidence.status);
  const [value, setValue] = useState(evidence.status === 'known' ? String(evidence.value) : '');
  const label = fieldLabel(field, definition);
  const isBoolean = field === 'owned' || field.startsWith('moduleUnlocked:') || field.startsWith('moduleAvailable:');
  const items = field === 'equippedSkill' ? definition.skills : field === 'equippedModule' ? definition.modules : null;
  const moduleMessage = field !== 'equippedModule' ? null : !definition.modules.length ? '沒有模組資料。' : definition.modules.every(isOriginalModule) ? '只有原始證章，沒有可升級模組資料。' : null;
  const range = RANGES[field] ?? [0, 3];
  return <div className="evidence-field">
    <div className="evidence-heading"><strong>{label}</strong><span className={`tag ${evidence.status === 'unknown' ? 'amber' : 'muted'}`}>{valueText(evidence, field, definition)}</span></div>
    {moduleMessage && <p className="fine-print">{moduleMessage}</p>}
    <details className="evidence-meta"><summary>來源：{evidence.source}{evidence.manuallyConfirmed ? ' · 已人工確認' : ''}</summary>
      資料時間：{formatDate(evidence.observedAt)} ／ 匯入：{formatDate(evidence.importedAt)}<br/>
      {evidence.manuallyConfirmed ? '已人工確認' : '未經人工確認'}{evidence.confidence !== undefined && ` ／ 來源信心分數 ${evidence.confidence}（非正確機率）`}<br/>
      {evidence.locator ? <>素材位置：{evidence.locator.assetId}{evidence.locator.frameMs !== undefined && `，${evidence.locator.frameMs} 毫秒`} ／ 本原型未提供原檔檢視</> : '沒有原圖或影片證據；本次不保存媒體原檔。'}
    </details>
    <form className="evidence-edit" onSubmit={event => {
      event.preventDefault();
      const now = new Date().toISOString();
      const meta = { source: '使用者在本機手動更正', importedAt: now, observedAt: now, manuallyConfirmed: true };
      onPreview(field, status === 'known' ? { ...meta, status, value: isBoolean ? value === 'true' : items ? value : Number(value) } : { ...meta, status });
    }}>
      <select aria-label={`${label}狀態`} className="filter" value={status} disabled={busy} onChange={event => setStatus(event.currentTarget.value as Evidence['status'])}>
        <option value="known">已知</option><option value="unknown">未知</option><option value="not-applicable">不適用</option>
      </select>
      {status === 'known' && (isBoolean
        ? <select className="filter" required aria-label={`${label}新值`} value={value} disabled={busy} onChange={event => setValue(event.currentTarget.value)}><option value="">選擇狀態</option><option value="true">是</option><option value="false">否</option></select>
        : items
          ? <select className="filter" required aria-label={`${label}新值`} value={value} disabled={busy} onChange={event => setValue(event.currentTarget.value)}><option value="">選擇項目</option><option value="none">{field === 'equippedSkill' ? '未選用' : '未裝備'}</option>{items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
          : <input className="text-input" type="number" required min={range[0]} max={range[1]} step="1" inputMode="numeric" aria-label={`${label}新值`} value={value} disabled={busy} onInput={event => setValue(event.currentTarget.value)}/>)}
      <button className="button secondary small" type="submit" aria-label={`預覽修正${label}`} disabled={busy}>預覽修正</button>
    </form>
  </div>;
}

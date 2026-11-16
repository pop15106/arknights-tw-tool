import { useState } from 'preact/hooks';
import type { BaseCatalog } from '../catalog/base';
import type { AppState, Settings } from '../domain/model';
import { FACILITY_LABEL, type ObjectiveWeights } from '../domain/base';
import { exportMaaSchedule, planRotation, type RotationResult } from '../domain/rotation';

type Base = Settings['base'];
const fmt = (value: number, digits = 0) => value.toLocaleString('zh-TW', { maximumFractionDigits: digits });

/** 多班輪替：產生 2～4 班互相錯開休息的配置，並匯出 MAA 自定義基建換班檔。 */
export function BaseRotation({ state, catalog, base, weights, busy, onApply }: { state: AppState; catalog: BaseCatalog; base: Base; weights: ObjectiveWeights; busy: boolean; onApply: (assignments: Record<string, string[]>, products: Record<string, 'gold' | 'record'>) => void }) {
  const [shifts, setShifts] = useState(3);
  const [firstStart, setFirstStart] = useState('08:00');
  const [drones, setDrones] = useState('trading:1');
  const [result, setResult] = useState<RotationResult | null>(null);
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
  const working = base.facilities.filter(facility => facility.type !== 'dormitory');
  const run = async () => {
    setResult(null); setProgress([0, shifts * 2]);
    try { setResult(await planRotation(base, catalog, state.roster, definitions, { shifts, timeBudgetMs: 1500, weights, onProgress: (done, total) => setProgress([done, total]) })); }
    finally { setProgress(null); }
  };
  const download = () => {
    if (!result) return;
    const [room, index] = drones.split(':');
    const json = exportMaaSchedule(base, result, definitions, { title: `幹員檔案室・一天 ${result.shifts.length} 班`, firstStart, ...(room !== 'none' ? { drones: { room: room as 'trading' | 'manufacture', index: Number(index) } } : {}) });
    const url = URL.createObjectURL(new Blob([JSON.stringify(json, null, 2)], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `maa-custom-infrast-${result.shifts.length}shifts.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const label = (id: string) => { const facility = base.facilities.find(item => item.id === id); const index = base.facilities.filter(item => item.type === facility?.type).findIndex(item => item.id === id); return facility ? `${FACILITY_LABEL[facility.type]} ${index + 1}` : id; };
  const tradings = base.facilities.filter(item => item.type === 'trading').length, manufactures = base.facilities.filter(item => item.type === 'manufacturing').length;
  return <section className="layout-compare rotation" aria-label="多班輪替">
    <header><h3>多班輪替＋匯出 MAA</h3><p className="fine-print">一天分成數班，每班依當下心情排除撐不完的人再最佳化；休息中的人心情最低者優先進宿舍（以宿舍基礎＋氛圍恢復，不含宿舍技能，偏保守）。產品在各班固定。</p></header>
    <div className="inline-actions">
      <label><span>一天幾班</span><select className="filter" value={shifts} disabled={busy || !!progress} onChange={event => setShifts(Number(event.currentTarget.value))}>{[2, 3, 4].map(count => <option key={count} value={count}>{count} 班（每班 {24 / count} 小時）</option>)}</select></label>
      <label><span>第一班開始</span><input className="text-input" type="time" value={firstStart} onInput={event => setFirstStart(event.currentTarget.value || '08:00')}/></label>
      <label><span>無人機</span><select className="filter" value={drones} onChange={event => setDrones(event.currentTarget.value)}><option value="none">不使用</option>{Array.from({ length: tradings }, (_, index) => <option key={`t${index}`} value={`trading:${index + 1}`}>貿易站 {index + 1}</option>)}{Array.from({ length: manufactures }, (_, index) => <option key={`m${index}`} value={`manufacture:${index + 1}`}>製造站 {index + 1}</option>)}</select></label>
      <button type="button" className="button primary" disabled={busy || !!progress || !working.length} onClick={() => void run()}>{progress ? `計算中 ${progress[0]}／${progress[1]}` : result ? '重新產生' : '產生輪替'}</button>
      {result && <button type="button" className="button secondary" onClick={download}>下載 MAA 排班檔</button>}
    </div>
    {result && <>
      {result.warnings.map(text => <p key={text} className="callout warning">{text}</p>)}
      <div className="table-scroll"><table className="stats-table rotation-table"><thead><tr><th>設施</th>{result.shifts.map(shift => <th key={shift.index}>第 {shift.index + 1} 班</th>)}</tr></thead><tbody>
        {working.map(facility => <tr key={facility.id}><td>{label(facility.id)}</td>{result.shifts.map(shift => <td key={shift.index}>{(shift.assignments[facility.id] ?? []).map(id => definitions.get(id)?.displayName ?? id).join('、') || '—'}</td>)}</tr>)}
        <tr className="rotation-summary"><td>整體效益</td>{result.shifts.map(shift => <td key={shift.index}>{fmt(shift.objective.total, 1)}</td>)}</tr>
        <tr className="rotation-summary"><td>休息中（宿舍 {result.dormCapacity} 位）</td>{result.shifts.map(shift => <td key={shift.index}>{shift.resting} 人</td>)}</tr>
        <tr><td></td>{result.shifts.map(shift => <td key={shift.index}><button type="button" className="button ghost small" disabled={busy} onClick={() => onApply(shift.assignments, shift.products)}>套用這班</button></td>)}</tr>
      </tbody></table></div>
      <p className="fine-print">平均整體效益 {fmt(result.shifts.reduce((sum, shift) => sum + shift.objective.total, 0) / result.shifts.length, 1)}；宿舍恢復以 {result.dormRate}／時計算。下載的檔案放到 MAA 的 resource/custom_infrast/ 資料夾，在「基建換班」選擇自定義排班即可；宿舍交給 MAA 預設演算法安排休息者，訓練室不在 MAA 換班範圍內。</p>
    </>}
  </section>;
}


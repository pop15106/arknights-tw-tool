import { useState } from 'preact/hooks';

interface Series { operatorId: string; name: string; label: string; values: number[] }
const SLOTS = 6;

/** 班次心情曲線：只畫班末心情最低的 6 名（其餘不畫，表格可看全部）；固定色序、圖例＋線尾標籤、滑鼠十字線。 */
export function MoodChart({ series, step, max }: { series: Series[]; step: number; max: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const shown = [...series].sort((a, b) => (a.values.at(-1) ?? 0) - (b.values.at(-1) ?? 0)).slice(0, SLOTS);
  if (!shown.length) return null;
  const points = shown[0].values.length;
  const W = 640, H = 240, L = 36, R = 120, T = 12, B = 28;
  const x = (index: number) => L + (index / Math.max(1, points - 1)) * (W - L - R);
  const y = (value: number) => T + (1 - value / max) * (H - T - B);
  const ticks = [0, 6, 12, 18, 24].filter(value => value <= max);
  const hours = (index: number) => Math.round(index * step * 10) / 10;
  // 線尾標籤避免重疊：依 y 排序後至少相隔 13px。
  const ends = shown.map((item, slot) => ({ slot, y: y(item.values.at(-1) ?? 0) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
  const endY = new Map(ends.map(item => [item.slot, item.y]));
  const onMove = (event: MouseEvent) => {
    const box = (event.currentTarget as SVGElement).getBoundingClientRect();
    const px = (event.clientX - box.left) / box.width * W;
    setHover(Math.max(0, Math.min(points - 1, Math.round((px - L) / (W - L - R) * (points - 1)))));
  };
  return <div className="mood-chart viz-root">
    <div className="mood-legend" aria-hidden="true">{shown.map((item, slot) => <span key={item.operatorId}><i className={`s${slot + 1}`}/>{item.name}<small>{item.label}</small></span>)}</div>
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`班次心情曲線，心情最低的 ${shown.length} 名`} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      {ticks.map(value => <g key={value}><line x1={L} x2={W - R} y1={y(value)} y2={y(value)} className="grid"/><text x={L - 6} y={y(value) + 4} className="axis" text-anchor="end">{value}</text></g>)}
      <line x1={L} x2={W - R} y1={y(12)} y2={y(12)} className="threshold"/>
      <text x={L + 6} y={y(12) + 14} className="axis">心情 12：條件技能分界</text>
      {Array.from({ length: Math.floor((points - 1) * step / 2) + 1 }, (_, index) => index * 2).map(hour => { const index = Math.round(hour / step); return index < points ? <text key={hour} x={x(index)} y={H - 8} className="axis" text-anchor="middle">{hour}h</text> : null; })}
      {shown.map((item, slot) => <g key={item.operatorId} className={`s${slot + 1}`}>
        <polyline points={item.values.map((value, index) => `${x(index)},${y(value)}`).join(' ')} className="line"/>
        <text x={W - R + 8} y={(endY.get(slot) ?? 0) + 4} className="end-label">{item.name} {item.values.at(-1)}</text>
      </g>)}
      {hover !== null && <g>
        <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} className="crosshair"/>
        {shown.map((item, slot) => <circle key={item.operatorId} cx={x(hover)} cy={y(item.values[hover])} r="4" className={`dot s${slot + 1}`}/>)}
      </g>}
    </svg>
    {hover !== null && <div className="mood-tooltip" role="status"><strong>第 {hours(hover)} 小時</strong>{shown.map((item, slot) => <span key={item.operatorId}><i className={`s${slot + 1}`}/>{item.name}：{item.values[hover]}</span>)}</div>}
    <button type="button" className="button ghost small" onClick={() => setTable(value => !value)}>{table ? '收起表格' : `看全部 ${series.length} 名的數字`}</button>
    {table && <div className="table-scroll"><table className="stats-table"><thead><tr><th>幹員</th><th>設施</th><th>開班</th><th>班中</th><th>班末</th></tr></thead><tbody>
      {[...series].sort((a, b) => (a.values.at(-1) ?? 0) - (b.values.at(-1) ?? 0)).map(item => <tr key={item.operatorId}><td>{item.name}</td><td>{item.label}</td><td>{item.values[0]}</td><td>{item.values[Math.floor(item.values.length / 2)]}</td><td>{item.values.at(-1)}</td></tr>)}
    </tbody></table></div>}
  </div>;
}

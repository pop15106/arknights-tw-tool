import { useState } from 'preact/hooks';
import type { AppState, Settings } from '../domain/model';
import type { BaseCatalog, BaseRoomType } from '../catalog/base';
import { ROOM_OF, trainingAdvice } from '../domain/base';

const ELITE = ['精英 0', '精英 1', '精英 2'];

/** 練卡建議：01 練度掃描 → 02 設施領域分析 → 03 優先級佇列。 */
export function BaseTraining({ state, catalog, base }: { state: AppState; catalog: BaseCatalog; base: Settings['base'] }) {
  const [ownedOnly, setOwnedOnly] = useState(true);
  const [layoutOnly, setLayoutOnly] = useState(true);
  const [room, setRoom] = useState<'all' | BaseRoomType>('all');
  const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
  const layoutRooms = new Set(base.facilities.map(facility => ROOM_OF[facility.type]));
  const rooms = room !== 'all' ? new Set([room]) : layoutOnly && layoutRooms.size ? layoutRooms : undefined;
  const { entries, domains } = trainingAdvice(catalog, state.roster, definitions, { ownedOnly, rooms });
  const eliteCount = [0, 1, 2].map(value => state.roster.filter(row => row.fields.elite?.status === 'known' && row.fields.elite.value === value).length);
  const unknownElite = state.roster.length - eliteCount.reduce((a, b) => a + b, 0);
  const ranked = entries.filter(entry => entry.gain !== undefined && entry.gain > 0);
  const manual = entries.filter(entry => entry.gain === undefined);
  return <div className="training-view">
    <section className="panel training-step">
      <header><span className="step-badge">01</span><h3>幹員練度掃描</h3></header>
      <div className="recommend-facts">
        <div><span>持有幹員</span><strong>{state.roster.length}</strong><small>依目前幹員庫</small></div>
        <div><span>精英 2</span><strong>{eliteCount[2]}</strong><small>精英 1：{eliteCount[1]}</small></div>
        <div><span>精英 0</span><strong>{eliteCount[0]}</strong><small>{unknownElite ? `精英未知 ${unknownElite} 名` : '全部已知'}</small></div>
        <div><span>可解鎖的基建技能</span><strong>{entries.length}</strong><small>練到下一階段即可取得</small></div>
      </div>
      {unknownElite > 0 && <p className="fine-print">精英階段或等級未知的幹員不會出現在建議裡；請先到批次修正補齊。</p>}
    </section>
    <section className="panel training-step">
      <header><span className="step-badge">02</span><h3>設施領域分析</h3></header>
      <p className="fine-print">「目前最佳」是你已解鎖的單一技能可計算數值；「練滿可達」是你持有的幹員把該技能練到最高版本時的數值。差距越大，越值得投資這類設施。</p>
      <div className="domain-list">{domains.map(domain => {
        const gap = Math.round((domain.potentialBest - domain.currentBest) * 100) / 100;
        const width = domain.potentialBest > 0 ? Math.min(100, Math.round(domain.currentBest / domain.potentialBest * 100)) : 0;
        return <div key={domain.room} className={`domain-row ${gap > 0 ? 'has-gap' : ''}`}>
          <strong>{domain.label}</strong>
          <span className="domain-bar" aria-hidden="true"><i style={{ width: `${width}%` }}/></span>
          <span className="domain-values">目前 {domain.currentBest > 0 ? `+${domain.currentBest}` : '—'} · 練滿 {domain.potentialBest > 0 ? `+${domain.potentialBest}` : '不可計算'}</span>
          <span className={`tag ${gap > 0 ? 'amber' : 'muted'}`}>{domain.potentialBest === 0 ? '技能不計分' : gap > 0 ? `差距 +${gap}` : '已達上限'}</span>
        </div>;
      })}</div>
    </section>
    <section className="panel training-step">
      <header><span className="step-badge">03</span><h3>優先級佇列</h3><span className="count">{ranked.length}</span></header>
      <div className="training-filters">
        <label className="checkbox-line"><input type="checkbox" checked={ownedOnly} onChange={event => setOwnedOnly(event.currentTarget.checked)}/><span>只看已持有</span></label>
        <label className="checkbox-line"><input type="checkbox" checked={layoutOnly} disabled={room !== 'all'} onChange={event => setLayoutOnly(event.currentTarget.checked)}/><span>只看目前布局的設施</span></label>
        <select className="filter" aria-label="設施篩選" value={room} onChange={event => setRoom(event.currentTarget.value as typeof room)}><option value="all">全部設施</option>{domains.map(domain => <option key={domain.room} value={domain.room}>{domain.label}</option>)}</select>
      </div>
      <p className="fine-print">排序：可計算增益由高到低；同分時已持有優先，再看需要跨的精英階段數（少的較省材料）。條件型技能不排名，列在最後。</p>
      <ol className="training-queue">{ranked.slice(0, 60).map((entry, index) => <li key={`${entry.operatorId}-${entry.to.id}`}>
        <span className="queue-rank">{index + 1}</span>
        <div className="queue-main">
          <strong>{entry.name}</strong>{!entry.owned && <span className="tag muted">未持有</span>}<span className="tag">{entry.roomLabel}</span>
          <p>{entry.from ? `${entry.from.name} → ` : '解鎖 '}<b>{entry.to.name}</b></p>
          <small>{entry.to.description}</small>
        </div>
        <div className="queue-side">
          <span className="score">+{entry.gain}</span>
          <small>需 {ELITE[entry.requirement.elite]}・等級 {entry.requirement.level}</small>
          {entry.current && <small>目前 {entry.current.elite !== undefined ? ELITE[entry.current.elite] : '精英未知'}・等級 {entry.current.level ?? '未知'}</small>}
        </div>
      </li>)}</ol>
      {!ranked.length && <p className="empty-inline">沒有可計算增益的建議。可以取消篩選，或確認幹員的精英與等級已填寫。</p>}
      {manual.length > 0 && <details className="plain-details"><summary>條件型技能，需自行判斷（{manual.length}）</summary><ul className="training-manual">{manual.slice(0, 80).map(entry => <li key={`${entry.operatorId}-${entry.to.id}`}><strong>{entry.name}</strong>・{entry.roomLabel}・需 {ELITE[entry.requirement.elite]} 等級 {entry.requirement.level}：<b>{entry.to.name}</b><br/><small>{entry.to.description}</small></li>)}</ul></details>}
    </section>
  </div>;
}

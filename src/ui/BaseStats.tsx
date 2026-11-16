import type { BaseCatalog } from '../catalog/base';
import { baseStatistics, type BaseEvaluation } from '../domain/base';
import { DEFAULT_TRADING } from '../catalog/trading';

const fmt = (value: number, digits = 1) => value.toLocaleString('zh-TW', { maximumFractionDigits: digits });

/** 基建統計：赤金、經驗、龍門幣（資料不足時明示）與換班建議。 */
export function BaseStats({ evaluation, catalog }: { evaluation: BaseEvaluation; catalog: BaseCatalog }) {
  const stats = baseStatistics(evaluation, catalog);
  if (!stats.available) return <section className="panel"><h2>基建統計</h2><p className="fine-print">目前的遊戲資料沒有配方與心情欄位，請到設定按「更新遊戲資料」後再查看。</p></section>;
  const trading = catalog.trading ?? DEFAULT_TRADING;
  const date = (value: string) => new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeZone: 'Asia/Taipei' }).format(new Date(value));
  const incomplete = evaluation.facilities.some(result => result.unsupported.length + result.uncertain.length > 0);
  return <section className="panel stats-panel" aria-label="基建統計">
    <header className="recommend-head"><div><p className="eyebrow">基建統計</p><h2>每日產量與換班建議</h2></div>{incomplete && <span className="tag amber">部分技能未計入，數字偏保守</span>}</header>
    <div className="stats-cards">
      <div className="stats-card gold"><span>赤金</span><strong>{fmt(stats.goldPerDay)}</strong><small>條／日</small></div>
      <div className="stats-card exp"><span>作戰記錄經驗</span><strong>{fmt(stats.expPerDay, 0)}</strong><small>經驗／日</small></div>
      <div className="stats-card lmd"><span>龍門幣</span><strong>{stats.trading.length ? fmt(stats.lmdPerDay, 0) : '—'}</strong><small>{stats.trading.length ? `龍門幣／日・PRTS ${catalog.trading ? `${date(trading.source.fetchedAt)} 同步` : '內建值'}` : '貿易站尚未排人'}</small></div>
      <div className="stats-card shift"><span>建議換班</span><strong>{stats.suggestion ? `${stats.suggestion.hours} 小時` : '—'}</strong><small>{stats.suggestion?.text ?? '尚未排人'}</small></div>
    </div>
    {(stats.goldPerDay > 0 || stats.goldConsumedPerDay > 0) && <div className={`gold-balance ${stats.goldPerDay >= stats.goldConsumedPerDay ? 'ok' : 'short'}`}>
      <strong>赤金收支</strong>
      <span>製造 {fmt(stats.goldPerDay)} 條／日 − 貿易站消耗 {fmt(stats.goldConsumedPerDay)} 條／日 ＝ <b>{stats.goldPerDay >= stats.goldConsumedPerDay ? '+' : ''}{fmt(stats.goldPerDay - stats.goldConsumedPerDay)} 條／日</b></span>
      <small>{stats.goldPerDay >= stats.goldConsumedPerDay ? '赤金足夠，貿易站不會因缺赤金而停單。' : '赤金不夠用：貿易站會因缺赤金而無法交付訂單，可考慮增加赤金製造站或提高其生產力。'}</small>
    </div>}
    {stats.storageWarnings.map(text => <p key={text} className="callout warning">{text}</p>)}
    <div className="stats-tables">
      <div>
        <h3>製造站產量</h3>
        {stats.manufacture.length ? <table className="stats-table"><thead><tr><th>設施</th><th>產品</th><th>生產力</th><th>每日</th><th>倉庫滿</th></tr></thead><tbody>
          {stats.manufacture.map(item => <tr key={item.facilityId}><td>{item.label}</td><td>{item.itemName}</td><td>+{fmt(item.productivity)}%</td><td>{item.product === 'gold' ? `${fmt(item.perDay)} 條` : `${fmt(item.perDay)} 件（${fmt(item.expPerDay, 0)} 經驗）`}</td><td>{fmt(item.hoursToFull)} 小時（{item.storageItems} 件）</td></tr>)}
        </tbody></table> : <p className="fine-print">製造站還沒有排人或沒有選產品。</p>}
      </div>
      {stats.trading.length > 0 && <div>
        <h3>貿易站收益</h3>
        <table className="stats-table"><thead><tr><th>設施</th><th>訂單效率</th><th>每日訂單</th><th>龍門幣</th><th>耗赤金</th><th>訂單滿</th></tr></thead><tbody>
          {stats.trading.map(item => <tr key={item.facilityId}><td>{item.label}</td><td>+{fmt(item.efficiency)}%</td><td>{fmt(item.ordersPerDay)} 筆</td><td>{fmt(item.lmdPerDay, 0)}</td><td>{fmt(item.goldPerDay)} 條</td><td>{fmt(item.hoursToFull)} 小時</td></tr>)}
        </tbody></table>
        {stats.trading.filter(item => item.notes.length).map(item => <p key={item.facilityId} className="fine-print">{item.label}：{item.notes.join('；')}。</p>)}
      </div>}
      <div>
        <h3>各設施可工作時長</h3>
        {stats.shifts.length ? <table className="stats-table"><thead><tr><th>設施</th><th>最先累的人</th><th>心情消耗</th><th>可工作</th></tr></thead><tbody>
          {stats.shifts.map(item => <tr key={item.facilityId}><td>{item.label}</td><td>{item.operator}</td><td>{fmt(item.rate, 2)}／時</td><td>{fmt(item.hours)} 小時</td></tr>)}
        </tbody></table> : <p className="fine-print">還沒有會消耗心情的設施排人。</p>}
      </div>
    </div>
    <details className="plain-details"><summary>計算方式與限制</summary><ul className="gap-list">
      <li>每日產量＝86,400 秒 ×（1＋已計入生產力）÷ 配方秒數。赤金每條 {fmt((catalog.formulas?.gold.seconds ?? 0) / 60, 0)} 分鐘；作戰記錄依製造站等級取可生產的最高級記錄，時間與經驗值取自資料表。</li>
      <li>生產力只含資料表的基礎加成與句型可解析的技能；控制中樞、聯動與條件型技能不計入，所以實際產量通常更高。</li>
      <li>龍門幣＝86,400 ×（1＋訂單效率）× 一筆訂單的期望龍門幣 ÷ 期望訂單時間。赤金訂單為 {trading.orders.map(order => `${order.gold} 條→${order.lmd.toLocaleString()} 龍門幣（${Math.floor(order.seconds / 3600)}:${String(order.seconds % 3600 / 60).padStart(2, '0')}）`).join('、')}，各等級出現機率依來源表格加權。</li>
      <li>訂單數據出處：<a href={trading.source.url} target="_blank" rel="noopener noreferrer">{trading.source.name}</a>{trading.source.revision ? `（頁面版本 ${trading.source.revision}` : '（'}{trading.source.editedAt ? `，${date(trading.source.editedAt)} 編輯` : ''}；{catalog.trading ? `${date(trading.source.fetchedAt)} 同步` : '尚未同步，使用內建值'}）。{trading.source.note}。遊戲資料表沒有這些數值，每次「更新遊戲資料」會一併向 PRTS 同步。</li>
      <li>訂單品質（α／β）、特別獨佔訂單、可露希爾特別訂單、赤金交付數固定、違約與投資訂單依 PRTS 同步的數據計算；品質技能使用累積工作達峰值後的分布，多人疊加只有 PRTS 有觀測值的組合，其餘標示為估計。</li>
      <li>工作時長＝心情上限（{catalog.mood?.max}）÷（設施基礎消耗＋技能寫明的自身心情消耗調整）。設施人數、控制中樞、宿舍恢復與條件型心情技能沒有計入。</li>
      <li>換班間隔取「最先累的人」可工作時長以內、能整除 24 小時的班數，方便每天固定時間換班。宿舍恢復所需時間尚無可查證公式，請確認休息的人能在下一班前回滿。</li>
    </ul></details>
  </section>;
}

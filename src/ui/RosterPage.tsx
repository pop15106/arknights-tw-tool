import { useRef, useState } from 'preact/hooks';
import type { AppState, OperatorDefinition, OwnedOperator } from '../domain/model';
import { missingCount, queryRoster, unverifiedCount, type RosterQuery } from '../domain/roster-query';
import { OperatorPortrait } from '../OperatorEncyclopedia';
import { Icon } from './Icon';
import { valueText } from './format';

const PAGE_SIZE = 48;
type Filters = Required<Pick<RosterQuery, 'rarity' | 'elite' | 'status' | 'sort'>> & { search: string; profession: string };
const DEFAULT_FILTERS: Filters = { search: '', profession: 'all', rarity: 'all', elite: 'all', status: 'all', sort: 'id' };

const eliteValue = (row: OwnedOperator) => { const entry = row.fields.elite; return entry?.status === 'known' && typeof entry.value === 'number' ? entry.value : undefined; };
function stat(row: OwnedOperator, field: string): { text: string; unknown: boolean } {
  const evidence = row.fields[field];
  const unknown = !evidence || evidence.status === 'unknown';
  return { text: valueText(evidence), unknown };
}

function OperatorCard({ row, definition, isDemo, skin, onOpen }: { row: OwnedOperator; definition: OperatorDefinition; isDemo: boolean; skin?: string; onOpen: () => void }) {
  const missing = missingCount(row, definition), unverified = unverifiedCount(row, definition);
  const elite = stat(row, 'elite'), level = stat(row, 'level'), skill = stat(row, 'skillLevel');
  return <article className={`operator-card rarity-${definition.rarity}`} data-testid="operator-card">
    <button type="button" className="operator-card-hit" aria-label={`檢視與修正 ${definition.displayName}（${definition.profession}）`} onClick={onOpen}/>
    <div className="operator-art">
      <OperatorPortrait definition={definition} elite={eliteValue(row)} skin={skin}/>
      <span className="operator-stars" role="img" aria-label={`${definition.rarity} 星`}>{'★'.repeat(definition.rarity)}</span>
      <span className="operator-profession">{definition.profession}</span>
    </div>
    <div className="operator-content">
      <h3 className="operator-name">{definition.displayName}</h3>
      <p className="operator-sub">{isDemo ? '虛構示範幹員' : definition.branch}</p>
      <dl className="operator-stats">
        <div><dt>精英</dt><dd className={elite.unknown ? 'unknown' : ''}>{elite.unknown ? '?' : `E${elite.text}`}</dd></div>
        <div><dt>等級</dt><dd className={level.unknown ? 'unknown' : ''}>{level.unknown ? '?' : level.text}</dd></div>
        <div><dt>技能</dt><dd className={skill.unknown ? 'unknown' : ''}>{skill.unknown ? '?' : skill.text}</dd></div>
      </dl>
      <div className="operator-flags">
        {missing > 0 ? <span className="dot-label amber">{missing} 欄未知</span> : <span className="dot-label ok">欄位已明示</span>}
        {unverified > 0 && <span className="dot-label info" title="這些匯入值的來源信心較低且尚未人工確認，不表示已發現錯誤。">{unverified} 欄待核對</span>}
      </div>
    </div>
  </article>;
}

export function RosterPage({ state, isDemo, busy, onOpen, onImport, onPreviewDemo }: { state: AppState; isDemo: boolean; busy: boolean; onOpen: (operatorId: string) => void; onImport: () => void; onPreviewDemo: () => void }) {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [page, setPage] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const update = (patch: Partial<Filters>) => { setFilters(current => ({ ...current, ...patch })); setPage(0); };
  const definitions = new Map(state.dataset.operators.map(definition => [definition.id, definition]));
  const operators = state.roster.map(row => ({ row, definition: definitions.get(row.operatorId)! }));
  const filtered = queryRoster(operators, filters);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pageCount - 1);
  const visible = filtered.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  const needReview = operators.filter(({ row, definition }) => missingCount(row, definition) > 0 || unverifiedCount(row, definition) > 0).length;
  const imports = state.batches.filter(batch => batch.kind === 'import').length;
  const filtersActive = filters.search || filters.profession !== 'all' || filters.rarity !== 'all' || filters.elite !== 'all' || filters.status !== 'all';
  const professions = [...new Set(state.dataset.operators.map(op => op.profession))];
  const go = (next: number) => { setPage(next); heading.current?.scrollIntoView({ block: 'start' }); };
  const pagination = (position: string) => <nav className="pagination" aria-label={`幹員分頁（${position}）`}>
    <span aria-live="polite">{filtered.length ? `${current * PAGE_SIZE + 1}–${Math.min((current + 1) * PAGE_SIZE, filtered.length)} / ${filtered.length} 名` : '0 名'} · 第 {current + 1} / {pageCount} 頁</span>
    <div className="inline-actions"><button type="button" className="button secondary small" disabled={current === 0} onClick={() => go(current - 1)}>上一頁</button><button type="button" className="button secondary small" disabled={current >= pageCount - 1} onClick={() => go(current + 1)}>下一頁</button></div>
  </nav>;

  if (!state.roster.length) return <section className="empty-state">
    <div className="empty-icon"><Icon name="roster" size={28}/></div>
    <h2>從一份可核對的資料開始</h2>
    <p>{isDemo ? '先預覽 8 名虛構幹員，體驗合併、未知欄位、手動修正及備份；確認前不會寫入。' : '可匯入 SKPORT 研究 JSON 或本工具候選資料，先補齊中文定義，再預覽養成欄位。確認前不會寫入。'}</p>
    <div className="inline-actions center">
      {isDemo && <button type="button" className="button primary" disabled={busy} onClick={onPreviewDemo}>預覽示範批次<Icon name="arrow" size={16}/></button>}
      <button type="button" className="button secondary" disabled={busy} onClick={onImport}><Icon name="upload" size={16}/>選擇 JSON 檔案</button>
    </div>
  </section>;

  return <>
    <div className="stat-strip" role="list">
      <div className="stat" role="listitem"><span className="stat-value">{state.roster.length}</span><span className="stat-label">已建檔幹員<small>{isDemo ? '虛構資料' : '局部，不推定完整'}</small></span></div>
      <div className="stat amber" role="listitem"><span className="stat-value">{needReview}</span><span className="stat-label">有欄位待確認<small>未知保留，不以零代替</small></span></div>
      <div className="stat" role="listitem"><span className="stat-value">{imports}</span><span className="stat-label">本機匯入批次<small>修訂版本 {state.revision}</small></span></div>
    </div>
    <div className="section-heading"><h2 ref={heading} tabIndex={-1}>幹員檔案 <span className="count">{filtered.length} / {state.roster.length}</span></h2>{filtersActive && <button type="button" className="button ghost small" onClick={() => update(DEFAULT_FILTERS)}>清除篩選</button>}</div>
    <div className="toolbar">
      <label className="search-field"><Icon name="search" size={16}/><input type="search" aria-label="搜尋幹員" placeholder="搜尋名稱、別名或 ID" value={filters.search} onInput={event => update({ search: event.currentTarget.value })}/></label>
      <div className="filter-row">
        <select className="filter" aria-label="職業篩選" value={filters.profession} onChange={event => update({ profession: event.currentTarget.value })}><option value="all">全部職業</option>{professions.map(job => <option key={job} value={job}>{job}</option>)}</select>
        <select className="filter" aria-label="星級篩選" value={filters.rarity} onChange={event => update({ rarity: event.currentTarget.value === 'all' ? 'all' : Number(event.currentTarget.value) as Filters['rarity'] })}><option value="all">全部星級</option>{[6, 5, 4, 3, 2, 1].map(value => <option key={value} value={value}>{value} 星</option>)}</select>
        <select className="filter" aria-label="精英階段篩選" value={filters.elite} onChange={event => { const value = event.currentTarget.value; update({ elite: value === 'all' || value === 'unknown' ? value : Number(value) as Filters['elite'] }); }}><option value="all">全部精英</option><option value="2">精英 2</option><option value="1">精英 1</option><option value="0">精英 0</option><option value="unknown">精英未知</option></select>
        <select className="filter" aria-label="資料狀態篩選" value={filters.status} onChange={event => update({ status: event.currentTarget.value as Filters['status'] })}><option value="all">全部狀態</option><option value="unknown">有未知欄位</option><option value="unverified">來源值待核對</option></select>
        <select className="filter" aria-label="幹員排序" value={filters.sort} onChange={event => update({ sort: event.currentTarget.value as Filters['sort'] })}><option value="id">依 ID</option><option value="name">依名稱</option><option value="rarity">星級高→低</option><option value="level">養成高→低</option></select>
      </div>
    </div>
    {pageCount > 1 && pagination('上方')}
    {filtered.length ? <div className="roster-grid">{visible.map(({ row, definition }) => <OperatorCard key={row.operatorId} row={row} definition={definition} isDemo={isDemo} skin={state.settings.skins?.[row.operatorId]} onOpen={() => onOpen(row.operatorId)}/>)}</div>
      : <div className="empty-inline"><strong>沒有符合條件的幹員</strong><span>試著調整名稱、職業、星級、精英階段或資料狀態。</span></div>}
    {pageCount > 1 && pagination('下方')}
    <p className="page-caption">本機 IndexedDB 保存，請定期匯出備份 · 資料集 {state.dataset.metadata.version} · 格式 v{state.schemaVersion}</p>
  </>;
}

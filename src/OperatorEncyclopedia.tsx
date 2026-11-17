import { useEffect, useRef, useState } from 'preact/hooks';
import type { OperatorDefinition, OwnedOperator } from './domain/model';
import { isOriginalModule, moduleProblems } from './domain/module-consistency';
import { SKIN_ID, skinFileName, type OperatorSkin, type SkinCatalog } from './catalog/skins';

const PORTRAIT_PATH = /^\/assets\/operators\/[A-Za-z0-9_.-]+\.png$/u;
/**
 * 立繪優先順序：選擇的時裝 → 依精英階段（精英 2 用 {id}_2，其餘 {id}_1）→ 預設肖像；檔案不存在就往下一個。
 */
export function OperatorPortrait({ definition, large = false, elite, skin }: { definition: OperatorDefinition; large?: boolean; elite?: number; skin?: string }) {
  const base = definition.portrait;
  const sources = [
    ...(skin && SKIN_ID.test(skin) && skin.startsWith(`${definition.id}@`) ? [`/assets/operators/${skinFileName(skin)}`] : []),
    ...(base && PORTRAIT_PATH.test(base) && /^char_[A-Za-z0-9_.-]+$/u.test(definition.id) ? [...(elite === 2 ? [`/assets/operators/${definition.id}_2.png`] : []), `/assets/operators/${definition.id}_1.png`] : []),
    ...(typeof base === 'string' && PORTRAIT_PATH.test(base) ? [base] : []),
  ];
  const key = sources.join('|');
  const [state, setState] = useState<{ key: string; index: number }>({ key, index: 0 });
  const [retry, setRetry] = useState(0);
  const index = state.key === key ? state.index : 0;
  const source = sources[index];
  return <div className={`portrait ${large ? 'portrait-large' : ''}`}>
    {source ? <img key={source} src={retry ? `${source}?retry=${retry}` : source} alt={`${definition.displayName} 肖像`} loading="lazy" decoding="async" width="180" height="360" referrerPolicy="no-referrer" onError={() => setState({ key, index: index + 1 })}/>
      : <div className="portrait-placeholder"><span aria-hidden="true">{definition.profession.slice(0, 1)}</span><small>{base ? '圖片暫不可用' : '尚無肖像'}</small>{sources.length > 0 && <button type="button" className="portrait-retry" aria-label={`重新載入${definition.displayName}圖片`} onClick={() => { setRetry(value => value + 1); setState({ key, index: 0 }); }}>重試圖片</button>}</div>}
  </div>;
}

function knownNumber(row: OwnedOperator, field: string): number | undefined {
  const entry = row.fields[field]; return entry?.status === 'known' && typeof entry.value === 'number' ? entry.value : undefined;
}

function skillLabel(level: number): string { return level <= 7 ? `技能等級 ${level}` : `專精 ${level - 7}`; }

function useDescriptionLevel(scope: string, levels: number[], current?: number) {
  const context = `${scope}:${current ?? 'unknown'}:${levels.join(',')}`;
  const [choice, setChoice] = useState<{ context: string; level: number } | null>(null);
  const initial = current !== undefined && levels.includes(current) ? current : levels[0] ?? 1;
  const level = choice?.context === context && levels.includes(choice.level) ? choice.level : initial;
  return { level, select: (value: number) => setChoice({ context, level: value }) };
}

function SkillDescription({ skill, row }: { skill: OperatorDefinition['skills'][number]; row: OwnedOperator }) {
  const base = knownNumber(row, 'skillLevel'), mastery = knownNumber(row, `mastery:${skill.id}`);
  const current = base === 7 && mastery !== undefined ? base + mastery : base;
  const levels = (skill.levels ?? []).slice().sort((left, right) => left.level - right.level);
  const { level, select } = useDescriptionLevel(`${row.operatorId}:${skill.id}`, levels.map(item => item.level), current);
  const selected = levels.find(item => item.level === level);
  return <article className="encyclopedia-entry">
    <div className="split-heading"><h4>{skill.name}</h4><span className="tag muted">{current === undefined ? '養成等級未知' : `紀錄：${skillLabel(current)}${base === 7 && mastery === undefined ? '；專精未知' : ''}`}</span></div>
    {levels.length ? <>
      <label className="skill-level-picker"><span>查看說明等級</span><select className="filter" aria-label={`${skill.name}的說明等級`} value={level} onChange={event => select(Number(event.currentTarget.value))}>{levels.map(item => <option key={item.level} value={item.level}>{skillLabel(item.level)}</option>)}</select></label>
      <p className="game-description">{selected?.description ?? '此等級尚無說明。'}</p>
    </> : <p className="fine-print">資料包尚未提供此技能的中文等級說明。</p>}
  </article>;
}

type Talent = NonNullable<OperatorDefinition['talents']>[number];
function talentCondition(talent: Talent, row: OwnedOperator): 'ready' | 'blocked' | 'unknown' {
  const elite = knownNumber(row, 'elite'), level = knownNumber(row, 'level'), potential = knownNumber(row, 'potential');
  if ((elite !== undefined && elite < talent.elite) || (elite === talent.elite && level !== undefined && level < talent.level) || (potential !== undefined && potential < talent.potential)) return 'blocked';
  if (elite === undefined || potential === undefined || (elite === talent.elite && level === undefined)) return 'unknown';
  return 'ready';
}

type Module = OperatorDefinition['modules'][number];
function ModuleDescription({ module, row }: { module: Module; row: OwnedOperator }) {
  const original = isOriginalModule(module);
  const levels = original ? [] : (module.levels ?? []).slice().sort((left, right) => left.level - right.level);
  const current = knownNumber(row, `moduleLevel:${module.id}`);
  const unlockedField = row.fields[`moduleUnlocked:${module.id}`];
  const unlocked = unlockedField?.status === 'known' && typeof unlockedField.value === 'boolean' ? unlockedField.value : undefined;
  const equippedField = row.fields.equippedModule;
  const equipped = equippedField?.status === 'known' ? equippedField.value === module.id : undefined;
  const potential = knownNumber(row, 'potential');
  const { level, select } = useDescriptionLevel(`${row.operatorId}:${module.id}:${unlocked ?? 'unknown'}`, levels.map(item => item.level), current);
  const selected = levels.find(item => item.level === level);
  const problems = moduleProblems(module, row.fields);
  const effects = selected?.effects ?? [];
  return <article className="encyclopedia-entry module-entry" aria-label={`模組：${module.name}`}>
    <div className="split-heading"><h4>{module.name}</h4><span className="tag muted">{original ? '原始證章 · 無升級等級' : `${module.kind} 模組`}</span></div>
    {original ? <p className="fine-print module-record-note">此項為原始證章，不可升級。</p> : <>
      <dl className="module-record">
        <div><dt>個人解鎖紀錄</dt><dd>{unlocked === true ? '已解鎖' : unlocked === false ? '未解鎖' : '解鎖狀態未知'}</dd></div>
        <div><dt>個人等級紀錄</dt><dd>{current === undefined ? '等級未知' : current === 0 ? '0 級' : `${current} 級`}</dd></div>
        <div><dt>個人裝備紀錄</dt><dd>{equipped === undefined ? '裝備狀態未知' : equipped ? '已裝備此模組' : '未裝備此模組'}</dd></div>
        <div><dt>個人潛能紀錄</dt><dd>{potential === undefined ? '潛能未知，效果條件待核對' : `潛能 ${potential}`}</dd></div>
      </dl>
      {problems.length > 0 && <p className="warning-note">紀錄互相矛盾：{problems.join(' ')}請至批次修正核對。</p>}
      <p className="module-unlock">{module.unlock ? `解鎖條件：精英 ${module.unlock.elite} · 等級 ${module.unlock.level}` : '資料包尚未提供解鎖精英與等級條件。'}{selected?.trust !== undefined && <><br/>信賴需求：{selected.trust}%</>}</p>
      {levels.length ? <>
        <label className="skill-level-picker"><span>查看模組說明等級</span><select className="filter" aria-label={`${module.name}的模組說明等級`} value={level} onChange={event => select(Number(event.currentTarget.value))}>{levels.map(item => <option key={item.level} value={item.level}>模組 {item.level} 級</option>)}</select></label>
        <p className="fine-print">正在查看 {level} 級說明；切換不會解鎖、升級或裝備此模組。</p>
        <h5>屬性加成</h5>
        {selected?.attributes.length ? <dl className="module-attributes">{selected.attributes.map((attribute, index) => <div key={`${attribute.key}-${index}`}><dt>{attribute.label}</dt><dd>{attribute.value > 0 ? '+' : ''}{attribute.value}</dd></div>)}</dl> : <p className="fine-print">此等級尚未列出屬性加成。</p>}
        <h5>特性與天賦效果</h5>
        <p className="fine-print">以下為此級別的條件版本，請對照精英、等級與潛能；不代表全部同時生效或可相加，也不代表已裝備。</p>
        {effects.length ? <div className="module-effects">{effects.map((effect, index) => {
          const condition = talentCondition(effect, row);
          const hasExtraCondition = Boolean(effect.isToken || effect.validInGameTag || effect.validInMapTag || effect.validModeIndices?.length);
          return <section className={`module-effect talent-${condition}`} key={`${effect.kind}-${index}`}>
            <div className="split-heading"><h6>{effect.kind === 'trait' ? '特性' : '天賦'}{effect.name ? ` · ${effect.name}` : ''}</h6><span className={`tag ${condition === 'ready' && !hasExtraCondition ? 'muted' : 'amber'}`}>{condition === 'ready' ? hasExtraCondition ? '養成數值符合；其他條件待核對' : '養成數值符合' : condition === 'blocked' ? '養成條件未滿足' : '養成條件待核對'}</span></div>
            <p className="talent-requirement">精英 {effect.elite} · 等級 {effect.level} · 潛能 {effect.potential}</p><p className="game-description">{effect.description}</p>
            {hasExtraCondition && <ul className="module-effect-conditions">{effect.isToken && <li>效果對象：召喚物</li>}{effect.validInGameTag && <li>遊戲條件（來源代碼）：{effect.validInGameTag}</li>}{effect.validInMapTag && <li>地圖條件（來源代碼）：{effect.validInMapTag}</li>}{Boolean(effect.validModeIndices?.length) && <li>型態條件（來源索引）：{effect.validModeIndices!.join('、')}</li>}</ul>}
          </section>;
        })}</div> : <p className="fine-print">此等級尚未提供特性或天賦效果。</p>}
        <h5>{level === 1 ? '解鎖材料' : `升至 ${level} 級的材料`}</h5>
        {selected?.costs.length ? <ul className="module-costs">{selected.costs.map((cost, index) => <li key={`${cost.id}-${index}`}><span>{cost.name}</span><strong>× {cost.count.toLocaleString('zh-TW')}</strong></li>)}</ul> : <p className="fine-print">資料包未列出此等級材料，不代表無須材料。</p>}
      </> : <p className="fine-print">資料包尚未提供此模組的分級屬性、效果與材料說明。</p>}
      <details className="module-notes"><summary>解鎖任務{module.missions?.length ? `（${module.missions.length} 項）` : ''}</summary>{module.missions?.length ? <ol>{module.missions.map(mission => <li key={mission.id} className="game-description">{mission.description}</li>)}</ol> : <p className="fine-print">資料包尚未列出模組任務，不代表已完成或沒有任務。</p>}</details>
    </>}
    <details className="module-notes"><summary>模組背景</summary><p className="game-description">{module.description || '資料包尚未提供模組背景文字。'}</p></details>
  </article>;
}

export function OperatorEncyclopedia({ definition, row, skin }: { definition: OperatorDefinition; row: OwnedOperator; skin?: string }) {
  const talents = definition.talents ?? [];
  const originalModulesOnly = definition.modules.length > 0 && definition.modules.every(isOriginalModule);
  const confirmed = ['elite', 'level', 'potential'].every(field => row.fields[field]?.manuallyConfirmed);
  return <section className="operator-encyclopedia" aria-label="幹員資料與能力說明">
    <div className={`encyclopedia-profile rarity-${definition.rarity}`}><OperatorPortrait definition={definition} large elite={knownNumber(row, 'elite')} skin={skin}/><div><span className="operator-rarity" role="img" aria-label={`${definition.rarity} 星`}>{'★'.repeat(definition.rarity)}</span><h3>{definition.displayName}</h3><p>{definition.profession} · {definition.branch}<br/>{definition.faction}</p></div></div>
    <h3>技能說明</h3><p className="fine-print">選擇等級可查看資料包的中文說明；切換說明不會改變你的養成紀錄，也不代表已解鎖或已專精。</p>
    <div className="encyclopedia-list">{definition.skills.map(skill => <SkillDescription key={`${row.operatorId}-${skill.id}`} skill={skill} row={row}/>)}</div>
    <h3 className="encyclopedia-subheading">天賦與解鎖條件</h3><p className="fine-print">以下保留資料包中的各條件版本，不代表全部同時生效或可相加。條件依目前紀錄比對；未知養成值不視為已達成。</p>
    {talents.length ? <div className="encyclopedia-list">{talents.map((talent, index) => {
      const condition = talentCondition(talent, row);
      const label = condition === 'blocked' ? '養成條件未滿足' : condition === 'unknown' ? '養成條件待核對' : confirmed ? '養成條件符合' : '候選條件符合，待核對';
      return <article className={`encyclopedia-entry talent-${condition}`} key={`${talent.name}-${index}`}><div className="split-heading"><h4>{talent.name}</h4><span className={`tag ${condition !== 'ready' || !confirmed ? 'amber' : ''}`}>{label}</span></div><p className="talent-requirement">精英 {talent.elite} · 等級 {talent.level} · 潛能 {talent.potential}</p><p className="game-description">{talent.description}</p></article>;
    })}</div> : <p className="fine-print">資料包尚未提供此幹員的天賦說明。</p>}
    <h3 className="encyclopedia-subheading">模組說明</h3><p className="fine-print">模組資料用於查閱；個人持有、解鎖及養成狀態以各欄位紀錄為準。</p>
    {originalModulesOnly && <p className="fine-print">只有原始證章，沒有可升級模組資料。</p>}
    {definition.modules.length ? <div className="encyclopedia-list">{definition.modules.map(module => <ModuleDescription key={`${row.operatorId}-${module.id}`} module={module} row={row}/>)}</div> : <p className="fine-print">沒有模組資料。</p>}
  </section>;
}

interface GameDataStatus {
  version: string; sourceUpdatedAt: string; syncedAt: string;
  counts: { operators: number; stages: number; events: number };
  sourceKind: 'public-mirror'; sourceUrl: string; lastError?: unknown;
  moduleSource?: { version: string; sourceUrl: string; sourceUpdatedAt: string };
}
function statusValue(value: unknown): GameDataStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('無法讀取遊戲資料狀態。');
  const item = value as Record<string, unknown>, counts = item.counts as Record<string, unknown> | undefined;
  if (item.sourceKind !== 'public-mirror' || !['version', 'sourceUpdatedAt', 'syncedAt', 'sourceUrl'].every(key => typeof item[key] === 'string' && (item[key] as string).length <= 500) || !counts || !['operators', 'stages', 'events'].every(key => Number.isSafeInteger(counts[key]) && (counts[key] as number) >= 0)) throw new Error('無法讀取遊戲資料狀態。');
  const source = new URL(item.sourceUrl as string); if (source.protocol !== 'https:' || source.username || source.password) throw new Error('資料來源連結無效。');
  if (item.moduleSource !== undefined) {
    const moduleSource = item.moduleSource as Record<string, unknown>;
    if (!moduleSource || typeof moduleSource !== 'object' || Array.isArray(moduleSource) || !['version', 'sourceUrl', 'sourceUpdatedAt'].every(key => typeof moduleSource[key] === 'string' && (moduleSource[key] as string).length > 0 && (moduleSource[key] as string).length <= 500)) throw new Error('無法讀取模組資料來源狀態。');
    const moduleUrl = new URL(moduleSource.sourceUrl as string); if (moduleUrl.protocol !== 'https:' || moduleUrl.username || moduleUrl.password) throw new Error('模組資料來源連結無效。');
  }
  return item as unknown as GameDataStatus;
}
function statusDate(value: string): string {
  return Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('zh-TW', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Taipei' }).format(new Date(value)) : '尚無紀錄';
}

export function GameDataSettings() {
  const [status, setStatus] = useState<GameDataStatus | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const active = useRef(true), pending = useRef(false), controller = useRef<AbortController | null>(null);
  async function request(sync: boolean) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setMessage(null);
    const current = new AbortController(); controller.current = current;
    const timeout = window.setTimeout(() => current.abort(), sync ? 120_000 : 15_000);
    try {
      if (sync) {
        const response = await fetch('/api/game-data/sync', { method: 'POST', headers: { 'X-Game-Data-Sync': '1' }, credentials: 'omit', redirect: 'error', signal: current.signal, cache: 'no-store' });
        if (!response.ok) throw new Error('更新未完成。原有遊戲資料仍會保留，請稍後重試。');
      }
      const response = await fetch('/api/game-data/status', { credentials: 'omit', redirect: 'error', signal: current.signal, cache: 'no-store' });
      if (!response.ok) throw new Error('暫時無法讀取遊戲資料狀態，請確認本機資料服務已啟動。');
      const body = await response.text(); if (body.length > 64 * 1024) throw new Error('遊戲資料狀態超出可讀取大小。');
      const next = statusValue(JSON.parse(body));
      if (active.current) { setStatus(next); if (sync) setMessage({ text: '圖鑑已更新，重新開啟幹員詳情即可查看最新說明；養成紀錄不變。', error: false }); }
    } catch (error) {
      if (active.current) setMessage({ text: current.signal.aborted ? '等待已逾時；既有資料保留。可稍後重新查詢同步狀態。' : error instanceof Error && error.constructor === Error ? error.message : '遊戲資料狀態暫不可用，請確認本機資料服務已啟動；既有資料保留。', error: true });
    } finally {
      window.clearTimeout(timeout); pending.current = false;
      if (active.current) setBusy(false);
    }
  }
  useEffect(() => { active.current = true; void request(false); return () => { active.current = false; controller.current?.abort(); }; }, []);
  return <section className="panel game-data-settings"><div className="split-heading"><h2>遊戲資料</h2><span className="tag amber">公開來源鏡像</span></div><p>更新幹員、關卡與活動的參考資料。這份鏡像不是官方帳號同步服務，繁中服的開放進度仍須核對。</p>
    {status && <dl className="definition-list"><div><dt>資料版本</dt><dd>{status.version}</dd></div><div><dt>收錄內容</dt><dd>幹員 {status.counts.operators} · 關卡 {status.counts.stages} · 活動 {status.counts.events}</dd></div><div><dt>來源更新</dt><dd>{statusDate(status.sourceUpdatedAt)}</dd></div><div><dt>本機同步</dt><dd>{statusDate(status.syncedAt)}</dd></div><div><dt>來源</dt><dd><a href={status.sourceUrl} target="_blank" rel="noopener noreferrer">查看公開資料來源 ↗</a></dd></div></dl>}
    {status?.moduleSource && <dl className="definition-list"><div><dt>模組詳細資料版本</dt><dd>{status.moduleSource.version}</dd></div><div><dt>模組來源更新</dt><dd>{statusDate(status.moduleSource.sourceUpdatedAt)}</dd></div><div><dt>模組詳細資料來源</dt><dd><a href={status.moduleSource.sourceUrl} target="_blank" rel="noopener noreferrer">查看模組資料來源 ↗</a></dd></div></dl>}
    {status?.lastError && <p className="warning-note">上次更新未完成，正在保留既有資料。</p>}
    {busy && <p role="status" className="fine-print">正在讀取或更新遊戲資料…</p>}
    {message && <p role={message.error ? 'alert' : 'status'} className={`toast ${message.error ? 'error' : ''}`}>{message.text}</p>}
    <div className="inline-actions"><button className="button primary" disabled={busy} onClick={() => void request(true)}>更新遊戲資料</button><button className="button secondary" disabled={busy} onClick={() => void request(false)}>重新查詢狀態</button></div>
    <PortraitSync/>
  </section>;
}

interface PortraitJob { running: boolean; done: number; total: number; result?: { downloaded: number; skipped: number; missing: number; failed: number }; error?: string }
/** 下載依精英階段的立繪；在背景執行，這裡每秒查一次進度。 */
function PortraitSync() {
  const [job, setJob] = useState<PortraitJob | null>(null);
  const [error, setError] = useState('');
  const poll = useRef<number | null>(null);
  const mounted = useRef(true);
  // 只要伺服器回報同步進行中就輪詢（包含離開設定頁後回來、或重新整理頁面的情況）。
  const follow = (next: PortraitJob) => {
    // 離開設定頁後才回來的回應一律忽略，避免留下沒人清除的輪詢。
    if (!mounted.current) return;
    setJob(next);
    if (next.running && poll.current === null) poll.current = window.setInterval(() => { void read().catch(err => setError(err instanceof Error ? err.message : '讀取進度失敗。')); }, 1000);
    if (!next.running && poll.current !== null) { window.clearInterval(poll.current); poll.current = null; }
  };
  const read = async () => {
    const response = await fetch('/api/game-data/portraits-status', { credentials: 'omit', redirect: 'error', cache: 'no-store' });
    if (!response.ok) throw new Error('本機資料服務沒有回應，請用 start.cmd 啟動。');
    follow(await response.json() as PortraitJob);
  };
  useEffect(() => { mounted.current = true; void read().catch(() => {}); return () => { mounted.current = false; if (poll.current !== null) { window.clearInterval(poll.current); poll.current = null; } }; }, []);
  const start = async () => {
    setError('');
    try {
      const response = await fetch('/api/game-data/portraits', { method: 'POST', headers: { 'X-Game-Data-Sync': '1' }, credentials: 'omit', redirect: 'error', cache: 'no-store' });
      if (!response.ok) throw new Error('無法開始同步，請確認本機資料服務已啟動。');
      follow(await response.json() as PortraitJob);
    } catch (err) { setError(err instanceof Error ? err.message : '無法開始同步。'); }
  };
  const result = job?.result;
  return <div className="portrait-sync">
    <h3>幹員立繪</h3>
    <p className="fine-print">依你的精英化階段顯示立繪（精英 2 會換成精二立繪）。第一次約下載數百張圖片，之後只補新的。圖片存在本機，不會上傳。</p>
    {job?.running && <p role="status" className="fine-print">同步中… {job.done}／{job.total || '?'}</p>}
    {!job?.running && result && <p role="status" className="fine-print">完成：新下載 {result.downloaded} 張、已存在 {result.skipped} 張、沒有這張 {result.missing} 張{result.failed ? `、失敗 ${result.failed} 張（可再按一次重試）` : ''}。重新整理頁面即可看到。</p>}
    {(error || job?.error) && <p role="alert" className="toast error">{error || job?.error}</p>}
    <button type="button" className="button secondary" disabled={job?.running} onClick={() => void start()}>{job?.running ? '同步中…' : '同步幹員立繪'}</button>
  </div>;
}

let skinCache: Promise<SkinCatalog> | null = null;
function loadSkinCatalog(): Promise<SkinCatalog> {
  skinCache ??= fetch('/api/game-data/skins', { credentials: 'omit', redirect: 'error', cache: 'no-store' })
    .then(async response => { if (!response.ok) throw new Error('無法取得服裝清單，請確認本機資料服務已啟動並可連線。'); return await response.json() as SkinCatalog; })
    .catch(error => { skinCache = null; throw error; });
  return skinCache;
}

/** 服裝選擇：資料裡看不到你穿哪套，所以手動選；選了才下載那一套的立繪。 */
export function OutfitPicker({ definition, skin, busy, onChange }: { definition: OperatorDefinition; skin?: string; busy: boolean; onChange: (skin: string | null) => void }) {
  const [skins, setSkins] = useState<OperatorSkin[] | null>(null);
  const [message, setMessage] = useState('');
  const [working, setWorking] = useState(false);
  useEffect(() => {
    let active = true;
    loadSkinCatalog().then(catalog => { if (active) setSkins(catalog[definition.id] ?? []); }, error => { if (active) { setSkins([]); setMessage(error instanceof Error ? error.message : '無法取得服裝清單。'); } });
    return () => { active = false; };
  }, [definition.id]);
  const choose = async (value: string) => {
    setMessage('');
    if (!value) { onChange(null); return; }
    setWorking(true);
    try {
      const response = await fetch(`/api/game-data/skin-portrait?id=${encodeURIComponent(value)}`, { method: 'POST', headers: { 'X-Game-Data-Sync': '1' }, credentials: 'omit', redirect: 'error', cache: 'no-store' });
      if (!response.ok) throw new Error('這套服裝的立繪下載失敗，請稍後再試。');
      onChange(value);
    } catch (error) { setMessage(error instanceof Error ? error.message : '下載失敗。'); } finally { setWorking(false); }
  };
  if (skins && !skins.length && !message) return <p className="fine-print outfit-picker">這位幹員在台服沒有時裝。</p>;
  return <label className="outfit-picker">
    <span>目前服裝</span>
    <select className="text-input" value={skin ?? ''} disabled={busy || working || !skins} onChange={event => void choose(event.currentTarget.value)}>
      <option value="">預設（依精英化階段）</option>
      {(skins ?? []).map(item => <option key={item.id} value={item.id}>{item.name}{item.group ? `（${item.group}）` : ''}</option>)}
    </select>
    <small className="fine-print">{working ? '下載立繪中…' : message || '遊戲資料看不到你穿哪套，請手動選擇；只會下載你選的那套。'}</small>
  </label>;
}

import { useEffect, useState } from 'preact/hooks';
import type { AppState, Settings } from '../domain/model';
import type { BaseCatalog } from '../catalog/base';
import { candidatesFor, compareLayout, DEFAULT_WEIGHTS, evaluateBase, LAYOUTS, layoutFacilities, optimizeBase, type LayoutComparison, type ObjectiveWeights, recommendBase, type BaseRecommendation, type OptimizeResult, FACILITY_LABEL, parseSkill, PRODUCT_LABEL, ROOM_OF, type Facility, type FacilityResult, type FacilityType, type SkillEffect, type WorkshopTarget } from '../domain/base';
import { createDemoBaseCatalog } from '../demo';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { BaseMap } from './BaseMap';
import { BaseTraining } from './BaseTraining';
import { BaseStats } from './BaseStats';

type Base = Settings['base'];
const TYPES: FacilityType[] = ['control', 'manufacturing', 'trading', 'power', 'dormitory', 'meeting', 'office', 'training', 'workshop'];
const newId = () => `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const signed = (value: number, unit = '%') => `${value >= 0 ? '+' : ''}${value}${unit}`;

const roomLabel = (room: string) => FACILITY_LABEL[Object.entries(ROOM_OF).find(([, value]) => value === room)?.[0] as FacilityType] ?? room;
const WORKSHOP_TYPE_LABEL: Record<string, string> = { F_EVOLVE: '精英材料', F_SKILL: '技巧概要', F_BUILDING: '基建材料', F_ASC: '晶片' };
const targetText = (target: WorkshopTarget) => [target.mood !== undefined ? `原始心情 ${target.mood}` : '', target.types?.map(type => WORKSHOP_TYPE_LABEL[type] ?? type).join('、') ?? '', target.includes ? `${target.includes}類` : '', target.equals ?? ''].filter(Boolean).join('的') || '任意材料';
function effectText(effect: SkillEffect): string {
  switch (effect.kind) {
    case 'productivity': return `${effect.product === 'gold' ? '赤金' : effect.product === 'record' ? '作戰記錄' : effect.product === 'originium' ? '源石類' : ''}生產力 ${signed(effect.value)}`;
    case 'capacity': return `倉庫上限 ${signed(effect.value, '')}`;
    case 'moodCost': return `心情消耗 ${signed(effect.value, '/時')}`;
    case 'order': return `訂單效率 ${signed(effect.value)}`;
    case 'orderLimit': return `訂單上限 ${signed(effect.value, '')}`;
    case 'drone': return `無人機充能 ${signed(effect.value)}`;
    case 'moodRecoverSelf': return `自身心情恢復 ${signed(effect.value, '/時')}`;
    case 'moodRecoverAll': return `全宿舍心情恢復 ${signed(effect.value, '/時')}（取最高）`;
    case 'perGroup': return `${effect.scope === 'room' ? '同設施' : '基建內'}每名${effect.group}：${effectText(effect.per)}${effect.max ? `（最多 ${effect.max} 名）` : ''}`;
    case 'resource': return `${effect.resource} +${effect.amount}${{ flat: '', perDormOccupant: '／宿舍每人', perRoomOccupant: '／本宿舍每人', perRoomLevel: '／本設施每級', perFacilityLevel: '／全基建每級', perRecruitSlot: '／每個招募位', perGroupOutsideDorm: `／宿舍外每名${effect.group}`, perGroupInRoom: `／本設施每名${effect.group}` }[effect.source]}${effect.max ? `（上限 ${effect.max}）` : ''}${effect.when === 'high' ? '（心情 > 12）' : effect.when === 'low' ? '（心情 ≤ 12）' : ''}`;
    case 'convert': return `每 ${effect.per} 點${effect.from}轉化為 1 點${effect.to}`;
    case 'resourceScale': return `每 ${effect.per} 點${effect.resource}：${effectText(effect.effect)}`;
    case 'resourceThreshold': return `${effect.resource}達 ${effect.min} 以上：${effectText(effect.effect)}`;
    case 'clue': return `線索蒐集速度 +${effect.value}%${effect.alone ? '（會客室只有自己工作時）' : ''}`;
    case 'contact': return `聯絡速度 +${effect.value}%${effect.perDormLevel ? '／宿舍每級' : ''}`;
    case 'training': return `${effect.professions ? effect.professions.join('、') : ''}專精訓練 +${effect.value}%${effect.atMastery ? `（訓練至專精 ${effect.atMastery}）` : ''}`;
    case 'byproduct': return `副產品機率 +${effect.value}%（${effect.target ? targetText(effect.target) : { elite: '精英材料', skill: '技巧概要', base: '基建材料', any: '任意材料', other: '指定材料' }[effect.category]}）`;
    case 'global': return `所有${effect.product === 'gold' ? '赤金' : ''}${{ MANUFACTURE: '製造站生產力', TRADING: '貿易站訂單效率', MEETING: '會客室線索速度', HIRE: '辦公室聯絡速度', TRAINING: '訓練室專精速度' }[effect.target]} ${signed(effect.value)}${effect.maxOnly ? '（取最高）' : ''}`;
    case 'moodRoom': return `同設施所有人心情 ${effect.value < 0 ? `恢復 +${-effect.value}` : `消耗 +${effect.value}`}/時`;
    case 'whenMood': return `${effect.cond === 'high' ? '心情 > 12 時' : '心情 ≤ 12 時'}：${effectText(effect.effect)}`;
    case 'perMoodDrop': return `每 ${effect.per} 點心情落差：${effectText(effect.effect)}`;
    case 'perOtherWorking': return `同設施每名其他工作中幹員：${effectText(effect.effect)}`;
    case 'workingMood': return `其他設施工作中幹員心情恢復 +${-effect.value}/時`;
    case 'dormSingle': return `宿舍內某位心情未滿者恢復 +${effect.value}/時（取最高）`;
    case 'scaleBy': return `${{ recruitSlots: '每個招募位', powerPlants: `每 ${effect.per} 間發電站`, roomLevel: '本設施每級', dormLevels: '宿舍每級', tradingPosts: '每個貿易站', meetingLevel: '會客室每級', trainingLevel: '訓練室每級', roomOccupants: '同站每人', productTypes: '製造站每類配方', droneCap: `每 ${effect.per} 架無人機上限` }[effect.by]}：${effectText(effect.effect)}${effect.max ? `（最多 ${effect.max}%）` : ''}`;
    case 'perRoomStat': return `同站${effect.others ? '其他' : ''}幹員的${effect.stat === 'order' ? '訂單效率' : '生產力'}每 ${effect.per}% 再＋${effect.value}%（最多 ${effect.max}%）`;
    case 'whenTraining': return `協助${effect.professions?.join('、') ?? ''}幹員專精至 ${effect.atMastery} 級時：${effectText(effect.effect)}`;
    case 'moodNeutral': return effect.scope === 'self' ? '消除自身心情消耗的影響' : `消除同站${effect.group ? `${effect.group}幹員` : '所有幹員'}自身心情消耗的影響`;
    case 'perOrderLimit': return `同站幹員提升的每 ${effect.per} 個訂單上限＋${effect.value}% 訂單效率${effect.max ? `（最多 ${effect.max}%）` : ''}`;
    case 'goldLine': return `提供 ${effect.value} 條赤金生產線`;
    case 'perGoldLines': return `每 ${effect.per} 條赤金生產線：${effectText(effect.effect)}`;
    case 'zeroOthers': return `同站其他幹員的${effect.stat === 'productivity' ? '生產力' : '訂單效率'}加成歸零`;
    case 'whenProduct': return `生產${effect.product === 'gold' ? '赤金' : '作戰記錄'}時：${effectText(effect.effect)}`;
    case 'ifPresent': return `${effect.name}在${effect.where === 'base' ? '基建內' : effect.where === 'work' ? '工作場所' : FACILITY_LABEL[Object.entries(ROOM_OF).find(([, room]) => room === effect.where)?.[0] as FacilityType] ?? effect.where}時：${effectText(effect.effect)}`;
    case 'ifGroupInRoom': return `同設施有${effect.group}幹員時：${effectText(effect.effect)}`;
    case 'globalDorm': return `所有宿舍心情恢復 +${effect.value}/時（取最高）`;
    case 'ramp': return `${{ productivity: '生產力', drone: '無人機', clue: '線索速度' }[effect.stat]}首小時 +${effect.first}%、每小時 +${effect.perHour}%、最多 +${effect.max}%`;
    case 'orderMod': return { qualityAlpha: '提高高品質訂單（α）', qualityBeta: '提高高品質訂單（β）', pepe: '特別獨佔訂單', closure: '可露希爾特別訂單', twoGold: '赤金交付數固定為 2', breach: '交付數小於 4 視為違約訂單', breachBonus: `違約訂單赤金 +${effect.amount}`, invest: `4 赤金訂單龍門幣 +${effect.amount}` }[effect.mod];
    case 'remote': return `${{ MANUFACTURE: '製造站', TRADING: '貿易站', MEETING: '會客室' }[effect.target]}每名${effect.group}：${effect.effects.map(effectText).join('、')}`;
    case 'perCategory': return `同站每個${effect.category}技能：${effectText(effect.effect)}`;
    case 'categoryAlias': return `同站${effect.from.join('、')}技能也算作${effect.to}`;
    case 'perGroupIn': return `${roomLabel(effect.where)}每名${effect.others ? '其他' : ''}${effect.group}：${effectText(effect.effect)}`;
    case 'ifGroupCount': return `${roomLabel(effect.where)}有 ${effect.min} 名以上${effect.others ? '其他' : ''}${effect.group}時：${effectText(effect.effect)}`;
    case 'powerCount': return `發電站數量 +${effect.value}（只影響依發電站數的技能）${effect.ifName ? `，需${effect.ifName}在發電站` : ''}${effect.unlessGroup ? `，其他發電站沒有${effect.unlessGroup}時` : ''}`;
    case 'remoteTo': return `${effect.name}所在的${roomLabel(effect.target)}：${effectText(effect.effect)}`;
    case 'remoteGroupMin': return `有 ${effect.min} 名以上${effect.group}的${roomLabel(effect.target)}：${effectText(effect.effect)}`;
    case 'outerGround': return `外勢 ≥ 實地時 ${effectText(effect.outer)}；否則 ${effectText(effect.ground)}`;
    case 'abyssalBoost': return '深海獵人進駐製造站時的特殊加成（名詞表數值）';
    case 'abyssalMood': return `宿舍外每名深海獵人自身心情消耗 +${effect.outside}，宿舍內每名恢復 +${effect.inside}（滿心情再 +${effect.full}）`;
    case 'moodFor': return `${effect.others ? '同站其他幹員' : effect.name}心情${effect.value < 0 ? `恢復 +${-effect.value}` : `消耗 +${effect.value}`}/時`;
    case 'contactFloor': return `辦公室聯絡速度低於 ${effect.below}% 時 +${effect.value}%`;
    case 'orderCount': return effect.mode === 'perOrder' ? `每筆訂單 +${effect.value}% 訂單效率（其他人每 ${effect.limitPer}% 效率使上限 -1）` : `與訂單上限每差 1 筆 +${effect.value}% 訂單效率`;
    case 'perFacilityWith': return `每間有${effect.group}的設施：${effectText(effect.effect)}（最多 ${effect.max} 間）`;
    case 'dormSplit': return `總計 +${effect.value}/時，平均分給心情未滿的成員`;
    case 'dormBelow': return `心情 ${effect.threshold} 以下者額外恢復 +${effect.value}/時`;
    case 'dormGroupBonus': return `${effect.name}對${effect.group}幹員額外恢復 +${effect.value}/時`;
    case 'whenExchange': return `線索交流期間：${effectText(effect.effect)}`;
    case 'qualitative': return `${effect.text}（無數值）`;
    case 'perRoomCapacity': return `同站提升的倉庫容量換算生產力（${effect.tiers.map(tier => `${Number.isFinite(tier.upTo) ? `${tier.upTo} 格以下` : '其餘'}每格 ${tier.value}%`).join('、')}）`;
    case 'workshopMood': return `${effect.target ? `${targetText(effect.target)}：` : ''}${effect.cost !== undefined ? `心情消耗 ${effect.cost}${effect.gte ? ' 以上' : ''}的配方` : '配方'}${effect.set !== undefined ? `心情恆定 ${effect.set}` : effect.divide ? `心情 ÷${effect.divide}` : `心情 ${signed(effect.add ?? 0, '')}`}`;
    case 'perDormLow': return `宿舍每 ${effect.per} 名心情 ${effect.threshold} 以下者：${effectText(effect.effect)}`;
    case 'karma': return `未出副產品時累積${effect.resource}，每 ${effect.per} 點必出一次`;
    case 'refundOnMiss': return `每 ${effect.every} 次沒出副產品退回一次心情`;
    default: return '';
  }
}

export function useBaseCatalog(isDemo: boolean, attempt: number) {
  const [catalog, setCatalog] = useState<BaseCatalog | null>(isDemo ? createDemoBaseCatalog() : null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (isDemo) { setCatalog(createDemoBaseCatalog()); setError(''); return; }
    const controller = new AbortController();
    setCatalog(null); setError('');
    void fetch('/api/game-data/base', { credentials: 'omit', redirect: 'error', signal: controller.signal, cache: 'no-store' })
      .then(async response => {
        const body = await response.json().catch(() => null) as (BaseCatalog & { error?: { message?: string } }) | null;
        if (!response.ok || !body || !Array.isArray(body.rooms) || !body.skills || !body.operators) throw new Error(body?.error?.message ?? '');
        setCatalog(body);
      })
      .catch(err => { if (!controller.signal.aborted) setError(err instanceof Error && err.message ? err.message : '無法讀取基建資料，請確認已執行 npm run game-data 並在設定更新遊戲資料。'); });
    return () => controller.abort();
  }, [isDemo, attempt]);
  return { catalog, error };
}

function FacilityCard({ result, catalog, state, base, busy, onChange, onRemove, onAssign, onUnassign, onSettings }: {
  result: FacilityResult; catalog: BaseCatalog; state: AppState; base: Base; busy: boolean;
  onChange: (patch: Partial<Facility>) => void; onRemove: () => void; onAssign: (operatorId: string) => void; onUnassign: (operatorId: string) => void; onSettings: (patch: Partial<Base>) => void;
}) {
  const { facility, room } = result;
  const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
  const assignedAnywhere = new Set(Object.values(base.assignments ?? {}).flat());
  const candidates = candidatesFor(facility, catalog, state.roster, definitions, assignedAnywhere);
  const full = result.capacity > 0 && result.operators.length >= result.capacity;
  const roomType = ROOM_OF[facility.type];
  const metrics: [string, string][] = [];
  if (roomType === 'MANUFACTURE') metrics.push(['生產力（已計入）', signed(result.totals.basic + result.totals.productivity)]);
  if (roomType === 'TRADING') metrics.push(['訂單效率（已計入）', signed(result.totals.basic + result.totals.order)]);
  if (roomType === 'POWER') metrics.push(['無人機充能（已計入）', signed(result.totals.drone)]);
  if (roomType === 'DORMITORY') metrics.push(['全宿舍恢復（已計入）', signed(result.totals.moodRecoverAll, '/時')]);
  const incomplete = result.unsupported.length + result.uncertain.length;
  return <article className={`facility-card facility-${facility.type}`} aria-label={result.label}>
    <header className="facility-head">
      <div><h3>{result.label}</h3><p className="fine-print">{result.capacity ? `進駐 ${result.operators.length}／${result.capacity}` : '等級資料不足'}{room && ` · 電力 ${room.phases[facility.level - 1]?.electricity ?? '—'}`}</p></div>
      <button type="button" className="icon-button" aria-label={`移除${result.label}`} disabled={busy} onClick={onRemove}><Icon name="close" size={16}/></button>
    </header>
    <div className="facility-controls">
      <label><span>等級</span><select className="filter" value={facility.level} disabled={busy} onChange={event => onChange({ level: Number(event.currentTarget.value) })}>{(room?.phases ?? [{}]).map((_, index) => <option key={index} value={index + 1}>{index + 1} 級</option>)}</select></label>
      {facility.type === 'training' && <><label><span>訓練中的職業</span><select className="filter" value={base.training?.profession ?? ''} disabled={busy} onChange={event => onSettings({ training: { ...base.training, profession: event.currentTarget.value || undefined } })}><option value="">未設定（只計通用加成）</option>{['先鋒', '近衛', '重裝', '狙擊', '術師', '醫療', '輔助', '特種'].map(item => <option key={item} value={item}>{item}</option>)}</select></label>
        <label><span>目標專精</span><select className="filter" value={base.training?.mastery ?? ''} disabled={busy} onChange={event => onSettings({ training: { ...base.training, mastery: event.currentTarget.value ? Number(event.currentTarget.value) as 1 | 2 | 3 : undefined } })}><option value="">未設定</option>{[1, 2, 3].map(item => <option key={item} value={item}>專精 {item}</option>)}</select></label></>}
      {facility.type === 'workshop' && <label><span>加工配方</span><select className="filter" value={base.workshopFormula ? `f:${base.workshopFormula}` : base.workshop ? `c:${base.workshop}` : ''} disabled={busy} onChange={event => { const [kind, value] = event.currentTarget.value.split(':'); const formula = kind === 'f' ? catalog.workshop?.find(item => item.id === value) : undefined; onSettings({ workshopFormula: formula?.id, workshop: kind === 'c' ? value as Base['workshop'] : formula ? ({ F_EVOLVE: 'elite', F_SKILL: 'skill', F_BUILDING: 'base' } as Record<string, Base['workshop']>)[formula.type] : undefined }); }}>
        <option value="">未設定（只計任意材料加成）</option>
        <optgroup label="只指定類別"><option value="c:elite">精英材料</option><option value="c:skill">技巧概要</option><option value="c:base">基建材料</option></optgroup>
        {Object.entries(WORKSHOP_TYPE_LABEL).map(([type, label]) => <optgroup key={type} label={`${label}（指定配方）`}>{(catalog.workshop ?? []).filter(item => item.type === type).map(item => <option key={item.id} value={`f:${item.id}`}>{item.name}（心情 {item.mood}）</option>)}</optgroup>)}
      </select></label>}
      {facility.type === 'power' && <label><span>無人機上限</span><input className="text-input" type="number" min={0} max={999} placeholder="未設定（視為滿等）" value={base.droneCap ?? ''} disabled={busy} onChange={event => { const value = event.currentTarget.value; onSettings({ droneCap: value === '' ? undefined : Math.max(0, Math.min(999, Math.round(Number(value)))) }); }}/></label>}
      {facility.type === 'meeting' && <label className="checkbox-line"><input type="checkbox" checked={!!base.clueExchange} disabled={busy} onChange={event => onSettings({ clueExchange: event.currentTarget.checked || undefined })}/><span>線索交流中</span></label>}
      {facility.type === 'manufacturing' && <label><span>產品</span><select className="filter" value={facility.product ?? ''} disabled={busy} onChange={event => onChange({ product: event.currentTarget.value as Facility['product'] })}><option value="" disabled>選擇產品</option><option value="gold">{PRODUCT_LABEL.gold}</option><option value="record">{PRODUCT_LABEL.record}</option></select></label>}
    </div>
    {metrics.length > 0 && <dl className="facility-metrics">{metrics.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}{(roomType === 'MANUFACTURE' || roomType === 'TRADING') && <div><dt>其中基礎</dt><dd>{signed(result.totals.basic)}</dd></div>}</dl>}
    {result.workshop && <p className="facility-remote">{result.workshop.name}：每次心情 {result.workshop.baseMood} → {result.workshop.mood}、副產品機率 {Math.round(result.workshop.baseRate * 1000) / 10}% → {Math.round(result.workshop.rate * 1000) / 10}%、每點心情產出 {signed(result.workshop.efficiency)}{result.workshop.gold ? `、每次 ${result.workshop.gold} 龍門幣` : ''}{result.workshop.notes.length ? `（${result.workshop.notes.join('；')}）` : ''}</p>}
    {result.remote.length > 0 && <p className="facility-remote">控制中樞加成：{result.remote.map(item => `${item.from}「${item.skill}」${item.text} ${item.value >= 0 ? '+' : ''}${item.value}%`).join('；')}</p>}
    {incomplete > 0 && <p className="facility-warning"><Icon name="alert" size={14}/>有 {incomplete} 個技能未計入或待核對，合計不完整。</p>}
    {result.issues.map(issue => <p key={issue} className="facility-issue">{issue}</p>)}
    {result.notes.map(note => <p key={note} className="fine-print">{note}</p>)}
    <ul className="facility-slots">
      {result.operators.map(op => <li key={op.operatorId}>
        <div className="slot-head"><strong>{op.name}</strong><button type="button" className="button ghost small" disabled={busy} onClick={() => onUnassign(op.operatorId)} aria-label={`將${op.name}移出${result.label}`}>移出</button></div>
        <div className="slot-skills">{op.skills.filter(skill => skill.applies).map((skill, index) => {
          const shown = skill.active ?? skill.maybeUpgraded ?? skill.next?.skill;
          if (!shown) return null;
          const parsed = skill.active ? parseSkill(skill.active) : undefined;
          const comboMissing = !!skill.combo && !skill.combo.active;
          const offProduct = !!parsed?.supported && !comboMissing && !(skill.applied ?? []).length;
          const tone = skill.state === 'locked' ? 'muted' : skill.state === 'unknown' ? 'amber' : comboMissing ? 'amber' : offProduct ? 'muted' : parsed?.supported ? 'ok' : 'info';
          const effectLabel = (skill.applied ?? []).map(effectText).join('、');
          return <details key={index} className={`skill-chip ${tone}`}>
            <summary><span>{shown.name}</span><em>{skill.state === 'locked' ? `未解鎖（精英 ${skill.next?.elite}・等級 ${skill.next?.level}）` : skill.state === 'unknown' ? '解鎖待核對' : comboMissing ? `需與${skill.combo!.partner}同房` : offProduct ? (roomType === 'MANUFACTURE' ? '不適用目前產品' : '目前條件未成立') : parsed?.supported ? `${skill.combo?.active ? '搭配成立：' : ''}${effectLabel}` : '未計入'}</em></summary>
            <p>{shown.description}</p>
            {parsed?.ignoredCondition && <p className="fine-print">{parsed.ignoredCondition}尚未支援，未計入。</p>}
            {parsed?.estimate && <p className="fine-print">估計：{parsed.estimate}。</p>}
            {skill.maybeUpgraded && skill.active && <p className="fine-print">可能已升級為「{skill.maybeUpgraded.name}」：養成數值未知，暫以已確認版本計算。</p>}
          </details>;
        })}{!op.skills.some(skill => skill.applies) && <span className="fine-print">沒有{FACILITY_LABEL[facility.type]}技能{roomType === 'MANUFACTURE' || roomType === 'TRADING' ? '，只計基礎加成' : ''}</span>}</div>
      </li>)}
    </ul>
    {!full && <label className="facility-add"><span className="sr-only">加入幹員到{result.label}</span><select className="filter" value="" disabled={busy || !candidates.length} onChange={event => { const id = event.currentTarget.value; if (id) onAssign(id); }}>
      <option value="">{candidates.length ? '＋ 加入幹員' : '沒有可加入的幹員'}</option>
      {(['ready', 'unknown', 'none'] as const).map(group => {
        const items = candidates.filter(item => item.state === group);
        if (!items.length) return null;
        return <optgroup key={group} label={group === 'ready' ? '有已解鎖的此設施技能' : group === 'unknown' ? '技能解鎖待核對' : '沒有此設施技能'}>{items.map(item => <option key={item.operatorId} value={item.operatorId}>{item.name}{item.summary ? `｜${item.summary}` : ''}{item.score ? `（已計入 ${signed(item.score, '')}）` : ''}</option>)}</optgroup>;
      })}
    </select></label>}
    {(result.unsupported.length > 0 || result.notApplicable.length > 0) && <details className="plain-details facility-notes"><summary>未計入與不適用的技能（{result.unsupported.length + result.notApplicable.length}）</summary>
      <ul>{result.unsupported.map(item => <li key={`u-${item.operatorId}-${item.skill.id}`}><strong>{definitions.get(item.operatorId)?.displayName}・{item.skill.name}</strong>：條件型或聯動效果，尚未支援計算。<br/><span className="fine-print">{item.skill.description}</span></li>)}
        {result.notApplicable.map(item => <li key={`n-${item.operatorId}-${item.skill.id}`}><strong>{definitions.get(item.operatorId)?.displayName}・{item.skill.name}</strong>：不適用目前產品。</li>)}</ul>
    </details>}
  </article>;
}

/** 整體最佳化結果與警語。 */
function OptimizedView({ result, base, catalog, state, weights }: { result: OptimizeResult; base: Base; catalog: BaseCatalog; state: AppState; weights: ObjectiveWeights }) {
  const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
  const optimizedBase = { ...base, facilities: base.facilities.map(f => result.products[f.id] ? { ...f, product: result.products[f.id] } : f) };
  const evaluation = evaluateBase({ ...optimizedBase, assignments: result.assignments }, catalog, state.roster, definitions);
  const changed = base.facilities.filter(f => result.products[f.id] && f.product !== result.products[f.id]);
  const gain = Math.round((result.objective.total - result.start.total) * 10) / 10;
  return <div className="recommend-result optimized">
    <div className="callout warning optimize-warning" role="note">
      <strong>警語：這是近似最佳，不是保證最佳</strong>
      <ul>
        <li>從單人推薦出發，逐格替換或交換幹員，只要整體效益變高就採用，直到無法再提升（局部搜尋）；不同起點可能得到不同結果。</li>
        <li>整體效益＝赤金站生產力％×{weights.gold}＋記錄站生產力％×{weights.record}＋貿易站龍門幣提升％×{weights.trading}（赤金不足時按供應比例打折）＋發電站無人機％×{weights.power}；權重可在上方調整。</li>
        <li>不模擬心情與換班；訂單品質技能以累積工作達峰值計；PRTS 為陸服資料；說明文字無法解析的技能不計入。</li>
        <li>宿舍沿用單人推薦，不參與最佳化。</li>
      </ul>
    </div>
    <p className="recommend-verdict"><strong>整體效益 {result.start.total} → {result.objective.total}（{gain >= 0 ? '+' : ''}{gain}）</strong>：赤金站 {result.objective.gold}%、記錄站 {result.objective.record}%、貿易 {result.objective.trading}%、發電 {result.objective.power}%、線索 {result.objective.clue}%、聯絡 {result.objective.contact}%、訓練 {result.objective.training}%、副產品 {result.objective.byproduct}%{result.objective.goldFactor < 1 ? `；赤金只夠 ${Math.round(result.objective.goldFactor * 100)}% 的訂單` : '；赤金足夠交付訂單'}。共替換 {result.moves} 次、評估 {result.evaluations.toLocaleString()} 種配置{result.timedOut ? '（達到時間上限而停止，可再按一次繼續）' : ''}。</p>
    {result.moodFilled.length > 0 && <p className="fine-print">控制中樞空位以心情恢復技能補上：{result.moodFilled.map(id => definitions.get(id)?.displayName ?? id).join('、')}（延長中樞人員可工作時間，不影響產量）。</p>}
    {changed.length > 0 && <p className="callout">建議調整製造站產品：{changed.map(f => `${evaluation.facilities.find(item => item.facility.id === f.id)?.label} 改做${result.products[f.id] === 'gold' ? '赤金' : '作戰記錄'}`).join('、')}（套用時一併變更）。</p>}
    <div className="recommend-grid">{evaluation.facilities.filter(item => item.operators.length).map(item => <article key={item.facility.id} className="recommend-card">
      <h3>{item.label}{item.facility.type === 'manufacturing' && <span className="tag muted">{item.facility.product === 'gold' ? '赤金' : '作戰記錄'}</span>}</h3>
      <ol className="recommend-picks">{item.operators.map(op => <li key={op.operatorId}><strong>{op.name}</strong><small>{op.skills.filter(skill => skill.applies && skill.active).map(skill => skill.active!.name).join('、') || '基礎加成'}</small></li>)}</ol>
      {item.remote.length > 0 && <p className="fine-print">{item.remote.map(r => `${r.from}「${r.skill}」${r.value >= 0 ? '+' : ''}${r.value}%`).join('；')}</p>}
    </article>)}</div>
  </div>;
}

/** 布局比較：逐一對常見布局跑整體最佳化，避免一次阻塞畫面太久。 */
function LayoutCompare({ state, catalog, weights, busy, onApply }: { state: AppState; catalog: BaseCatalog; weights: ObjectiveWeights; busy: boolean; onApply: (facilities: Facility[], assignments: Record<string, string[]>) => void }) {
  const [results, setResults] = useState<LayoutComparison[]>([]);
  const [progress, setProgress] = useState<number | null>(null);
  const run = () => {
    const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
    const collected: LayoutComparison[] = [];
    setResults([]); setProgress(0);
    const step = (index: number) => {
      if (index >= LAYOUTS.length) { setProgress(null); return; }
      window.setTimeout(() => {
        collected.push(compareLayout(LAYOUTS[index], catalog, state.roster, definitions, { weights, timeBudgetMs: 4000 }));
        setResults([...collected]); setProgress(index + 1); step(index + 1);
      }, 30);
    };
    step(0);
  };
  const feasible = results.filter(item => item.electricity.consumed <= item.electricity.produced);
  const bestId = feasible.length ? feasible.reduce((a, b) => b.objective.total > a.objective.total ? b : a).template.id : undefined;
  const fmt = (value: number) => value.toLocaleString('zh-TW', { maximumFractionDigits: 1 });
  return <div className="layout-compare">
    <div className="inline-actions">
      <button type="button" className="button secondary" disabled={busy || progress !== null} onClick={run}>{progress !== null ? `比較中…（${progress}／${LAYOUTS.length}）` : results.length ? '重新比較布局' : '比較常見布局'}</button>
      <span className="fine-print">對 {LAYOUTS.map(item => item.id).join('、')} 各自用你的幹員跑整體最佳化（每種約數秒），依目前權重比較。</span>
    </div>
    {results.length > 0 && <div className="layout-table-wrap"><table className="stats-table layout-table">
      <thead><tr><th>布局</th><th>整體效益</th><th>赤金（產／耗）</th><th>經驗／日</th><th>龍門幣／日</th><th>電力</th><th></th></tr></thead>
      <tbody>{results.map(item => {
        const short = item.electricity.consumed > item.electricity.produced;
        return <tr key={item.template.id} className={item.template.id === bestId ? 'is-best' : short ? 'is-infeasible' : ''}>
          <td><strong>{item.template.id}</strong>{item.template.id === bestId && <span className="tag amber">最適合</span>}<small>{item.template.label.replace(/^\d+/u, '')}</small></td>
          <td>{fmt(item.objective.total)}</td>
          <td>{fmt(item.gold)}／{fmt(item.goldConsumed)}</td>
          <td>{fmt(item.exp)}</td>
          <td>{fmt(item.lmd)}</td>
          <td>{short ? <span className="tag error">不足 {item.electricity.consumed}／{item.electricity.produced}</span> : `${item.electricity.consumed}／${item.electricity.produced}`}</td>
          <td><button type="button" className="button ghost small" disabled={busy} onClick={() => onApply(item.facilities, item.assignments)}>套用</button></td>
        </tr>;
      })}</tbody>
    </table></div>}
    {results.length > 0 && <p className="fine-print">「最適合」只在電力足夠的布局中挑選。所有設施以最高等級計；電力不足的布局需要降低部分設施等級（例如宿舍或訓練室）才能運作，降級後產出會不同。套用會取代目前的設施與進駐名單，保存前可按「還原」。</p>}
  </div>;
}

interface DataStatus { version: string; sourceUpdatedAt: string; syncedAt: string; counts: { operators: number } }

/** 推薦前先確認目前的繁中服資料版本與可用幹員，再用已持有幹員產生配置。 */
function RecommendPanel({ state, isDemo, busy, catalog, base, onApply, onApplyLayout, onRefreshed }: {
  state: AppState; isDemo: boolean; busy: boolean; catalog: BaseCatalog; base: Base; onApply: (assignments: Record<string, string[]>, products?: Record<string, 'gold' | 'record'>) => void; onApplyLayout: (facilities: Facility[], assignments: Record<string, string[]>) => void; onRefreshed: () => void;
}) {
  const [status, setStatus] = useState<DataStatus | null>(null);
  const [message, setMessage] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<BaseRecommendation | null>(null);
  const [optimized, setOptimized] = useState<OptimizeResult | null>(null);
  const [running, setRunning] = useState(false);
  // 權重只存在這台裝置；讀寫失敗時用預設值。
  const [weights, setWeights] = useState<ObjectiveWeights>(() => { try { const saved = JSON.parse(localStorage.getItem('arknights-tw-base-weights') ?? 'null'); return saved && ['gold', 'record', 'trading', 'power'].every(key => typeof saved[key] === 'number') ? { ...DEFAULT_WEIGHTS, ...saved } : DEFAULT_WEIGHTS; } catch { return DEFAULT_WEIGHTS; } });
  const updateWeight = (key: keyof ObjectiveWeights, value: number) => { const next = { ...weights, [key]: value }; setWeights(next); try { localStorage.setItem('arknights-tw-base-weights', JSON.stringify(next)); } catch { /* 不影響使用 */ } };
  const [optimizedWeights, setOptimizedWeights] = useState<ObjectiveWeights | null>(null);
  const generate = () => {
    setOptimizedWeights(weights);
    const recommendation = recommendBase(base, catalog, state.roster, definitions);
    setResult(recommendation); setOptimized(null); setRunning(true);
    // 讓畫面先顯示「計算中」，再進行整體最佳化（約數秒）。
    window.setTimeout(() => { try { setOptimized(optimizeBase(base, catalog, state.roster, definitions, { start: recommendation.assignments, timeBudgetMs: 6000, weights })); } finally { setRunning(false); } }, 30);
  };
  const loadStatus = async (sync = false) => {
    if (isDemo) return;
    setMessage(sync ? '正在向公開來源檢查繁中服最新資料，可能需要幾分鐘…' : '');
    setSyncing(sync);
    try {
      if (sync) {
        const response = await fetch('/api/game-data/sync', { method: 'POST', headers: { 'X-Game-Data-Sync': '1' }, credentials: 'omit', redirect: 'error', cache: 'no-store' });
        if (!response.ok) throw new Error('更新沒有完成，原有資料保留。請確認網路後重試。');
      }
      const response = await fetch('/api/game-data/status', { credentials: 'omit', redirect: 'error', cache: 'no-store' });
      if (!response.ok) throw new Error('暫時無法讀取資料版本。');
      setStatus(await response.json() as DataStatus);
      if (sync) { setMessage('已確認為目前可取得的最新繁中服資料。'); setResult(null); onRefreshed(); }
    } catch (error) { setMessage(error instanceof Error && error.constructor === Error ? error.message : '暫時無法讀取資料版本。'); }
    finally { setSyncing(false); }
  };
  useEffect(() => { void loadStatus(); }, [isDemo]);
  const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
  const ownedIds = state.roster.filter(row => !(row.fields.owned?.status === 'known' && row.fields.owned.value === false)).map(row => row.operatorId);
  const withSkills = ownedIds.filter(id => catalog.operators[id]).length;
  const ageDays = status ? Math.floor((Date.now() - Date.parse(status.sourceUpdatedAt)) / 86_400_000) : undefined;
  const date = (value: string) => new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeZone: 'Asia/Taipei' }).format(new Date(value));
  return <section className="panel recommend-panel" aria-label="基建推薦">
    <header className="recommend-head">
      <div><p className="eyebrow">推薦配置</p><h2>用你持有的幹員排出可計算加成最高的配置</h2></div>
      {!isDemo && <button type="button" className="button secondary small" disabled={busy || syncing} onClick={() => void loadStatus(true)}><Icon name="download" size={16}/>{syncing ? '檢查中…' : '檢查繁中服更新'}</button>}
    </header>
    <div className="recommend-facts">
      <div><span>資料版本</span><strong>{isDemo ? '示範資料' : status ? status.version.slice(0, 7) : '讀取中'}</strong><small>{isDemo ? '虛構' : status ? `來源更新 ${date(status.sourceUpdatedAt)}` : ''}</small></div>
      <div><span>繁中服圖鑑幹員</span><strong>{isDemo ? state.dataset.operators.length : status?.counts.operators ?? '—'}</strong><small>含轉職形態</small></div>
      <div><span>你持有</span><strong>{ownedIds.length}</strong><small>依目前幹員庫</small></div>
      <div><span>有基建技能資料</span><strong>{withSkills}</strong><small>可參與推薦</small></div>
    </div>
    {ageDays !== undefined && ageDays > 30 && <p className="callout warning">資料來源已 {ageDays} 天未更新，新幹員或技能調整可能尚未反映。建議先按「檢查繁中服更新」。</p>}
    {message && <p className="fine-print" role="status">{message}</p>}
    <fieldset className="weight-panel">
      <legend>你比較重視哪一項？（整體最佳化的權重）</legend>
      {([['gold', '赤金'], ['record', '作戰記錄'], ['trading', '龍門幣'], ['power', '無人機'], ['clue', '線索'], ['contact', '聯絡（公招）'], ['training', '專精訓練'], ['byproduct', '加工副產品']] as const).map(([key, label]) => <label key={key} className="weight-row">
        <span>{label}</span>
        <input type="range" min="0" max="3" step="0.5" value={weights[key]} aria-label={`${label}權重`} onInput={event => updateWeight(key, Number(event.currentTarget.value))}/>
        <b>{weights[key] === 0 ? '不考慮' : `×${weights[key]}`}</b>
      </label>)}
      <button type="button" className="button ghost small" onClick={() => { setWeights(DEFAULT_WEIGHTS); try { localStorage.removeItem('arknights-tw-base-weights'); } catch { /* 不影響使用 */ } }}>恢復等重</button>
      <p className="fine-print">調整後按「產生推薦」重新計算。權重只影響最佳化如何取捨，不改變各設施的實際數值；設定只存在這台裝置。</p>
    </fieldset>
    <LayoutCompare state={state} catalog={catalog} weights={weights} busy={busy || running} onApply={onApplyLayout}/>
    <div className="inline-actions">
      <button type="button" className="button primary" disabled={busy || syncing || !base.facilities.length} onClick={generate}>{running ? '最佳化計算中…' : result ? '重新產生推薦' : '產生推薦'}</button>
      {result && <button type="button" className="button secondary" disabled={busy || running} onClick={() => onApply(optimized?.assignments ?? result.assignments, optimized?.products)}>套用到配置草稿</button>}
      {!base.facilities.length && <span className="fine-print">請先在下方選一個常見布局或新增設施。</span>}
    </div>
    {optimized && <OptimizedView result={optimized} base={base} catalog={catalog} state={state} weights={optimizedWeights ?? weights}/>}
    {result && <div className="recommend-result">
      {optimized && <h3 className="recommend-subhead">第一階段：單人分數推薦（最佳化的起點）</h3>}
      <p className="recommend-verdict"><strong>從 {result.pool} 名持有幹員中選出 {result.picked} 名。</strong>只比較已解鎖且數值可追溯的技能；套用後仍可逐格調整，保存前不會寫入。</p>
      <div className="recommend-grid">{result.facilities.map(item => <article key={item.facilityId} className="recommend-card">
        <h3>{item.label}</h3>
        {item.picks.length > 0 && <ol className="recommend-picks">{item.picks.map(pick => <li key={pick.operatorId}><strong>{pick.name}</strong><span className="score">+{pick.score}</span><small>{pick.summary}</small></li>)}</ol>}
        {item.note && <p className="fine-print">{item.note}</p>}
        {item.alternatives.length > 0 && <details className="plain-details"><summary>替代人選（{item.alternatives.length}）</summary><ul>{item.alternatives.map(alt => <li key={alt.operatorId}>{alt.name}（+{alt.score}）<small>{alt.summary}</small></li>)}</ul></details>}
        {item.maybe.length > 0 && <p className="fine-print">解鎖待核對、可能也合適：{item.maybe.map(m => m.name).join('、')}</p>}
      </article>)}</div>
      <details className="plain-details"><summary>推薦依據與限制</summary><ul className="gap-list">
        <li>候選只來自你的幹員庫，並以目前繁中服資料包的技能與解鎖條件判斷；資料版本見上方。</li>
        <li>分數＝已解鎖技能中可解析的數值加總（製造依產品過濾）。條件型、聯動、隨時間累積的技能不加分，也不扣分。</li>
        <li>分配方式：把所有「幹員×設施」組合依分數由高到低排序，依序放入，每人只排一處、不超過進駐上限。</li>
        <li>沒有模擬心情消耗與換班，因此不是收益最佳化或排班建議；控制中樞、會客室等不推薦人選。</li>
      </ul></details>
    </div>}
  </section>;
}

export function BasePage({ state, isDemo, busy, onSave }: { state: AppState; isDemo: boolean; busy: boolean; onSave: (base: Base) => void }) {
  const [attempt, setAttempt] = useState(0);
  const { catalog, error } = useBaseCatalog(isDemo, attempt);
  const [draft, setDraft] = useState<Base>(state.settings.base);
  const [addType, setAddType] = useState<FacilityType>('manufacturing');
  const [view, setView] = useState<'map' | 'list' | 'training'>(() => { try { const saved = localStorage.getItem('arknights-tw-base-view'); return saved === 'list' || saved === 'training' ? saved : 'map'; } catch { return 'map'; } });
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => { try { localStorage.setItem('arknights-tw-base-view', view); } catch { /* 不影響使用 */ } }, [view]);
  const saved = JSON.stringify(state.settings.base);
  useEffect(() => { setDraft(state.settings.base); }, [saved]);
  const dirty = JSON.stringify(draft) !== saved;

  if (error) return <section className="panel planned"><span className="tag amber">需要基建資料</span><h2>還沒有可用的基建資料</h2><p>{error}</p><div className="inline-actions"><button type="button" className="button secondary" onClick={() => setAttempt(value => value + 1)}>重新讀取</button></div></section>;
  if (!catalog) return <p className="fine-print" role="status">正在讀取基建資料…</p>;

  const definitions = new Map(state.dataset.operators.map(op => [op.id, op]));
  const evaluation = evaluateBase(draft, catalog, state.roster, definitions);
  const update = (next: Base) => setDraft(next);
  const patchFacility = (id: string, patch: Partial<Facility>) => update({ ...draft, facilities: draft.facilities.map(f => f.id === id ? { ...f, ...patch } : f) });
  const removeFacility = (id: string) => { const assignments = { ...(draft.assignments ?? {}) }; delete assignments[id]; update({ ...draft, facilities: draft.facilities.filter(f => f.id !== id), assignments }); };
  const assign = (id: string, operatorId: string) => update({ ...draft, assignments: { ...(draft.assignments ?? {}), [id]: [...(draft.assignments?.[id] ?? []), operatorId] } });
  const unassign = (id: string, operatorId: string) => update({ ...draft, assignments: { ...(draft.assignments ?? {}), [id]: (draft.assignments?.[id] ?? []).filter(item => item !== operatorId) } });
  const addFacility = (type: FacilityType, level = 1, product?: Facility['product']) => ({ id: newId(), type, level, ...(product ? { product } : {}) });
  const applyTemplate = (index: number) => update({ ...draft, facilities: layoutFacilities(LAYOUTS[index], newId()), assignments: {} });
  const { produced, consumed } = evaluation.electricity;
  const unsupportedTotal = evaluation.facilities.reduce((sum, f) => sum + f.unsupported.length + f.uncertain.length, 0);
  const editingResult = editing ? evaluation.facilities.find(result => result.facility.id === editing) : undefined;
  const renderCard = (result: FacilityResult) => <FacilityCard key={result.facility.id} result={result} catalog={catalog} state={state} base={draft} busy={busy}
    onChange={patch => patchFacility(result.facility.id, patch)} onRemove={() => { removeFacility(result.facility.id); setEditing(null); }}
    onAssign={id => assign(result.facility.id, id)} onUnassign={id => unassign(result.facility.id, id)} onSettings={patch => update({ ...draft, ...patch })}/>;

  return <div className="base-page">
    {isDemo && <p className="callout warning">示範庫使用自製的虛構基建技能與數值，只用來體驗操作，不代表遊戲規則。</p>}
    <div className="base-summary">
      <div className="stat"><span className="stat-value">{draft.facilities.length}</span><span className="stat-label">設施<small>最多 20 座</small></span></div>
      <div className={`stat ${consumed > produced ? 'danger' : ''}`}><span className="stat-value">{produced - consumed}</span><span className="stat-label">剩餘電力<small>發電 {produced} · 用電 {consumed}</small></span></div>
      <div className={`stat ${unsupportedTotal ? 'amber' : ''}`}><span className="stat-value">{unsupportedTotal}</span><span className="stat-label">未計入／待核對技能<small>不當作零效果</small></span></div>
      <div className="base-actions">
        <button type="button" className="button ghost small" disabled={busy || !dirty} onClick={() => setDraft(state.settings.base)}>還原</button>
        <button type="button" className="button primary" disabled={busy || !dirty || draft.facilities.length > 20} onClick={() => onSave(draft)}>{dirty ? '保存配置' : '已保存'}</button>
      </div>
    </div>
    {draft.facilities.length > 0 && <BaseStats evaluation={evaluation} catalog={catalog} base={draft} state={state}/>}
    <RecommendPanel state={state} isDemo={isDemo} busy={busy} catalog={catalog} base={draft} onApplyLayout={(facilities, assignments) => update({ ...draft, facilities, assignments })} onApply={(assignments, products) => update({ ...draft, facilities: draft.facilities.map(f => products?.[f.id] ? { ...f, product: products[f.id] } : f), assignments })} onRefreshed={() => setAttempt(value => value + 1)}/>
    {evaluation.issues.length > 0 && <div className="callout danger" role="status"><strong>配置有 {evaluation.issues.length} 個問題</strong><ul>{evaluation.issues.map(issue => <li key={issue}>{issue}</li>)}</ul></div>}
    {!draft.facilities.length && <section className="empty-inline base-empty"><strong>先建立設施配置</strong><span>選一個常見布局作為起點，或逐一新增設施；之後可以再調整等級與數量。</span>
      <div className="inline-actions center">{LAYOUTS.map((template, index) => <button type="button" key={template.label} className="button secondary small" disabled={busy} onClick={() => applyTemplate(index)}>{template.label}</button>)}</div>
    </section>}
    {draft.facilities.length > 0 && <div className="segmented view-switch" role="tablist" aria-label="基建檢視方式">
      <button type="button" role="tab" aria-selected={view === 'map'} className={view === 'map' ? 'active' : ''} onClick={() => setView('map')}>一圖流布局</button>
      <button type="button" role="tab" aria-selected={view === 'list'} className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>列表式布局</button>
      <button type="button" role="tab" aria-selected={view === 'training'} className={view === 'training' ? 'active' : ''} onClick={() => setView('training')}>練卡建議</button>
    </div>}
    {view === 'training' ? <BaseTraining state={state} catalog={catalog} base={draft}/> : view === 'map' ? <BaseMap facilities={evaluation.facilities} definitions={definitions} onOpen={setEditing}/> : <div className="facility-grid">
      {evaluation.facilities.map(result => renderCard(result))}
    </div>}
    {editingResult && <Modal title={editingResult.label} eyebrow="設施設定與進駐" onClose={() => setEditing(null)} footer={<button type="button" className="button primary" onClick={() => setEditing(null)}>完成</button>}>
      {renderCard(editingResult)}
      <p className="fine-print">變更會先留在配置草稿，按頁面上方「保存配置」才寫入本機。</p>
    </Modal>}
    <div className="base-add">
      <select className="filter" aria-label="新增設施種類" value={addType} disabled={busy} onChange={event => setAddType(event.currentTarget.value as FacilityType)}>{TYPES.map(type => <option key={type} value={type}>{FACILITY_LABEL[type]}</option>)}</select>
      <button type="button" className="button secondary" disabled={busy || draft.facilities.length >= 20} onClick={() => update({ ...draft, facilities: [...draft.facilities, addFacility(addType, 1, addType === 'manufacturing' ? 'gold' : undefined)] })}><Icon name="plus" size={16}/>新增設施</button>
      {draft.facilities.length > 0 && <details className="base-templates"><summary className="button ghost small">改用常見布局</summary><div className="inline-actions">{LAYOUTS.map((template, index) => <button type="button" key={template.label} className="button secondary small" disabled={busy} onClick={() => applyTemplate(index)}>{template.label}</button>)}</div><p className="fine-print">套用會取代目前的設施與進駐名單（保存前可按「還原」）。</p></details>}
    </div>
    <details className="panel plain-details base-method"><summary>計算方式與限制</summary>
      <ul className="gap-list">
        <li>設施等級、進駐上限、電力與座數上限取自 {catalog.source}（版本 {catalog.version.slice(0, 12)}）。</li>
        <li>製造站與貿易站每名進駐幹員的基礎加成取自資料表（目前各 {catalog.basicSpeedPercent.MANUFACTURE}%／{catalog.basicSpeedPercent.TRADING}%）。</li>
        <li>技能只計入說明文字完全符合固定句型者（例如「進駐製造站時，生產力+15%」）。依人數、設施數、時間累積、其他幹員或特殊資源變動的技能，一律列為「未計入」，不當作零。</li>
        <li>同設施多名幹員的已計入技能直接相加；說明寫「同種效果取最高」者只取最高值。是否與遊戲內完全一致尚未逐條實測。</li>
        <li>心情消耗與恢復只列出技能數值，不模擬輪班；尚無可追溯的心情公式，因此不提供換班時間與收益排行。</li>
        <li>解鎖依幹員的精英階段與等級；欄位未知時標為「解鎖待核對」，不推論為已解鎖。</li>
      </ul>
    </details>
  </div>;
}

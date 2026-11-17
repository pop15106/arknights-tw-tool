import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Candidate } from '../domain/base';
import type { OperatorDefinition } from '../domain/model';
import { PROFESSIONS } from '../domain/synergy';

const STATE_LABEL: Record<Candidate['state'] | 'other', string> = { ready: '有已解鎖的此設施技能', unknown: '技能解鎖待核對', locked: '技能尚未解鎖', none: '沒有此設施技能', other: '其他' };
const groupOf = (state: Candidate['state']) => state === 'ready' || state === 'unknown' || state === 'none' ? state : state === 'locked' ? 'locked' : 'other';

/**
 * 加入幹員：先按職業、再按分支縮小範圍，也能直接搜尋名字或技能名。
 * 預設只看「有此設施技能」的人，每列顯示技能與已計入的加成，點一下就加入。
 */
export function OperatorPicker({ candidates, definitions, label, disabled, onPick }: {
  candidates: Candidate[]; definitions: ReadonlyMap<string, OperatorDefinition>; label: string; disabled?: boolean; onPick: (operatorId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [profession, setProfession] = useState('');
  const [branch, setBranch] = useState('');
  const hasSkilled = candidates.some(item => item.state === 'ready' || item.state === 'unknown');
  const [skilledOnly, setSkilledOnly] = useState(true);
  const search = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  // 打開時游標進搜尋框；關閉後游標回到「加入幹員」按鈕，鍵盤操作（例如再按 Esc 關閉設定視窗）才接得上。
  useEffect(() => { if (open) search.current?.focus(); else if (wasOpen.current) opener.current?.focus(); wasOpen.current = open; }, [open]);

  const onlySkilled = skilledOnly && hasSkilled;
  // 先套用「只看有技能」與搜尋，職業／分支的數量才會跟著列表變。
  const base = useMemo(() => {
    const q = query.trim().toLowerCase();
    return candidates.filter(item => {
      if (onlySkilled && item.state !== 'ready' && item.state !== 'unknown') return false;
      if (!q) return true;
      const def = definitions.get(item.operatorId);
      return [item.name, item.summary, ...(def?.aliases ?? [])].some(text => text?.toLowerCase().includes(q));
    });
  }, [candidates, definitions, query, onlySkilled]);
  const professionOf = (id: string) => definitions.get(id)?.profession ?? '';
  const professionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of base) counts.set(professionOf(item.operatorId), (counts.get(professionOf(item.operatorId)) ?? 0) + 1);
    return counts;
  }, [base]);
  const inProfession = profession ? base.filter(item => professionOf(item.operatorId) === profession) : base;
  const branchCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (profession) for (const item of inProfession) { const name = definitions.get(item.operatorId)?.branch ?? ''; counts.set(name, (counts.get(name) ?? 0) + 1); }
    // 已選的分支即使目前 0 人也保留，畫面上才看得到篩選條件、也能取消。
    if (branch && !counts.has(branch)) counts.set(branch, 0);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hant'));
  }, [inProfession, profession, branch]);
  const shown = branch ? inProfession.filter(item => definitions.get(item.operatorId)?.branch === branch) : inProfession;
  const groups = (['ready', 'unknown', 'locked', 'none', 'other'] as const).map(key => ({ key, items: shown.filter(item => groupOf(item.state) === key).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'zh-Hant')) })).filter(group => group.items.length);

  const pickProfession = (value: string) => { setProfession(current => current === value ? '' : value); setBranch(''); };
  const close = () => { setOpen(false); setQuery(''); };

  if (!open) return <button ref={opener} type="button" className="button secondary small picker-open" disabled={disabled || !candidates.length} onClick={() => setOpen(true)} aria-label={`加入幹員到${label}`}>
    {candidates.length ? '＋ 加入幹員' : '沒有可加入的幹員'}
  </button>;

  return <div className="operator-picker" role="dialog" aria-label={`加入幹員到${label}`} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
    <div className="picker-top">
      <input ref={search} className="text-input" type="search" placeholder="搜尋名字或技能…" value={query} onInput={event => setQuery(event.currentTarget.value)} aria-label="搜尋幹員"/>
      <button type="button" className="button ghost small" onClick={close}>取消</button>
    </div>
    <div className="picker-chips" role="group" aria-label="職業">
      <button type="button" className={`chip ${profession ? '' : 'active'}`} aria-pressed={!profession} onClick={() => pickProfession('')}>全部 <small>{base.length}</small></button>
      {PROFESSIONS.map(name => {
        const count = professionCounts.get(name) ?? 0;
        return <button key={name} type="button" className={`chip ${profession === name ? 'active' : ''}`} aria-pressed={profession === name} disabled={!count && profession !== name} onClick={() => pickProfession(name)}>{name} <small>{count}</small></button>;
      })}
    </div>
    {profession && (branchCounts.length > 1 || branch) && <div className="picker-chips branch" role="group" aria-label="分支">
      <button type="button" className={`chip small ${branch ? '' : 'active'}`} aria-pressed={!branch} onClick={() => setBranch('')}>全部分支</button>
      {branchCounts.map(([name, count]) => <button key={name} type="button" className={`chip small ${branch === name ? 'active' : ''}`} aria-pressed={branch === name} onClick={() => setBranch(current => current === name ? '' : name)}>{name} <small>{count}</small></button>)}
    </div>}
    {hasSkilled && <label className="checkbox-line picker-toggle"><input type="checkbox" checked={skilledOnly} onChange={event => setSkilledOnly(event.currentTarget.checked)}/><span>只看有此設施技能的幹員</span></label>}
    <div className="picker-list">
      {!groups.length && <p className="fine-print">沒有符合條件的幹員{branch ? `（目前只看「${branch}」分支，可以點「全部分支」）` : profession ? `（目前只看「${profession}」，可以點「全部」）` : onlySkilled ? '，可以取消「只看有此設施技能」再找找' : ''}。</p>}
      {groups.map(group => <section key={group.key}>
        <h4>{STATE_LABEL[group.key]}（{group.items.length}）</h4>
        <ul>{group.items.map(item => {
          const def = definitions.get(item.operatorId);
          return <li key={item.operatorId}><button type="button" className="picker-row" onClick={() => { onPick(item.operatorId); close(); }}>
            <span className="picker-name"><strong>{item.name}</strong><small>{def ? `${def.rarity}★・${def.profession}・${def.branch}` : ''}</small></span>
            <span className="picker-skill">{item.summary || '—'}</span>
            {item.score !== 0 && <span className="picker-score">{item.score > 0 ? '+' : ''}{item.score}</span>}
          </button></li>;
        })}</ul>
      </section>)}
    </div>
  </div>;
}

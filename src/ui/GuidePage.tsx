import { useEffect, useRef, useState } from 'preact/hooks';
import { GUIDE_CAST, GUIDE_HOST, GUIDE_LANGS, GUIDE_STEPS, type GuideLang, type GuideLine, type GuideManifest } from '../catalog/guide';

const SEEN_KEY = 'arknights-tw-guide-seen';
const VOICE_KEY = 'arknights-tw-guide-voice';
const LANG_KEY = 'arknights-tw-guide-lang';
const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* 無法保存時只在本次有效 */ } };
/** 第一次開啟（還沒看過導覽）時，首頁改為導覽頁。 */
export const guideSeen = () => read(SEEN_KEY) === '1';
export const markGuideSeen = () => write(SEEN_KEY, '1');
const SETTINGS_KEY = 'arknights-tw-settings-visited';
/** 還沒去過「設定」時，側欄會有小人指路；去過一次就不再出現。 */
export const settingsVisited = () => read(SETTINGS_KEY) === '1';
export const markSettingsVisited = () => write(SETTINGS_KEY, '1');

/** 只讀一次導覽素材清單（側欄指路小人用，不輪詢）。 */
function useGuideManifest() {
  const [manifest, setManifest] = useState<GuideManifest | null>(null);
  useEffect(() => {
    let active = true;
    fetch('/api/game-data/guide', { credentials: 'omit', redirect: 'error', cache: 'no-store' })
      .then(response => response.ok ? response.json() as Promise<{ data: GuideManifest | null }> : null)
      .then(result => { if (active && result?.data) setManifest(result.data); }, () => { /* 沒有素材就用原創小角色 */ });
    return () => { active = false; };
  }, []);
  return manifest;
}

/** 側欄指路：凱爾希小人指向「設定」，說明第一次要先去更新遊戲資料。 */
export function SettingsHint({ onGo, onDismiss }: { onGo: () => void; onDismiss: () => void }) {
  const manifest = useGuideManifest();
  return <div className="settings-hint" role="note" aria-label="設定頁指引">
    <span className="settings-hint-arrow" aria-hidden="true"/>
    <Chibi charId="char_003_kalts" manifest={manifest} size={84}/>
    <div className="settings-hint-body">
      <p><strong>凱爾希</strong>第一次使用，先到上面的「設定」按「更新遊戲資料」與「同步幹員立繪」，數值和圖片才會是最新的。</p>
      <div className="inline-actions"><button type="button" className="button primary small" onClick={onGo}>帶我去</button><button type="button" className="button ghost small" onClick={onDismiss}>知道了</button></div>
    </div>
  </div>;
}

/** 導覽素材（Q 版小人、語音）的下載狀態；下載在本機資料服務背景執行，這裡輪詢到完成。 */
function useGuideAssets() {
  const [state, setState] = useState<{ running: boolean; error?: string; data: GuideManifest | null } | null>(null);
  const [tick, setTick] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true, timer: number | undefined, failures = 0;
    const load = async () => {
      try {
        const response = await fetch('/api/game-data/guide', { credentials: 'omit', redirect: 'error', cache: 'no-store' });
        if (!response.ok) throw new Error('本機資料服務沒有回應，請用 start.cmd 啟動。');
        const next = await response.json() as { running: boolean; error?: string; data: GuideManifest | null };
        if (!active) return;
        failures = 0; setError(''); setState(next);
        if (next.running) timer = window.setTimeout(() => void load(), 1500);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : '讀取失敗。');
        if (++failures < 5) timer = window.setTimeout(() => void load(), 3000);
        else setState(current => current ? { ...current, running: false } : current);
      }
    };
    void load();
    return () => { active = false; window.clearTimeout(timer); };
  }, [tick]);
  const sync = async (lang: GuideLang) => {
    setError('');
    try {
      const response = await fetch(`/api/game-data/guide-sync?lang=${lang}`, { method: 'POST', headers: { 'X-Game-Data-Sync': '1' }, credentials: 'omit', redirect: 'error', cache: 'no-store' });
      if (!response.ok) throw new Error('無法開始下載，請確認本機資料服務已啟動。');
      setState(current => ({ data: current?.data ?? null, running: true }));
      setTick(value => value + 1);
    } catch (err) { setError(err instanceof Error ? err.message : '無法開始下載。'); }
  };
  return { state, error, sync };
}

/** 還沒下載素材時的原創小角色（純 SVG，會左右輕晃）。 */
function Mascot({ size }: { size: number }) {
  return <svg className="guide-mascot" width={size} height={size} viewBox="0 0 120 120" role="img" aria-label="導覽小助手">
    <ellipse cx="60" cy="110" rx="30" ry="5" fill="rgba(0,0,0,.12)"/>
    <path d="M38 34 L30 6 L50 28 Z" fill="var(--accent, #e8590c)"/><path d="M82 34 L90 6 L70 28 Z" fill="var(--accent, #e8590c)"/>
    <rect x="22" y="26" width="76" height="76" rx="34" fill="var(--surface, #fff8ef)" stroke="var(--ink, #2b2118)" stroke-width="4"/>
    <circle cx="46" cy="64" r="6" fill="var(--ink, #2b2118)"/><circle cx="74" cy="64" r="6" fill="var(--ink, #2b2118)"/>
    <circle cx="48" cy="62" r="2" fill="#fff"/><circle cx="76" cy="62" r="2" fill="#fff"/>
    <path d="M52 78 Q60 85 68 78" fill="none" stroke="var(--ink, #2b2118)" stroke-width="3.5" stroke-linecap="round"/>
    <circle cx="36" cy="76" r="5" fill="rgba(232,89,12,.25)"/><circle cx="84" cy="76" r="5" fill="rgba(232,89,12,.25)"/>
  </svg>;
}

/** 幹員 Q 版小人：有下載就播放透明背景的動畫，否則顯示原創小角色。 */
function Chibi({ charId, manifest, size = 180 }: { charId: string; manifest: GuideManifest | null; size?: number }) {
  const [failed, setFailed] = useState(false);
  const src = manifest?.chibi[charId];
  if (!src || failed) return <div className="guide-chibi" style={{ width: `${size}px`, height: `${Math.round(size * 0.75)}px` }}><Mascot size={size * 0.6}/></div>;
  return <div className="guide-chibi" style={{ width: `${size}px`, height: `${Math.round(size * 0.75)}px` }}>
    <video key={src} src={src} autoplay loop muted playsInline width={size} onError={() => setFailed(true)} aria-label={`${GUIDE_CAST.find(item => item.charId === charId)?.name ?? ''} Q 版動畫`}/>
  </div>;
}

/** 對話框：台詞字幕＋語音按鈕（語音預設關閉，要使用者打開）。 */
function Bubble({ text, line, voiceOn, speaker }: { text: string; line?: GuideLine; voiceOn: boolean; speaker: string }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => () => { audio.current?.pause(); }, []);
  // 關掉「開啟語音」時，正在播放的語音也要停下來。
  useEffect(() => { if (!voiceOn) { audio.current?.pause(); audio.current = null; setPlaying(false); } }, [voiceOn]);
  const play = () => {
    if (!line?.file) return;
    audio.current?.pause();
    const next = new Audio(line.file); audio.current = next;
    setPlaying(true); next.onended = () => setPlaying(false); next.onerror = () => setPlaying(false);
    void next.play().catch(() => setPlaying(false));
  };
  return <div className="guide-bubble">
    <strong>{speaker}</strong>
    <p>{text}</p>
    {line && <p className="guide-quote">「{line.text}」<small>— 遊戲台詞・{line.title}</small></p>}
    {line?.file && voiceOn && <button type="button" className="button ghost small" onClick={play} aria-label={`播放${speaker}語音`}>{playing ? '🔊 播放中' : '🔈 聽語音'}</button>}
  </div>;
}

export function GuidePage({ onNavigate }: { onNavigate: (page: string) => void }) {
  const { state, error, sync } = useGuideAssets();
  const manifest = state?.data ?? null;
  const [step, setStep] = useState(0);
  const [voiceOn, setVoiceOn] = useState(() => read(VOICE_KEY) === '1');
  const [lang, setLang] = useState<GuideLang>(() => (GUIDE_LANGS.some(item => item.id === read(LANG_KEY)) ? read(LANG_KEY) : 'voice') as GuideLang);
  useEffect(() => { markGuideSeen(); }, []);
  const current = GUIDE_STEPS[step];
  const castOf = (charId: string) => GUIDE_CAST.find(item => item.charId === charId)!;
  const lineOf = (charId: string, index = 0) => manifest?.lines[charId]?.[index];
  const host = castOf(GUIDE_HOST);
  return <>
    <section className="panel guide-hero">
      <Chibi charId={current.charId} manifest={manifest} size={220}/>
      <div className="guide-hero-body">
        <p className="eyebrow">新手導覽 {step + 1}／{GUIDE_STEPS.length}</p>
        <h2>{current.title}</h2>
        <Bubble speaker={castOf(current.charId).name} text={current.text} line={step === 0 ? lineOf(GUIDE_HOST) : undefined} voiceOn={voiceOn}/>
        <div className="guide-dots" aria-hidden="true">{GUIDE_STEPS.map((_, index) => <span key={index} className={index === step ? 'active' : ''}/>)}</div>
        <div className="inline-actions">
          <button type="button" className="button secondary small" disabled={step === 0} onClick={() => setStep(value => value - 1)}>上一步</button>
          {step < GUIDE_STEPS.length - 1 ? <button type="button" className="button primary small" onClick={() => setStep(value => value + 1)}>下一步</button>
            : <button type="button" className="button primary small" onClick={() => onNavigate('幹員庫')}>開始使用</button>}
          {current.page && <button type="button" className="button ghost small" onClick={() => onNavigate(current.page!)}>前往「{current.page}」</button>}
          {step < GUIDE_STEPS.length - 1 && <button type="button" className="button ghost small" onClick={() => onNavigate('幹員庫')}>跳過導覽</button>}
        </div>
      </div>
    </section>

    <section className="panel guide-assets">
      <div className="split-heading"><h3>小人動畫與語音</h3>
        <label className="guide-toggle"><input type="checkbox" checked={voiceOn} onChange={event => { const value = event.currentTarget.checked; setVoiceOn(value); write(VOICE_KEY, value ? '1' : '0'); }}/> 開啟語音</label></div>
      <p className="fine-print">Q 版動畫與語音是遊戲素材，不會放進工具裡；按下載時才存到你的電腦（約 {GUIDE_CAST.length} 段動畫＋{GUIDE_CAST.length * 2} 段語音，數 MB）。字幕是繁中服的官方台詞。沒下載時會用原創小角色代替。</p>
      <div className="inline-actions">
        <select className="text-input" value={lang} aria-label="語音語言" onChange={event => { const value = event.currentTarget.value as GuideLang; setLang(value); write(LANG_KEY, value); }}>
          {GUIDE_LANGS.map(item => <option key={item.id} value={item.id}>{item.label}語音</option>)}
        </select>
        <button type="button" className="button secondary small" disabled={state?.running} onClick={() => void sync(lang)}>{state?.running ? '下載中…' : manifest ? '重新下載' : '下載導覽素材'}</button>
        {manifest && <small className="fine-print">已下載：{GUIDE_LANGS.find(item => item.id === manifest.lang)?.label}語音・{Object.keys(manifest.chibi).length} 段動畫</small>}
      </div>
      {(error || state?.error) && <p role="alert" className="toast error">{error || state?.error}</p>}
    </section>

    <section className="panel">
      <h3>功能介紹</h3>
      <div className="guide-grid">{GUIDE_CAST.map(cast => <article key={cast.charId} className="guide-card">
        <Chibi charId={cast.charId} manifest={manifest} size={160}/>
        <div>
          <p className="eyebrow">{cast.feature}</p>
          <Bubble speaker={cast.name} text={cast.pitch} line={lineOf(cast.charId, cast.charId === GUIDE_HOST ? 1 : 0)} voiceOn={voiceOn}/>
          <ul className="gap-list">{cast.points.map(point => <li key={point}>{point}</li>)}</ul>
          <button type="button" className="button secondary small" onClick={() => onNavigate(cast.page)}>前往「{cast.page}」</button>
        </div>
      </article>)}</div>
    </section>

    <section className="panel guide-faq">
      <h3>常見問題</h3>
      <div className="guide-faq-list">
        {[
          ['幹員圖片顯示「圖片暫不可用」？', '到「設定」按「更新遊戲資料」，再按「同步幹員立繪」。'],
          ['我的資料會上傳嗎？', '不會。幹員庫、設定、備份都只存在這台電腦的瀏覽器裡，也不需要登入任何帳號。'],
          ['怎麼收到換班提醒？', '到「基建 → 換班提醒」，可以用瀏覽器通知，或設定 Telegram 推播（關掉網頁也會送，電腦需開著）。'],
          ['換電腦或重灌怎麼辦？', '到「設定」下載備份檔，新電腦再用「從備份復原」匯入。'],
        ].map(([q, a]) => <details key={q} className="plain-details"><summary>{q}</summary><p>{a}</p></details>)}
      </div>
      <p className="fine-print">還有問題的話，{host.name}建議先看看每個頁面上方的說明文字。</p>
    </section>
  </>;
}

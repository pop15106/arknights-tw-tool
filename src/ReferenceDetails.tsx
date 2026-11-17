import { useEffect, useState } from 'preact/hooks';
import type { OperatorDefinition, OwnedOperator } from './domain/model';
import { loadReferenceDataset } from './importers/local-file';
import { OperatorEncyclopedia } from './OperatorEncyclopedia';

export function ReferenceDetails({ definition, row, personal, skin }: { definition: OperatorDefinition; row: OwnedOperator; personal: boolean; skin?: string }) {
  const [reference, setReference] = useState<OperatorDefinition | null>(null);
  const [status, setStatus] = useState(personal ? '正在讀取本機圖鑑…' : '示範資料');
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setReference(null); setFailed(false);
    if (!personal) return;
    let active = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20_000);
    setStatus('正在讀取本機圖鑑…');
    void loadReferenceDataset(fetch, controller.signal).then(dataset => {
      if (!active) return;
      const match = dataset.operators.find(item => item.id === definition.id);
      // 未收錄不是暫時錯誤，重試也不會成功，所以不顯示重新載入按鈕。
      if (!match) { setStatus('本機圖鑑暫未收錄此幹員，先顯示已保存的說明。'); return; }
      setReference(match); setStatus('能力說明使用最新本機圖鑑；瀏覽與切換等級不會更動養成紀錄。');
    }).catch(() => {
      if (active) { setFailed(true); setStatus('暫時無法讀取本機圖鑑，先顯示已保存的說明。可重新載入，或到設定更新遊戲資料。'); }
    }).finally(() => window.clearTimeout(timeout));
    return () => { active = false; window.clearTimeout(timeout); controller.abort(); };
  }, [personal, definition.id, attempt]);
  return <>
    {personal && <p className="fine-print" role="status">{status}{failed && <button type="button" className="button ghost small" onClick={() => setAttempt(value => value + 1)}>重新載入說明</button>}</p>}
    <OperatorEncyclopedia key={`${definition.id}-${reference ? 'reference' : 'saved'}`} definition={reference ?? definition} row={row} skin={skin}/>
  </>;
}

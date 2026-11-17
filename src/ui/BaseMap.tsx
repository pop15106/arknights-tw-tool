import type { OperatorDefinition } from '../domain/model';
import { FACILITY_LABEL, ROOM_OF, type FacilityResult, type FacilityType } from '../domain/base';
import { OperatorPortrait } from '../OperatorEncyclopedia';
import { Icon, type IconName } from './Icon';

// 一圖流：左側為控制中樞與產出設施，右側為功能設施與宿舍，排列方式類似遊戲內基建畫面。
const LEFT: FacilityType[] = ['control', 'trading', 'manufacturing', 'power'];
const ICON: Record<FacilityType, IconName> = { control: 'shield', trading: 'link', manufacturing: 'base', power: 'grow', dormitory: 'moon', meeting: 'roster', office: 'file', training: 'edit', workshop: 'settings' };
const WIDE: ReadonlySet<FacilityType> = new Set(['control', 'dormitory']);
const signed = (value: number, unit = '%') => `${value >= 0 ? '+' : ''}${value}${unit}`;

function metric(result: FacilityResult): string | null {
  const room = ROOM_OF[result.facility.type];
  if (!result.operators.length) return null;
  if (room === 'MANUFACTURE') return `生產力 ${signed(result.totals.basic + result.totals.productivity)}`;
  if (room === 'TRADING') return `訂單效率 ${signed(result.totals.basic + result.totals.order)}`;
  if (room === 'POWER') return `無人機 ${signed(result.totals.drone)}`;
  if (room === 'MEETING' && result.totals.clue) return `線索 +${result.totals.clue}%`;
  if (room === 'HIRE' && result.totals.contact) return `聯絡 +${result.totals.contact}%`;
  if (room === 'TRAINING' && result.totals.training) return `專精訓練 +${result.totals.training}%`;
  if (room === 'WORKSHOP' && result.totals.byproduct) return `副產品 +${result.totals.byproduct}%`;
  if (room === 'DORMITORY') return result.totals.moodRecoverAll ? `全宿舍恢復 ${signed(result.totals.moodRecoverAll, '/時')}` : null;
  return null;
}

function RoomTile({ result, definitions, onOpen }: { result: FacilityResult; definitions: ReadonlyMap<string, OperatorDefinition>; onOpen: () => void }) {
  const { facility, capacity } = result;
  const slots = Math.max(capacity, result.operators.length);
  const pips = result.room?.phases.length ?? facility.level;
  const value = metric(result);
  const problems = result.issues.length;
  const incomplete = result.unsupported.length + result.uncertain.length + result.comboMissing.length;
  return <button type="button" className={`map-room room-${facility.type} ${WIDE.has(facility.type) ? 'wide' : ''}`} onClick={onOpen} aria-label={`編輯${result.label}，進駐 ${result.operators.length}／${capacity}`}>
    <span className="map-room-bg" aria-hidden="true"><Icon name={ICON[facility.type]} size={120}/></span>
    <span className="map-room-head">
      <span className="map-room-name">{result.label}</span>
      <span className="map-pips" aria-label={`${facility.level} 級`}>{Array.from({ length: pips }, (_, index) => <i key={index} className={index < facility.level ? 'on' : ''}/>)}</span>
      {facility.type === 'manufacturing' && facility.product && <span className="map-product">{facility.product === 'gold' ? '赤金' : '作戰記錄'}</span>}
    </span>
    <span className={`map-room-status ${problems ? 'bad' : ''}`}>{problems ? result.issues[0] : value ?? (result.operators.length ? (facility.type === 'dormitory' ? `已進駐 ${result.operators.length} 人（自身恢復不加總）` : facility.type === 'control' ? '中樞效果計入各設施' : `${FACILITY_LABEL[facility.type]}技能不計分`) : '等待排班')}{!problems && incomplete > 0 && <em> · {incomplete} 個未計入</em>}</span>
    <span className="map-slots">{Array.from({ length: slots }, (_, index) => {
      const op = result.operators[index];
      const definition = op && definitions.get(op.operatorId);
      return op ? <span key={index} className={`map-slot filled ${index >= capacity ? 'over' : ''}`} title={op.name}>
        {definition ? <OperatorPortrait definition={definition}/> : null}<span className="map-slot-name">{op.name}</span>
      </span> : <span key={index} className="map-slot empty" aria-hidden="true"/>;
    })}</span>
  </button>;
}

export function BaseMap({ facilities, definitions, onOpen }: { facilities: FacilityResult[]; definitions: ReadonlyMap<string, OperatorDefinition>; onOpen: (facilityId: string) => void }) {
  const left = facilities.filter(result => LEFT.includes(result.facility.type));
  const right = facilities.filter(result => !LEFT.includes(result.facility.type));
  const order = (list: FacilityResult[], types: FacilityType[]) => types.flatMap(type => list.filter(result => result.facility.type === type));
  return <div className="base-map">
    <div className="map-side">{order(left, LEFT).map(result => <RoomTile key={result.facility.id} result={result} definitions={definitions} onOpen={() => onOpen(result.facility.id)}/>)}</div>
    <div className="map-side">{order(right, ['meeting', 'office', 'training', 'workshop', 'dormitory']).map(result => <RoomTile key={result.facility.id} result={result} definitions={definitions} onOpen={() => onOpen(result.facility.id)}/>)}</div>
  </div>;
}

const TYPE_COLOR: Record<FacilityType, string> = { control: '#ff7a3d', trading: '#3d9be9', manufacturing: '#f2b632', power: '#7cc96b', dormitory: '#a98bf0', meeting: '#e0e0e0', office: '#e0e0e0', training: '#e0e0e0', workshop: '#e0e0e0' };
/** 把一圖流畫成 PNG（只用 canvas，不含頭像，方便分享）。 */
export async function mapImage(facilities: FacilityResult[], definitions: ReadonlyMap<string, OperatorDefinition>, title: string): Promise<Blob> {
  const scale = 2, width = 1200, column = (width - 72) / 2;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d')!;
  const font = (size: number, weight = 400) => `${weight} ${size}px "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif`;
  const wrap = (text: string, max: number, size: number) => { context.font = font(size); const lines: string[] = []; let line = ''; for (const part of text.split('、')) { const next = line ? `${line}、${part}` : part; if (context.measureText(next).width > max && line) { lines.push(line); line = part; } else line = next; } if (line) lines.push(line); return lines; };
  const tile = (result: FacilityResult) => { const names = result.operators.map(op => definitions.get(op.operatorId)?.displayName ?? op.name).join('、') || '（空）'; return { result, lines: wrap(names, column - 36, 15) }; };
  const left = LEFT.flatMap(type => facilities.filter(item => item.facility.type === type)).map(tile);
  const right = (['meeting', 'office', 'training', 'workshop', 'dormitory'] as FacilityType[]).flatMap(type => facilities.filter(item => item.facility.type === type)).map(tile);
  const heightOf = (item: ReturnType<typeof tile>) => 62 + item.lines.length * 22;
  const columnHeight = (list: ReturnType<typeof tile>[]) => list.reduce((sum, item) => sum + heightOf(item) + 12, 0);
  const height = 96 + Math.max(columnHeight(left), columnHeight(right)) + 40;
  canvas.width = width * scale; canvas.height = height * scale; context.scale(scale, scale);
  context.fillStyle = '#1f1a17'; context.fillRect(0, 0, width, height);
  context.fillStyle = '#fff'; context.font = font(26, 800); context.fillText(title, 24, 48);
  context.fillStyle = '#a89d94'; context.font = font(13); context.fillText('幹員檔案室・繁中服基建一圖流', 24, 72);
  const draw = (list: ReturnType<typeof tile>[], x: number) => {
    let y = 96;
    for (const item of list) {
      const h = heightOf(item), color = TYPE_COLOR[item.result.facility.type];
      context.fillStyle = '#2b2420'; context.beginPath(); context.roundRect(x, y, column, h, 12); context.fill();
      context.fillStyle = color; context.fillRect(x, y + 10, 4, h - 20);
      context.fillStyle = '#fff'; context.font = font(17, 700); context.fillText(`${item.result.label}・${item.result.facility.level} 級`, x + 18, y + 28);
      const value = metric(item.result); if (value) { context.fillStyle = color; context.font = font(13, 700); context.fillText(value, x + column - 18 - context.measureText(value).width, y + 28); }
      context.fillStyle = '#e8e0d8'; context.font = font(15); item.lines.forEach((line, index) => context.fillText(line, x + 18, y + 54 + index * 22));
      y += h + 12;
    }
  };
  draw(left, 24); draw(right, 48 + column);
  return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('無法產生圖片。')), 'image/png'));
}

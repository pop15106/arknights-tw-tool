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
    <span className={`map-room-status ${problems ? 'bad' : ''}`}>{problems ? result.issues[0] : value ?? (result.operators.length ? (facility.type === 'dormitory' ? `已進駐 ${result.operators.length} 人（自身恢復不加總）` : `${FACILITY_LABEL[facility.type]}技能不計分`) : '等待排班')}{!problems && incomplete > 0 && <em> · {incomplete} 個未計入</em>}</span>
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

import { known, sealDataset, unknown } from './domain/model.ts';
import type { Dataset, ImportDocument, OperatorDefinition } from './domain/model.ts';
import type { BaseCatalog } from './catalog/base.ts';

const DEMO_TIME = '2026-11-13T00:00:00.000Z';
const DEMO_SOURCE = '本工具自製虛構示範；不是遊戲資料';
const NAMES = ['晨訊', '霧航', '岩序', '弦光', '白隙', '墨紋', '青禾', '流砂'];
const PROFESSIONS = ['先鋒', '近衛', '重裝', '狙擊', '醫療', '術師', '輔助', '特種'];

export async function createDemoDataset(): Promise<Dataset> {
  const operators: OperatorDefinition[] = NAMES.map((name, index) => ({
    id: `demo-${index + 1}`,
    displayName: `示範・${name}`,
    aliases: [name],
    rarity: (index % 3 + 4) as 4 | 5 | 6,
    profession: PROFESSIONS[index],
    branch: '虛構測試分支',
    faction: '示範資料集',
    skills: [1, 2].map((n) => ({ id: `demo-${index + 1}-s${n}`, name: `示範技能 ${n}` })),
    modules: [{ id: `demo-${index + 1}-m1`, name: '示範模組', kind: 'DEMO' }],
    availability: 'unknown',
  }));
  return sealDataset({
    metadata: {
      id: 'self-authored-demo', version: '0.1.0', product: 'arknights', server: 'tw',
      namespace: 'demo', validFrom: DEMO_TIME, acquiredAt: DEMO_TIME,
      source: DEMO_SOURCE, licenseStatus: 'self-authored',
    },
    operators,
  });
}

/** 示範庫用的虛構基建資料：數值與技能都是自製測試用，不代表遊戲規則。 */
export function createDemoBaseCatalog(): BaseCatalog {
  const skill = (id: string, name: string, roomType: string, description: string) => ({ id, name, roomType, description });
  const skills = {
    'demo-manu-1': skill('demo-manu-1', '示範・流水線', 'MANUFACTURE', '進駐製造站時，生產力+15%'),
    'demo-manu-2': skill('demo-manu-2', '示範・流水線β', 'MANUFACTURE', '進駐製造站時，生產力+25%'),
    'demo-gold': skill('demo-gold', '示範・精煉', 'MANUFACTURE', '進駐製造站時，貴金屬類配方的生產力+30%'),
    'demo-record': skill('demo-record', '示範・歸檔', 'MANUFACTURE', '進駐製造站時，作戰記錄類配方的生產力+30%'),
    'demo-combo': skill('demo-combo', '示範・協作', 'MANUFACTURE', '進駐製造站時，每有 1 名其他示範幹員，生產力+5%'),
    'demo-trade': skill('demo-trade', '示範・議價', 'TRADING', '進駐貿易站時，訂單獲取效率+30%'),
    'demo-trade-2': skill('demo-trade-2', '示範・長單', 'TRADING', '進駐貿易站時，訂單獲取效率+20%，且訂單上限+2'),
    'demo-power': skill('demo-power', '示範・充能', 'POWER', '進駐發電站時，無人機充能速度+15%'),
    'demo-dorm': skill('demo-dorm', '示範・安眠', 'DORMITORY', '進駐宿舍時，該宿舍內所有幹員的心情每小時恢復+0.2（同種效果取最高）'),
    'demo-ctrl': skill('demo-ctrl', '示範・指揮', 'CONTROL', '進駐控制中樞時，所有製造站生產力+2%（同種效果取最高）'),
  };
  const slot = (...versions: [string, 0 | 1 | 2, number][]) => versions.map(([buffId, elite, level]) => ({ buffId, elite, level }));
  return {
    source: DEMO_SOURCE, version: 'demo-0.1.0',
    rooms: [
      { id: 'CONTROL', name: '控制中樞', maxCount: 1, phases: [1, 2, 3, 4, 5].map(n => ({ maxStationedNum: n, electricity: 0 })) },
      { id: 'POWER', name: '發電站', maxCount: 3, phases: [60, 130, 270].map(electricity => ({ maxStationedNum: 1, electricity })) },
      { id: 'MANUFACTURE', name: '製造站', maxCount: 5, phases: [[1, -10], [2, -30], [3, -60]].map(([maxStationedNum, electricity]) => ({ maxStationedNum, electricity })) },
      { id: 'TRADING', name: '貿易站', maxCount: 5, phases: [[1, -10], [2, -30], [3, -60]].map(([maxStationedNum, electricity]) => ({ maxStationedNum, electricity })) },
      { id: 'DORMITORY', name: '宿舍', maxCount: 4, phases: [-10, -20, -30, -45, -65].map(electricity => ({ maxStationedNum: 5, electricity })) },
      ...(['MEETING', 'HIRE', 'TRAINING', 'WORKSHOP'] as const).map(id => ({ id, name: { MEETING: '會客室', HIRE: '辦公室', TRAINING: '訓練室', WORKSHOP: '加工站' }[id], maxCount: 1, phases: [-10, -30, -60].map(electricity => ({ maxStationedNum: id === 'HIRE' || id === 'WORKSHOP' ? 1 : 2, electricity })) })),
    ],
    basicSpeedPercent: { MANUFACTURE: 1, TRADING: 1 },
    skills,
    operators: {
      'demo-1': [slot(['demo-manu-1', 0, 1], ['demo-manu-2', 2, 1]), slot(['demo-ctrl', 1, 1])],
      'demo-2': [slot(['demo-trade', 0, 1])],
      'demo-3': [slot(['demo-gold', 0, 1]), slot(['demo-combo', 1, 30])],
      'demo-4': [slot(['demo-record', 0, 1])],
      'demo-5': [slot(['demo-dorm', 0, 1])],
      'demo-6': [slot(['demo-power', 0, 1]), slot(['demo-manu-1', 2, 1])],
      'demo-7': [slot(['demo-trade-2', 1, 1])],
      'demo-8': [slot(['demo-manu-1', 0, 1], ['demo-manu-2', 1, 50])],
    },
  };
}

export async function createPersonalDataset(): Promise<Dataset> {
  return sealDataset({
    metadata: {
      id: 'personal-empty', version: '0.1.0', product: 'arknights', server: 'tw',
      namespace: 'personal', validFrom: DEMO_TIME, acquiredAt: DEMO_TIME,
      source: '尚未匯入經核對的資料集', licenseStatus: 'unknown',
    },
    operators: [],
  });
}

export function createDemoImport(dataset: Dataset): ImportDocument {
  return {
    format: 'arknights-roster-import', schemaVersion: 1, product: 'arknights', server: 'tw',
    namespace: 'demo', dataset, completeness: 'partial', source: DEMO_SOURCE,
    adapterVersion: 'demo-1', createdAt: DEMO_TIME,
    candidates: dataset.operators.map((operator, index) => {
      const evidence = (value: number | string | boolean) => known(value, DEMO_SOURCE, {
        importedAt: DEMO_TIME, observedAt: DEMO_TIME, confidence: 1,
      });
      return {
        operatorId: operator.id,
        fields: {
          owned: evidence(true), elite: evidence(index < 5 ? 2 : 1),
          level: evidence([80, 65, 60, 55, 40, 30, 20, 1][index]),
          potential: evidence(index % 6 + 1), trust: evidence(index < 4 ? 200 : 50),
          skillLevel: evidence(index < 5 ? 7 : 4),
          equippedSkill: evidence(operator.skills[0].id),
          equippedModule: unknown(DEMO_SOURCE, DEMO_TIME),
          [`mastery:${operator.skills[0].id}`]: evidence(index < 4 ? 3 : 0),
          [`mastery:${operator.skills[1].id}`]: index % 2 ? unknown(DEMO_SOURCE, DEMO_TIME) : evidence(0),
          [`moduleAvailable:${operator.modules[0].id}`]: unknown(DEMO_SOURCE, DEMO_TIME),
          [`moduleUnlocked:${operator.modules[0].id}`]: index < 3 ? evidence(true) : unknown(DEMO_SOURCE, DEMO_TIME),
          [`moduleLevel:${operator.modules[0].id}`]: index < 3 ? evidence(1) : unknown(DEMO_SOURCE, DEMO_TIME),
        },
      };
    }),
  };
}

import { known, sealDataset, unknown } from './domain/model.ts';
import type { Dataset, ImportDocument, OperatorDefinition } from './domain/model.ts';

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

import { fieldKeys, type OperatorDefinition, type OwnedOperator } from './model.ts';

export interface RosterQuery {
  search?: string;
  profession?: string;
  rarity?: 'all' | OperatorDefinition['rarity'];
  elite?: 'all' | 'unknown' | 0 | 1 | 2;
  status?: 'all' | 'unknown' | 'unverified';
  sort?: 'id' | 'name' | 'rarity' | 'level';
}

interface RosterEntry { row: OwnedOperator; definition: OperatorDefinition }

export function missingCount(row: OwnedOperator, definition: OperatorDefinition): number {
  return fieldKeys(definition).filter(key => !row.fields[key] || row.fields[key].status === 'unknown').length;
}

export function unverifiedCount(row: OwnedOperator, definition: OperatorDefinition): number {
  return fieldKeys(definition).filter(key => {
    const value = row.fields[key];
    return value?.status === 'known' && !value.manuallyConfirmed && value.confidence !== undefined && value.confidence < 0.8;
  }).length;
}

function knownNumber(row: OwnedOperator, field: 'elite' | 'level'): number | undefined {
  const evidence = row.fields[field];
  return evidence?.status === 'known' && typeof evidence.value === 'number' ? evidence.value : undefined;
}

function descendingKnownFirst(left: number | undefined, right: number | undefined): number {
  if (left === undefined) return right === undefined ? 0 : 1;
  if (right === undefined) return -1;
  return right - left;
}

export function queryRoster<T extends RosterEntry>(entries: readonly T[], options: RosterQuery = {}): T[] {
  const { search = '', profession = 'all', rarity = 'all', elite = 'all', status = 'all', sort = 'id' } = options;
  const needle = search.trim().toLowerCase();
  const filtered = entries.filter(({ row, definition }) =>
    (!needle || [definition.displayName, ...definition.aliases, definition.id].some(value => value.toLowerCase().includes(needle)))
    && (profession === 'all' || definition.profession === profession)
    && (rarity === 'all' || definition.rarity === rarity)
    && (elite === 'all' || (elite === 'unknown' ? !row.fields.elite || row.fields.elite.status === 'unknown' : knownNumber(row, 'elite') === elite))
    && (status === 'all' || (status === 'unknown' ? missingCount(row, definition) > 0 : unverifiedCount(row, definition) > 0)),
  );
  return filtered.sort((left, right) => {
    let order = 0;
    if (sort === 'name') order = left.definition.displayName.localeCompare(right.definition.displayName, 'zh-Hant');
    else if (sort === 'rarity') order = right.definition.rarity - left.definition.rarity;
    else if (sort === 'level') order = descendingKnownFirst(knownNumber(left.row, 'elite'), knownNumber(right.row, 'elite'))
      || descendingKnownFirst(knownNumber(left.row, 'level'), knownNumber(right.row, 'level'));
    return order || (left.row.operatorId < right.row.operatorId ? -1 : left.row.operatorId > right.row.operatorId ? 1 : 0);
  });
}

function board(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return Object.fromEntries(value.map(entry => [String(entry.key).toLowerCase(), entry.value]));
  return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key.toLowerCase(), item])) : {};
}

// 僅輸出純文字；沒有可核對數值的參數明示缺漏，不推算遊戲效果。
export function renderGameText(value: unknown, blackboard: unknown): string {
  const parameters = board(blackboard);
  return String(value ?? '').replace(/<[^>]*>/gu, '').replace(/\{(-?)([^{}:]+)(?::([^{}]+))?\}/gu, (_whole, negative: string, key: string, format: string | undefined) => {
    const raw = parameters[key.toLowerCase()];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return '〔數值待核對〕';
    const percent = format?.endsWith('%') ?? false;
    const value = raw * (negative ? -1 : 1) * (percent ? 100 : 1);
    const places = format?.match(/\.(0+)/u)?.[1].length ?? (format ? 0 : 3);
    return `${Number(value.toFixed(Math.min(places, 6)))}${percent ? '%' : ''}`;
  }).replace(/\r\n?/gu, '\n').trim();
}

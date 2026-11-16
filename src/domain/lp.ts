/* ------------------------------------------------------------------ */
/* 小型線性規劃：min cᵀx，Ax ≥ b，x ≥ 0。兩階段單形法。                     */
/* 進基變數用 Dantzig 規則（縮減成本最負者）；連續退化時改用 Bland 規則避免循環。 */
/* ------------------------------------------------------------------ */
export interface LpResult { status: 'optimal' | 'infeasible' | 'unbounded' | 'iteration-limit'; x: number[]; value: number }

export function solveMin(c: number[], A: number[][], b: number[], maxIterations = 200000): LpResult {
  const m = A.length, n = c.length, eps = 1e-9;
  const cols = n + 2 * m; // 原變數、剩餘變數（Ax − s = b）、人工變數
  const T: number[][] = A.map((row, i) => {
    const sign = b[i] < 0 ? -1 : 1;
    const line = new Array(cols + 1).fill(0);
    for (let j = 0; j < n; j++) line[j] = sign * (row[j] ?? 0);
    line[n + i] = -sign; line[n + m + i] = 1; line[cols] = sign * b[i];
    return line;
  });
  const basis = Array.from({ length: m }, (_, i) => n + m + i);
  let z: number[] = [];
  const pivot = (row: number, col: number) => {
    const p = T[row][col];
    for (let j = 0; j <= cols; j++) T[row][j] /= p;
    for (let i = 0; i < m; i++) if (i !== row && Math.abs(T[i][col]) > eps) { const f = T[i][col]; for (let j = 0; j <= cols; j++) T[i][j] -= f * T[row][j]; }
    if (Math.abs(z[col]) > eps) { const f = z[col]; for (let j = 0; j <= cols; j++) z[j] -= f * T[row][j]; }
    basis[row] = col;
  };
  /** 以成本向量建立縮減成本列（最後一格為 −目標值）。 */
  const setCost = (cost: number[]) => {
    z = [...cost, 0];
    for (let i = 0; i < m; i++) { const f = cost[basis[i]]; if (f) for (let j = 0; j <= cols; j++) z[j] -= f * T[i][j]; }
  };
  const run = (allowed: number): 'optimal' | 'unbounded' | 'iteration-limit' => {
    let stall = 0, last = Infinity;
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const bland = stall > 50;
      let enter = -1, most = -eps;
      for (let j = 0; j < allowed; j++) {
        if (z[j] < most) { enter = j; if (bland) break; most = z[j]; }
      }
      if (enter < 0) return 'optimal';
      let leave = -1, best = Infinity;
      for (let i = 0; i < m; i++) if (T[i][enter] > eps) { const ratio = T[i][cols] / T[i][enter]; if (ratio < best - eps || (Math.abs(ratio - best) <= eps && leave >= 0 && basis[i] < basis[leave])) { best = ratio; leave = i; } }
      if (leave < 0) return 'unbounded';
      pivot(leave, enter);
      const objective = -z[cols];
      if (objective < last - 1e-12) { last = objective; stall = 0; } else stall++;
    }
    return 'iteration-limit';
  };
  const phase1 = new Array(cols).fill(0); for (let i = 0; i < m; i++) phase1[n + m + i] = 1;
  setCost(phase1);
  if (run(cols) === 'iteration-limit') return { status: 'iteration-limit', x: new Array(n).fill(0), value: Infinity };
  const infeasibility = basis.reduce((sum, col, i) => sum + (col >= n + m ? T[i][cols] : 0), 0);
  if (infeasibility > 1e-6) return { status: 'infeasible', x: new Array(n).fill(0), value: Infinity };
  // 值為 0 的人工變數若仍在基底，換成任一非人工欄。
  for (let i = 0; i < m; i++) if (basis[i] >= n + m) { const col = Array.from({ length: n + m }, (_, j) => j).find(j => Math.abs(T[i][j]) > eps); if (col !== undefined) pivot(i, col); }
  const phase2 = new Array(cols).fill(0); for (let j = 0; j < n; j++) phase2[j] = c[j];
  setCost(phase2);
  const status = run(n + m);
  if (status !== 'optimal') return { status, x: new Array(n).fill(0), value: status === 'unbounded' ? -Infinity : Infinity };
  const x = new Array(n).fill(0);
  for (let i = 0; i < m; i++) if (basis[i] < n) x[basis[i]] = T[i][cols];
  return { status: 'optimal', x, value: x.reduce((sum, value, j) => sum + value * c[j], 0) };
}

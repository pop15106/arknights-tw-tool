import test from 'node:test';
import assert from 'node:assert/strict';
import { solveMin } from '../src/domain/lp.ts';

test('線性規劃：教科書例題與不可行', () => {
  // min 2x + 3y, x + y ≥ 4, x + 3y ≥ 6 → x=3, y=1, 值 9
  const r = solveMin([2, 3], [[1, 1], [1, 3]], [4, 6]);
  assert.equal(r.status, 'optimal');
  assert.ok(Math.abs(r.x[0] - 3) < 1e-6 && Math.abs(r.x[1] - 1) < 1e-6);
  assert.ok(Math.abs(r.value - 9) < 1e-6);
  // 一關同時掉 A、B：比分別刷便宜
  const s = solveMin([10, 6, 6], [[1, 1, 0], [1, 0, 1]], [5, 5]);
  assert.ok(Math.abs(s.value - 50) < 1e-6);
  assert.equal(solveMin([1], [[0]], [1]).status, 'infeasible');
});

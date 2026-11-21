#!/usr/bin/env node
/**
 * 实验室数据口径自检
 *
 *   node scripts/verify-lab.mjs
 *
 * 校验的不是「页面能不能开」，而是「数字算得对不对」：
 *   1. 无前视：第 i 期的视图必须恰好包含 i 期历史，且最后一项是第 i-1 期
 *   2. 期望与方差：超几何公式 vs 蒙特卡洛抽样
 *   3. 正态近似：phi(1.959964) 应 ≈ 0.975，双侧 p ≈ 0.05
 *   4. 策略合法性：每个策略输出的号码数量、范围、去重
 *   5. 合成一致性：lab.json 的推荐号必须来自 committee 排名，票数不越界
 *   6. 缩水覆盖：多注合法、不重复、覆盖率高于「全押最高分」
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const S = require(resolve(ROOT, 'assets/strategies.js'));
const Lab = require(resolve(ROOT, 'assets/lab.js'));
const P = require(resolve(ROOT, 'assets/portfolio.js'));
const Core = require(resolve(ROOT, 'assets/core.js'));

const history = JSON.parse(readFileSync(resolve(ROOT, 'data/history.json'), 'utf8'));
const lab = JSON.parse(readFileSync(resolve(ROOT, 'data/lab.json'), 'utf8'));

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log('  ✓', name);
  } else {
    fail++;
    console.log('  ✗', name, detail === undefined ? '' : '→', JSON.stringify(detail));
  }
}

console.log('\n[1] 无前视校验');
for (const key of ['ssq', 'dlt', 'fc3d', 'kl8', 'pl5']) {
  const meta = Core.GAMES[key];
  for (const zone of meta.ticketZones) {
    const draws = history[key].draws;
    let ok = true;
    let bad = null;
    for (let i = 1; i < draws.length; i += 7) {
      const v = S.view(draws, key, zone, meta[zone], i);
      const prevLast = draws[i - 1][zone];
      if (v.seqs.length !== i) { ok = false; bad = { i, len: v.seqs.length }; break; }
      if (JSON.stringify(v.seqs[i - 1]) !== JSON.stringify(prevLast)) { ok = false; bad = { i, tail: v.seqs[i - 1] }; break; }
      /* seqs 长度恰好为 i，说明只包含 0..i-1；再确认倒数第二期也对齐 */
      if (i >= 2 && JSON.stringify(v.seqs[i - 2]) !== JSON.stringify(draws[i - 2][zone])) {
        ok = false; bad = { i, penultimate: v.seqs[i - 2] }; break;
      }
    }
    check(`${key}/${zone} 视图只含当期之前数据`, ok, bad);
  }
}

console.log('\n[2] 超几何期望与方差 vs 蒙特卡洛');
function sample(pool, k) {
  const a = pool.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}
function mc(cfg, drawPick, trials) {
  const pool = [];
  for (let n = cfg.min; n <= cfg.max; n++) pool.push(n);
  let sum = 0, sumSq = 0;
  for (let t = 0; t < trials; t++) {
    /* 开奖与选号是两次独立抽样，允许重叠——它们本来就是两个独立事件 */
    const actual = new Set(sample(pool, drawPick));
    const picked = sample(pool, cfg.pick);
    let hit = 0;
    for (const p of picked) if (actual.has(p)) hit++;
    sum += hit;
    sumSq += hit * hit;
  }
  const mean = sum / trials;
  return { mean, variance: sumSq / trials - mean * mean };
}
for (const [key, zone] of [['ssq', 'front'], ['dlt', 'front'], ['kl8', 'main'], ['fc3d', 'hundreds']]) {
  const cfg = Core.GAMES[key][zone];
  const dp = cfg.drawPick || cfg.pick;
  const exact = S.expected(cfg, dp);
  const sim = mc(cfg, dp, 40000);
  const okE = Math.abs(sim.mean - exact.expected) < 0.05;
  const okV = Math.abs(sim.variance - exact.variance) < 0.06;
  check(`${key}/${zone} 期望 ${exact.expected.toFixed(4)} vs 模拟 ${sim.mean.toFixed(4)}`, okE);
  check(`${key}/${zone} 方差 ${exact.variance.toFixed(4)} vs 模拟 ${sim.variance.toFixed(4)}`, okV);
}

console.log('\n[3] 正态近似');
const p05 = Lab.stats.twoSidedP(1.959964);
check('z=1.959964 的双侧 p ≈ 0.05', Math.abs(p05 - 0.05) < 0.0005, p05);
const pZero = Lab.stats.twoSidedP(0);
check('z=0 的双侧 p ≈ 1', Math.abs(pZero - 1) < 1e-6, pZero);
check('phi 单调性', Lab.stats.phi(-2) < Lab.stats.phi(0) && Lab.stats.phi(0) < Lab.stats.phi(2));

console.log('\n[4] 策略输出合法性');
for (const key of ['ssq', 'dlt', 'fc3d', 'kl8', 'pl5']) {
  const meta = Core.GAMES[key];
  const draws = history[key].draws;
  for (const zone of meta.ticketZones) {
    const cfg = meta[zone];
    const list = S.forZone(key, zone, cfg);
    const v = S.view(draws, key, zone, cfg, draws.length, 'test');
    const runs = S.runAll(list, v);
    let ok = true;
    let bad = null;
    for (const r of runs) {
      const uniq = new Set(r.numbers);
      if (uniq.size !== cfg.pick) { ok = false; bad = { id: r.strategy, n: r.numbers.length }; break; }
      if (r.numbers.some((n) => !Number.isInteger(n) || n < cfg.min || n > cfg.max)) {
        ok = false; bad = { id: r.strategy, numbers: r.numbers }; break;
      }
    }
    check(`${key}/${zone} ${runs.length} 个策略输出 ${cfg.pick} 个合法不重号`, ok, bad);
  }
}

console.log('\n[5] lab.json 与历史数据一致性');
for (const [key, g] of Object.entries(lab.games)) {
  const last = history[key].draws[history[key].draws.length - 1];
  check(`${key} lastIssue 与历史最新一致`, g.lastIssue === String(last.issue), { lab: g.lastIssue, history: last.issue });
  check(`${key} drawCount 一致`, g.drawCount === history[key].draws.length);
  for (const [zone, z] of Object.entries(g.zones)) {
    const cfg = Core.GAMES[key][zone];
    check(`${key}/${zone} 推荐号数量正确`, z.committee.numbers.length === cfg.pick);
    check(`${key}/${zone} 推荐号都在委员会前列`, z.committee.numbers.every((n) => z.committee.ranking.indexOf(n) !== -1));
    check(`${key}/${zone} 前视审计通过`, z.audit.ok === true);
    check(`${key}/${zone} 期望值与公式一致`, Math.abs(z.expected - S.expected(cfg, cfg.drawPick || cfg.pick).expected) < 1e-4);
    if (z.tickets) {
      let ok = true;
      for (const t of z.tickets) {
        if (t.length !== cfg.pick) ok = false;
        if (new Set(t).size !== t.length) ok = false;
        if (t.some((n) => n < cfg.min || n > cfg.max)) ok = false;
      }
      check(`${key}/${zone} 缩水多注合法`, ok);
      check(`${key}/${zone} 缩水覆盖 ≥ 单注`, z.coverage.coveredNumbers >= cfg.pick, z.coverage);
    }
  }
}

console.log('\n[6] 缩水覆盖确实高于「全押最高分」');
for (const [key, zone] of [['ssq', 'front'], ['dlt', 'front'], ['kl8', 'main']]) {
  const cfg = Core.GAMES[key][zone];
  const scores = {};
  for (let n = cfg.min; n <= cfg.max; n++) scores[n] = Math.sin(n * 1.7);
  const cmp = P.compare(cfg, scores, 5);
  check(`${key}/${zone} 缩水覆盖 ${cmp.spread.coverage.coveredNumbers} > 朴素 ${cmp.naive.coverage.coveredNumbers}`,
    cmp.spread.coverage.coveredNumbers > cmp.naive.coverage.coveredNumbers);
  check(`${key}/${zone} 缩水注间重合更低`, cmp.spread.coverage.avgOverlap < cmp.naive.coverage.avgOverlap);
}

console.log('\n[7] 位置型多注');
for (const [key, m] of [['fc3d', 3], ['pl5', 5]]) {
  const g = lab.games[key];
  const ok = g.tickets && g.tickets.length > 0 && g.tickets.every((t) => t.length === m && t.every((n) => n >= 0 && n <= 9));
  check(`${key} 多注每注 ${m} 位、每位 0–9`, ok, g.tickets);
  const uniq = new Set(g.tickets.map((t) => t.join(',')));
  check(`${key} 多注不重复`, uniq.size === g.tickets.length);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) process.exitCode = 1;

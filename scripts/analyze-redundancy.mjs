#!/usr/bin/env node
/**
 * 公式冗余诊断
 *
 *   node scripts/analyze-redundancy.mjs [--threshold=0.75] [--zones=ssq/front,dlt/front]
 *
 * 做什么：
 *   1. 对每个彩种/位置，逐期回测每个公式实际推荐的号码
 *   2. 两两计算「推荐同一号码的比例」（一致率）
 *   3. 一致率超过阈值的公式用并查集聚成一簇 —— 这些就是冗余公式
 *   4. 每簇给出：成员、各自命中率、簇内平均命中率
 *
 * 输出 data/redundancy.json，供后续生成精简黑名单。
 *
 * 注意：单号公式命中 33 选 6 号池的理论值就是 6/33≈18.2%，
 * 所有公式的命中率差异基本是噪音，因此「保留最优」会过拟合。
 * 本脚本同时给出「最接近簇中位数」的代表，供人工取舍。
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const Core = require(resolve(ROOT, 'assets/core.js'));
const F = require(resolve(ROOT, 'assets/formulas.js'));
const KL8 = require(resolve(ROOT, 'assets/formulas-kl8.js'));
const SSQ = require(resolve(ROOT, 'assets/formulas-ssq.js'));
const DLT = require(resolve(ROOT, 'assets/formulas-dlt.js'));
const DIGIT = require(resolve(ROOT, 'assets/formulas-digit.js'));
const SSQF = require(resolve(ROOT, 'assets/formulas-ssq-full.js'));
const DLTF = require(resolve(ROOT, 'assets/formulas-dlt-full.js'));
const EXTRA = require(resolve(ROOT, 'assets/formulas-extra.js'));

const history = JSON.parse(readFileSync(resolve(ROOT, 'data/history.json'), 'utf8'));
const BLACKLIST = (() => {
  try { return JSON.parse(readFileSync(resolve(ROOT, 'data/formula-blacklist.json'), 'utf8')); } catch { return {}; }
})();

const args = process.argv.slice(2);
function arg(name, dflt) {
  const hit = args.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.split('=')[1] : dflt;
}
const THRESHOLD = Number(arg('threshold', 0.75));
const ZONES = String(arg('zones', 'ssq/front,dlt/front,fc3d/hundreds,kl8/main')).split(',');

function dropSet(key, zone) {
  const gb = BLACKLIST[key] || {};
  const ids = gb[zone] || [];
  const legacy = zone === 'front' ? (BLACKLIST.front || []) : (zone === 'back' ? (BLACKLIST.back || []) : []);
  return new Set([...ids, ...legacy]);
}

function rawFormulas(key, zone) {
  let base = [], extra = [];
  if (key === 'kl8') {
    base = KL8.all;
  } else if (key === 'ssq') {
    base = zone === 'front' ? SSQF.front.slice() : zone === 'back' ? SSQF.back.slice() : F.digit.slice();
    if (zone === 'front') extra = SSQ.front;
    else if (zone === 'back') extra = SSQ.back;
    if (EXTRA && EXTRA.ssq) extra = extra.concat(zone === 'front' ? EXTRA.ssq.front : EXTRA.ssq.back);
  } else if (key === 'dlt') {
    base = zone === 'front' ? DLTF.front.slice() : zone === 'back' ? DLTF.back.slice() : F.digit.slice();
    if (zone === 'front') extra = DLT.front;
    else if (zone === 'back') extra = DLT.back;
    if (EXTRA && EXTRA.dlt) extra = extra.concat(zone === 'front' ? EXTRA.dlt.front : EXTRA.dlt.back);
  } else if (key === 'fc3d' || key === 'pl5') {
    const D = key === 'fc3d' ? DIGIT.fc3d : DIGIT.pl5;
    const bz = D && D.byZone ? D.byZone[zone] : null;
    base = bz && bz.length ? bz : F.digit.slice();
  } else {
    base = (zone === 'front' || zone === 'back') ? F[zone].slice() : F.digit.slice();
  }
  return base.concat(extra);
}

function formulasFor(key, zone) {
  const drop = dropSet(key, zone);
  return rawFormulas(key, zone).filter((f) => !drop.has(f.id));
}

/* ---------- 并查集 ---------- */
class DSU {
  constructor(n) { this.p = Array.from({ length: n }, (_, i) => i); }
  find(x) { while (this.p[x] !== x) { this.p[x] = this.p[this.p[x]]; x = this.p[x]; } return x; }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p[rb] = ra; }
}

function analyzeZone(key, zone, threshold) {
  const cfg = Core.GAMES[key][zone];
  const draws = history[key].draws;
  const list = formulasFor(key, zone);
  const start = 40;
  const series = list.map(() => []);
  const hits = list.map(() => 0);
  const t0 = Date.now();

  for (let i = start; i < draws.length; i++) {
    const ctx = Core.makeCtx(draws.slice(0, i), cfg, zone);
    const actual = new Set(draws[i][zone] || []);
    for (let j = 0; j < list.length; j++) {
      const rec = Core.safeRun(list[j], ctx);
      series[j].push(rec);
      if (actual.has(rec)) hits[j]++;
    }
  }

  const n = draws.length - start;
  const rates = hits.map((h) => h / n);

  const dsu = new DSU(list.length);
  const edges = [];
  for (let a = 0; a < list.length; a++) {
    for (let b = a + 1; b < list.length; b++) {
      let same = 0;
      for (let t = 0; t < n; t++) if (series[a][t] === series[b][t]) same++;
      const r = same / n;
      if (r >= threshold) {
        dsu.union(a, b);
        edges.push([a, b, +r.toFixed(3)]);
      }
    }
  }

  const groups = new Map();
  for (let i = 0; i < list.length; i++) {
    const root = dsu.find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }

  const clusters = [...groups.values()].map((idxs) => {
    const members = idxs.map((i) => ({
      id: list[i].id,
      name: list[i].name,
      cat: list[i].cat,
      rate: +rates[i].toFixed(4)
    }));
    const meanRate = members.reduce((s, m) => s + m.rate, 0) / members.length;
    const sorted = members.slice().sort((x, y) => x.rate - y.rate);
    const medianRate = sorted[Math.floor(sorted.length / 2)].rate;
    const best = members.slice().sort((x, y) => y.rate - x.rate)[0];
    const median = members.slice().sort((x, y) => Math.abs(x.rate - meanRate) - Math.abs(y.rate - meanRate))[0];
    return {
      size: members.length,
      meanRate: +meanRate.toFixed(4),
      medianRate,
      best,
      medianRep: median,
      members: members.sort((x, y) => y.rate - x.rate)
    };
  }).sort((a, b) => b.size - a.size);

  /* ---------- 精简：每簇最多保留 3 个「彼此差异最大」的代表 ---------- */
  function agreementOf(a, b) {
    let c = 0;
    for (let t = 0; t < n; t++) if (series[a][t] === series[b][t]) c++;
    return c / n;
  }
  const keptIdx = new Set();
  const dropIds = [];
  for (const idxs of groups.values()) {
    if (idxs.length <= 2) { idxs.forEach((i) => keptIdx.add(i)); continue; }
    const meanRate = idxs.reduce((s, i) => s + rates[i], 0) / idxs.length;
    /* 第一个代表：命中率最接近簇均值（避免挑「事后最优」而过拟合） */
    const keep = [idxs.slice().sort((a, b) => Math.abs(rates[a] - meanRate) - Math.abs(rates[b] - meanRate))[0]];
    /* 第二个代表：与第一个推荐序列差异最大 */
    if (idxs.length >= 4) {
      let bestJ = -1, bestAg = 2;
      for (const j of idxs) {
        if (keep.includes(j)) continue;
        const ag = agreementOf(keep[0], j);
        if (ag < bestAg) { bestAg = ag; bestJ = j; }
      }
      if (bestJ >= 0) keep.push(bestJ);
    }
    /* 第三个代表：与已选代表平均差异最大，只对 8 个以上的大簇 */
    if (idxs.length >= 8) {
      let bestJ = -1, bestAvg = 2;
      for (const j of idxs) {
        if (keep.includes(j)) continue;
        const avg = keep.reduce((s, k) => s + agreementOf(k, j), 0) / keep.length;
        if (avg < bestAvg) { bestAvg = avg; bestJ = j; }
      }
      if (bestJ >= 0) keep.push(bestJ);
    }
    for (const i of idxs) {
      if (keep.includes(i)) keptIdx.add(i);
      else dropIds.push(list[i].id);
    }
  }

  const redundant = clusters.filter((c) => c.size > 1);
  const removed = list.length - clusters.length;

  return {
    key, zone,
    pool: cfg.max - cfg.min + 1,
    pick: cfg.pick,
    drawPick: cfg.drawPick || cfg.pick,
    formulas: list.length,
    periods: n,
    elapsedMs: Date.now() - t0,
    threshold,
    clusters: clusters.length,
    redundantClusters: redundant.length,
    removable: removed,
    removablePct: +(removed / list.length).toFixed(3),
    pruneDrop: dropIds,
    pruneKeep: [...keptIdx].map((i) => list[i].id),
    rateStats: {
      mean: +(rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(4),
      min: +Math.min(...rates).toFixed(4),
      max: +Math.max(...rates).toFixed(4),
      expected: +(cfg.pick / (cfg.max - cfg.min + 1) * (cfg.drawPick || cfg.pick) / cfg.pick).toFixed(4)
    },
    topClusters: redundant.slice(0, 12).map((c) => ({
      size: c.size,
      meanRate: c.meanRate,
      sample: c.members.slice(0, 8).map((m) => `${m.id} ${m.name}`)
    })),
    clusterDetail: redundant.map((c) => ({
      size: c.size,
      meanRate: c.meanRate,
      medianRep: c.medianRep.id,
      best: c.best.id,
      members: c.members.map((m) => m.id)
    }))
  };
}

console.log(`阈值 ${THRESHOLD}，位置：${ZONES.join(', ')}`);
const out = { generatedAt: new Date().toISOString(), threshold: THRESHOLD, zones: {} };

for (const spec of ZONES) {
  const [key, zone] = spec.split('/');
  if (!Core.GAMES[key] || !Core.GAMES[key][zone]) {
    console.log('跳过未知位置', spec);
    continue;
  }
  const r = analyzeZone(key, zone, THRESHOLD);
  out.zones[spec] = r;
  console.log(
    `\n${key}/${zone}: ${r.formulas} 公式 / ${r.periods} 期 / ${r.elapsedMs}ms`,
    `\n  聚成 ${r.clusters} 簇，可去重 ${r.removable} 个（${(r.removablePct * 100).toFixed(1)}%）`,
    `\n  单号命中率 均值 ${r.rateStats.mean}，区间 ${r.rateStats.min} ~ ${r.rateStats.max}，理论 ${r.rateStats.expected}`
  );
  for (const c of r.topClusters.slice(0, 6)) {
    console.log(`   · ${c.size} 个同质（均值 ${c.meanRate}）：${c.sample.slice(0, 5).join(' / ')}`);
  }
}

const target = resolve(ROOT, 'data/redundancy.json');
writeFileSync(target, JSON.stringify(out), 'utf8');
console.log('\n写入', target);

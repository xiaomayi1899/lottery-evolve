#!/usr/bin/env node
/**
 * 方法验证器（照妖镜）
 *
 *   node scripts/verify-method.mjs [--train=200] [--key=ssq] [--zone=front]
 *
 * 任何「选号方法」都可以接入：只要实现 `pick(history, cfg, zone) -> [号码]`。
 * 本脚本用严格样本外的方式评估：
 *   - 训练段：第 40 → train 期
 *   - 测试段：第 train → 最后一期（方法只能用测试段之前的数据）
 *
 * 内置方法：
 *   random     纯随机（对照）
 *   hot30      近 30 期热号（最简单基线）
 *   logistic   逻辑回归（7 维特征，批量梯度下降）
 *   knn        相似期匹配（最近 5 期状态向量，余弦相似度）
 *   genetic    遗传算法优化 124 个公式的权重
 *
 * 判定：输出命中率、相对随机的 z 值、以及 2000 次随机模拟的分位。
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const Core = require(resolve(ROOT, 'assets/core.js'));
const F = require(resolve(ROOT, 'assets/formulas.js'));
const SSQ = require(resolve(ROOT, 'assets/formulas-ssq.js'));
const SSQF = require(resolve(ROOT, 'assets/formulas-ssq-full.js'));
const EXTRA = require(resolve(ROOT, 'assets/formulas-extra.js'));

const history = JSON.parse(readFileSync(resolve(ROOT, 'data/history.json'), 'utf8'));
const BLACKLIST = JSON.parse(readFileSync(resolve(ROOT, 'data/formula-blacklist.json'), 'utf8'));

const args = process.argv.slice(2);
const arg = (n, d) => {
  const h = args.find((a) => a.startsWith('--' + n + '='));
  return h ? h.split('=')[1] : d;
};
const TRAIN = Number(arg('train', 200));
const KEY = arg('key', 'ssq');
const ZONE = arg('zone', 'front');
const draws = history[KEY].draws;
const cfg = Core.GAMES[KEY][ZONE];
const POOL = cfg.max - cfg.min + 1;
const RANDOM_HITS = (cfg.pick * cfg.pick) / POOL; /* 每注平均命中个数 */

function candidates() {
  const out = [];
  for (let n = cfg.min; n <= cfg.max; n++) out.push(n);
  return out;
}

function formulas() {
  const drop = new Set([...(BLACKLIST[KEY] && BLACKLIST[KEY][ZONE] || [])]);
  return SSQF.front.concat(SSQ.front).concat(EXTRA.ssq.front).filter((f) => !drop.has(f.id));
}

function overlap(a, b) {
  const s = new Set(b);
  return a.reduce((c, n) => c + (s.has(n) ? 1 : 0), 0);
}

/* ---------------- 特征 ---------------- */
function features(hist, n) {
  const seqs = hist.map((d) => d[ZONE]);
  const last = seqs[seqs.length - 1] || [];
  const count = (w) => {
    let c = 0;
    for (let i = Math.max(0, seqs.length - w); i < seqs.length; i++) if (seqs[i].indexOf(n) !== -1) c++;
    return c;
  };
  let omission = 0;
  for (let i = seqs.length - 1; i >= 0; i--) {
    if (seqs[i].indexOf(n) !== -1) break;
    omission++;
  }
  let tailCount = 0;
  for (let i = Math.max(0, seqs.length - 20); i < seqs.length; i++) {
    for (const m of seqs[i]) if (m % 10 === n % 10) tailCount++;
  }
  return [
    count(5) / 5,
    count(10) / 10,
    count(30) / 30,
    Math.min(1, omission / 30),
    last.indexOf(n) !== -1 ? 1 : 0,
    tailCount / 60,
    (n - cfg.min) / (POOL - 1)
  ];
}

function standardize(rows) {
  const d = rows[0].length;
  const mean = new Array(d).fill(0), sd = new Array(d).fill(0);
  for (const r of rows) for (let j = 0; j < d; j++) mean[j] += r[j] / rows.length;
  for (const r of rows) for (let j = 0; j < d; j++) sd[j] += (r[j] - mean[j]) ** 2 / rows.length;
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  return { mean, sd, apply: (r) => r.map((v, j) => (v - mean[j]) / sd[j]) };
}

/* ---------------- 方法 ---------------- */
const METHODS = {};

METHODS.random = {
  name: '纯随机',
  pick(hist) {
    const a = candidates();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a.slice(0, cfg.pick);
  }
};

METHODS.hot30 = {
  name: '近 30 期热号',
  pick(hist) {
    const seqs = hist.map((d) => d[ZONE]);
    const cnt = {};
    for (const arr of seqs.slice(-30)) for (const n of arr) cnt[n] = (cnt[n] || 0) + 1;
    return candidates().sort((a, b) => (cnt[b] || 0) - (cnt[a] || 0) || a - b).slice(0, cfg.pick);
  }
};

METHODS.logistic = (() => {
  let model = null;
  return {
    name: '逻辑回归',
    train(hist) {
      const rows = [], labels = [];
      const from = 40;
      for (let i = from; i < hist.length; i++) {
        const sub = hist.slice(0, i);
        const actual = new Set(hist[i][ZONE]);
        for (const n of candidates()) {
          rows.push(features(sub, n));
          labels.push(actual.has(n) ? 1 : 0);
        }
      }
      const norm = standardize(rows);
      const X = rows.map(norm.apply);
      const d = X[0].length;
      let w = new Array(d).fill(0), b = 0;
      const lr = 0.35, epochs = 250;
      for (let e = 0; e < epochs; e++) {
        const gw = new Array(d).fill(0);
        let gb = 0;
        for (let s = 0; s < X.length; s++) {
          let z = b;
          for (let j = 0; j < d; j++) z += w[j] * X[s][j];
          const p = 1 / (1 + Math.exp(-z));
          const err = p - labels[s];
          for (let j = 0; j < d; j++) gw[j] += err * X[s][j];
          gb += err;
        }
        for (let j = 0; j < d; j++) w[j] -= (lr * gw[j]) / X.length;
        b -= (lr * gb) / X.length;
      }
      model = { w, b, norm };
    },
    pick(hist) {
      if (!model) this.train(hist);
      const score = {};
      for (const n of candidates()) {
        const x = model.norm.apply(features(hist, n));
        let z = model.b;
        for (let j = 0; j < x.length; j++) z += model.w[j] * x[j];
        score[n] = 1 / (1 + Math.exp(-z));
      }
      return candidates().sort((a, b) => score[b] - score[a] || a - b).slice(0, cfg.pick);
    }
  };
})();

METHODS.knn = (() => {
  const W = 5;
  function state(hist) {
    const seqs = hist.map((d) => d[ZONE]);
    const set = new Set();
    for (const arr of seqs.slice(-W)) for (const n of arr) set.add(n);
    return set;
  }
  function sim(a, b) {
    let c = 0;
    for (const n of a) if (b.has(n)) c++;
    return c / Math.max(1, a.size + b.size - c);
  }
  return {
    name: 'KNN 相似期',
    pick(hist) {
      const cur = state(hist);
      const scored = [];
      for (let i = 40; i < hist.length; i++) {
        const s = state(hist.slice(0, i));
        scored.push({ i, s: sim(cur, s) });
      }
      scored.sort((a, b) => b.s - a.s);
      const cnt = {};
      for (const { i } of scored.slice(0, 30)) {
        for (const n of hist[i][ZONE]) cnt[n] = (cnt[n] || 0) + 1;
      }
      return candidates().sort((a, b) => (cnt[b] || 0) - (cnt[a] || 0) || a - b).slice(0, cfg.pick);
    }
  };
})();

METHODS.genetic = (() => {
  /* 预计算每个公式每期的推荐号，遗传算法只在权重空间搜索 */
  function prepare(hist) {
    const list = formulas();
    const table = [];
    for (let i = 40; i < hist.length; i++) {
      const ctx = Core.makeCtx(hist.slice(0, i), cfg, ZONE);
      table.push({ i, recs: list.map((f) => Core.safeRun(f, ctx)) });
    }
    return { list, table };
  }
  function evaluate(weights, table, upto) {
    let hits = 0, n = 0;
    for (let t = 0; t < Math.min(upto, table.length); t++) {
      const { i, recs } = table[t];
      const sc = {};
      for (let j = 0; j < recs.length; j++) sc[recs[j]] = (sc[recs[j]] || 0) + weights[j];
      const pick = Object.keys(sc).map(Number).sort((a, b) => sc[b] - sc[a] || a - b).slice(0, cfg.pick);
      hits += overlap(pick, draws[i][ZONE]);
      n++;
    }
    return hits / n;
  }
  let best = null;
  return {
    name: '遗传算法权重',
    train(hist) {
      const { list, table } = prepare(hist);
      const trainN = table.length;
      const POP = 24, GEN = 18, ELITE = 4;
      let pop = [];
      for (let p = 0; p < POP; p++) {
        pop.push(list.map(() => Math.random() * 2));
      }
      const score = (w) => evaluate(w, table, trainN);
      for (let g = 0; g < GEN; g++) {
        const scored = pop.map((w) => ({ w, s: score(w) })).sort((a, b) => b.s - a.s);
        best = scored[0].w;
        const next = scored.slice(0, ELITE).map((x) => x.w.slice());
        while (next.length < POP) {
          const a = scored[Math.floor(Math.random() * 10)].w;
          const b = scored[Math.floor(Math.random() * 10)].w;
          const child = a.map((v, j) => (Math.random() < 0.5 ? v : b[j]));
          for (let j = 0; j < child.length; j++) {
            if (Math.random() < 0.15) child[j] = Math.max(0, Math.min(2, child[j] + (Math.random() - 0.5) * 0.6));
          }
          next.push(child);
        }
        pop = next;
      }
      this._table = table;
      this._list = list;
    },
    pick(hist) {
      if (!best) this.train(hist);
      /* 必须用「当前这一期之前」的最新状态重新算推荐，不能复用训练段的表 */
      const list = this._list;
      const ctx = Core.makeCtx(hist, cfg, ZONE);
      const recs = list.map((f) => Core.safeRun(f, ctx));
      const sc = {};
      for (let j = 0; j < recs.length; j++) sc[recs[j]] = (sc[recs[j]] || 0) + best[j];
      return Object.keys(sc).map(Number).sort((a, b) => sc[b] - sc[a] || a - b).slice(0, cfg.pick);
    }
  };
})();

/* ---------------- 回测 ---------------- */
function backtest(method, from, to) {
  const trainHist = draws.slice(0, from);
  if (method.train) method.train(trainHist);
  let hits = 0, n = 0;
  for (let i = from; i < to; i++) {
    const pick = method.pick(draws.slice(0, i));
    hits += overlap(pick, draws[i][ZONE]);
    n++;
  }
  return { avg: hits / n, n };
}

function randomDistribution(from, to, sims) {
  const out = [];
  const pool = candidates();
  for (let s = 0; s < sims; s++) {
    let hits = 0;
    for (let i = from; i < to; i++) {
      const a = pool.slice();
      for (let k = a.length - 1; k > 0; k--) {
        const j = Math.floor(Math.random() * (k + 1));
        [a[k], a[j]] = [a[j], a[k]];
      }
      hits += overlap(a.slice(0, cfg.pick), draws[i][ZONE]);
    }
    out.push(hits / (to - from));
  }
  return out.sort((a, b) => a - b);
}

const BLOCKS = Number(arg('blocks', 1));
if (BLOCKS > 1) {
  const size = Math.floor((draws.length - TRAIN) / BLOCKS);
  console.log(`分段稳健性：训练 40–${TRAIN}，测试段切成 ${BLOCKS} 块
`);
  for (let b = 0; b < BLOCKS; b++) {
    const from = TRAIN + b * size;
    const to = b === BLOCKS - 1 ? draws.length : from + size;
    const parts = [];
    for (const id of ['random', 'hot30', 'knn']) {
      const r = backtest(METHODS[id], from, to);
      parts.push(`${METHODS[id].name} ${r.avg.toFixed(3)}`);
    }
    console.log(`块 ${b + 1} (${from}–${to})：${parts.join(' | ')}`);
  }
  console.log(`
随机期望 ${RANDOM_HITS.toFixed(3)} 个/注。如果某方法只在个别块高、其他块回落，就是运气。`);
  process.exit(0);
}

const dist = randomDistribution(TRAIN, draws.length, 1200);
const pct = (v) => {
  let lo = 0, hi = dist.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (dist[m] < v) lo = m + 1; else hi = m; }
  return (lo / dist.length) * 100;
};

console.log(`${KEY}/${ZONE}：训练 40–${TRAIN}，测试 ${TRAIN}–${draws.length}（${draws.length - TRAIN} 期）`);
console.log(`随机期望 ${RANDOM_HITS.toFixed(4)} 个/注，模拟均值 ${(dist.reduce((a, b) => a + b, 0) / dist.length).toFixed(4)} 个/注
`);

const rows = [];
for (const [id, m] of Object.entries(METHODS)) {
  const r = backtest(m, TRAIN, draws.length);
  rows.push({ id, name: m.name, avg: r.avg, p: pct(r.avg) });
  console.log(`${m.name.padEnd(14)} ${r.avg.toFixed(4)} 个/注  分位 ${pct(r.avg).toFixed(1)}%`);
}

console.log('\n分位 5%–95% 之间 = 与随机无差异；低于 1% 或高于 99% 才值得进一步查。');

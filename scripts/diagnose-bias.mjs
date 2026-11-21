#!/usr/bin/env node
/**
 * 命中率偏差诊断
 *
 *   node scripts/diagnose-bias.mjs [--periods=150] [--sims=2000] [--zones=ssq/front,dlt/front]
 *
 * 目的：回答「是不是真的不如随机」。
 *   1. 用当前生产配置跑 N 期滚动回测
 *   2. 逐项关闭 core.js 的四个机制（频率加权 / 回测权重 / 重号惩罚 / 冗余压缩）
 *   3. 用纯随机选号模拟 2000 次，得到命中率的抽样分布
 *   4. 看每个配置落在随机分布的哪个分位
 *
 * 判定：
 *   - 百分位 5%–95% 之间：与随机无差异（噪音）
 *   - 低于 1%：存在系统性负偏差，需要修
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
const FREQ_DEFAULT = { ssq: null, dlt: 30, fc3d: 0, kl8: 0, pl5: 0 };

const args = process.argv.slice(2);
const arg = (n, d) => {
  const h = args.find((a) => a.startsWith('--' + n + '='));
  return h ? h.split('=')[1] : d;
};
const PERIODS = Number(arg('periods', 150));
const SIMS = Number(arg('sims', 2000));
const ZONES = String(arg('zones', 'ssq/front,dlt/front,fc3d/hundreds,kl8/main,pl5/pos1')).split(',');

function formulasFor(key, zone) {
  const gb = BLACKLIST[key] || {};
  const drop = new Set([...(gb[zone] || []), ...(zone === 'front' ? (BLACKLIST.front || []) : [])]);
  let base = [], extra = [];
  if (key === 'kl8') base = KL8.all;
  else if (key === 'ssq') {
    base = zone === 'front' ? SSQF.front.slice() : zone === 'back' ? SSQF.back.slice() : F.digit.slice();
    extra = zone === 'front' ? SSQ.front : SSQ.back;
    extra = extra.concat(zone === 'front' ? EXTRA.ssq.front : EXTRA.ssq.back);
  } else if (key === 'dlt') {
    base = zone === 'front' ? DLTF.front.slice() : zone === 'back' ? DLTF.back.slice() : F.digit.slice();
    extra = zone === 'front' ? DLT.front : DLT.back;
    extra = extra.concat(zone === 'front' ? EXTRA.dlt.front : EXTRA.dlt.back);
  } else {
    const D = key === 'fc3d' ? DIGIT.fc3d : DIGIT.pl5;
    base = D.byZone[zone];
  }
  return base.concat(extra).filter((f) => !drop.has(f.id));
}

function overlap(a, b) {
  const s = new Set(b);
  return a.reduce((c, n) => c + (s.has(n) ? 1 : 0), 0);
}

const CONFIGS = [
  ['base', {}],
  ['noFreq', { freqAlpha: 0 }],
  ['noRepeat', { repeatPenalty: 1 }],
  ['noDup', { dupCompress: false }],
  ['equalW', { equalWeight: true }],
  ['allOff', { freqAlpha: 0, repeatPenalty: 1, dupCompress: false, equalWeight: true }]
];

function backtest(key, zone, opts, periods) {
  const draws = history[key].draws;
  const cfg = Core.GAMES[key][zone];
  const list = formulasFor(key, zone);
  let hits = 0, n = 0;
  for (let i = draws.length - periods; i < draws.length; i++) {
    const game = Object.assign({}, Core.GAMES[key], { key, draws: draws.slice(0, i) });
    const res = Core.analyze(game, zone, list, Object.assign({
      window: 40,
      freqWindow: FREQ_DEFAULT[key] === undefined ? 30 : FREQ_DEFAULT[key]
    }, opts));
    const pick = res.ranking.slice(0, cfg.pick).map((r) => r.n);
    hits += overlap(pick, draws[i][zone] || []);
    n++;
  }
  return { avg: hits / n, n, hits };
}

function randomDistribution(key, zone, periods, sims) {
  const draws = history[key].draws;
  const cfg = Core.GAMES[key][zone];
  const pool = [];
  for (let n = cfg.min; n <= cfg.max; n++) pool.push(n);
  const out = [];
  for (let s = 0; s < sims; s++) {
    let hits = 0;
    for (let i = draws.length - periods; i < draws.length; i++) {
      const a = pool.slice();
      for (let k = a.length - 1; k > 0; k--) {
        const j = Math.floor(Math.random() * (k + 1));
        [a[k], a[j]] = [a[j], a[k]];
      }
      hits += overlap(a.slice(0, cfg.pick), draws[i][zone] || []);
    }
    out.push(hits / periods);
  }
  return out.sort((x, y) => x - y);
}

function percentile(sorted, v) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; }
  return lo / sorted.length;
}

const out = { generatedAt: new Date().toISOString(), periods: PERIODS, sims: SIMS, zones: {} };
console.log(`周期 ${PERIODS}，模拟 ${SIMS} 次`);

for (const spec of ZONES) {
  const [key, zone] = spec.split('/');
  if (!Core.GAMES[key] || !Core.GAMES[key][zone]) continue;
  console.log(`\n===== ${spec} =====`);
  const t0 = Date.now();
  const dist = randomDistribution(key, zone, PERIODS, SIMS);
  const randomMean = dist.reduce((a, b) => a + b, 0) / dist.length;
  console.log(`  随机分布：均值 ${randomMean.toFixed(4)}，5% 分位 ${dist[Math.floor(SIMS * 0.05)].toFixed(4)}，95% 分位 ${dist[Math.floor(SIMS * 0.95)].toFixed(4)}`);

  const rows = [];
  for (const [name, opts] of CONFIGS) {
    const r = backtest(key, zone, opts, PERIODS);
    const pct = percentile(dist, r.avg);
    rows.push({ name, avg: +r.avg.toFixed(4), diff: +(r.avg - randomMean).toFixed(4), percentile: +(pct * 100).toFixed(1) });
    console.log(`  ${name.padEnd(9)} 命中 ${r.avg.toFixed(4)}  差 ${(r.avg - randomMean >= 0 ? '+' : '') + (r.avg - randomMean).toFixed(4)}  分位 ${(pct * 100).toFixed(1)}%`);
  }
  out.zones[spec] = { randomMean: +randomMean.toFixed(4), configs: rows, elapsedMs: Date.now() - t0 };
}

writeFileSync(resolve(ROOT, 'data/bias-diagnosis.json'), JSON.stringify(out), 'utf8');
console.log('\n写入 data/bias-diagnosis.json');

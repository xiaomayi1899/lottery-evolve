#!/usr/bin/env node
/**
 * 过拟合演示（不是新功能，是证据）
 *
 *   node scripts/demo-overfit.mjs [--split=200]
 *
 * 做法：
 *   1. 用前 split 期回测每个公式，挑命中率最高的 10 个 —— 这就是「历史最优」
 *   2. 让这 10 个公式去预测后 split 期
 *   3. 对比：样本内 vs 样本外
 *
 * 如果「历史最优公式」在样本外仍然最优，说明历史有可利用的规律；
 * 如果它跌回随机，说明样本内的高命中是噪声，任何「调参/选优」都无法迁移。
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
  return h ? Number(h.split('=')[1]) : d;
};
const SPLIT = arg('split', 200);
const KEY = 'ssq';
const ZONE = 'front';

function formulas() {
  const drop = new Set([...(BLACKLIST[KEY] && BLACKLIST[KEY][ZONE] || [])]);
  return SSQF.front.concat(SSQ.front).concat(EXTRA.ssq.front).filter((f) => !drop.has(f.id));
}

function hitRate(list, draws, from, to, cfg) {
  const hits = list.map(() => 0);
  let n = 0;
  for (let i = from; i < to; i++) {
    const ctx = Core.makeCtx(draws.slice(0, i), cfg, ZONE);
    const actual = new Set(draws[i][ZONE]);
    for (let j = 0; j < list.length; j++) {
      if (actual.has(Core.safeRun(list[j], ctx))) hits[j]++;
    }
    n++;
  }
  return hits.map((h) => h / n);
}

const draws = history[KEY].draws;
const cfg = Core.GAMES[KEY][ZONE];
const list = formulas();

console.log(`公式 ${list.length} 个，前区 ${cfg.pick}/${cfg.max}，随机命中率 ${(cfg.pick / (cfg.max - cfg.min + 1)).toFixed(4)}`);
console.log(`训练段：第 40–${SPLIT} 期，测试段：第 ${SPLIT}–${draws.length} 期\n`);

const trainRate = hitRate(list, draws, 40, SPLIT, cfg);
const idx = list.map((_, i) => i).sort((a, b) => trainRate[b] - trainRate[a]);
const top10 = idx.slice(0, 10).map((i) => list[i]);
const bottom10 = idx.slice(-10).map((i) => list[i]);

console.log('训练段命中率最高的 10 个公式：');
idx.slice(0, 10).forEach((i) => console.log(`  ${list[i].id} ${list[i].name}  ${(trainRate[i] * 100).toFixed(1)}%`));
console.log('\n训练段命中率最低的 10 个公式：');
idx.slice(-10).forEach((i) => console.log(`  ${list[i].id} ${list[i].name}  ${(trainRate[i] * 100).toFixed(1)}%`));

const testAll = hitRate(list, draws, SPLIT, draws.length, cfg);
const testTop = hitRate(top10, draws, SPLIT, draws.length, cfg);
const testBottom = hitRate(bottom10, draws, SPLIT, draws.length, cfg);

const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const random = cfg.pick / (cfg.max - cfg.min + 1);

console.log('\n=== 结果 ===');
console.log(`随机理论值            ${(random * 100).toFixed(1)}%`);
console.log(`训练段 全部公式均值    ${(avg(trainRate) * 100).toFixed(1)}%`);
console.log(`训练段 Top10 均值      ${(avg(idx.slice(0, 10).map((i) => trainRate[i])) * 100).toFixed(1)}%  <- 历史最优`);
console.log(`测试段 全部公式均值    ${(avg(testAll) * 100).toFixed(1)}%`);
console.log(`测试段 Top10 均值      ${(avg(testTop) * 100).toFixed(1)}%  <- 历史最优的未来表现`);
console.log(`测试段 Bottom10 均值   ${(avg(testBottom) * 100).toFixed(1)}%  <- 历史最差的未来表现`);
console.log('\n如果 Top10 在测试段仍明显高于随机，说明历史规律可用；');
console.log('如果 Top10 跌回随机、甚至低于 Bottom10，说明「选优」只是拟合噪声。');

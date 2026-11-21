#!/usr/bin/env node
/**
 * 彩种隔离自检
 *
 *   node scripts/verify-isolation.mjs
 *
 * 回答一个问题：五套公式 / 策略是不是「各算各的」？
 *   1. 双色球与大乐透的完整公式集是两个独立实例（id 前缀 SF / DF，对象不共享）
 *   2. 每个彩种的专属公式 id 前缀互不重叠
 *   3. 3D 与排列五的位置公式是两套独立构建
 *   4. 26 个策略按 games / digit 正确过滤，快乐8 专属不会出现在双色球
 *   5. 策略是无状态的：同一视图连续跑两次结果完全一致
 *   6. 前端缓存键包含彩种（静态检查 app.js 的 formulaCache key）
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const Core = require(resolve(ROOT, 'assets/core.js'));
const S = require(resolve(ROOT, 'assets/strategies.js'));
const SSQF = require(resolve(ROOT, 'assets/formulas-ssq-full.js'));
const DLTF = require(resolve(ROOT, 'assets/formulas-dlt-full.js'));
const SSQ = require(resolve(ROOT, 'assets/formulas-ssq.js'));
const DLT = require(resolve(ROOT, 'assets/formulas-dlt.js'));
const KL8 = require(resolve(ROOT, 'assets/formulas-kl8.js'));
const DIGIT = require(resolve(ROOT, 'assets/formulas-digit.js'));
const EXTRA = require(resolve(ROOT, 'assets/formulas-extra.js'));

const history = JSON.parse(readFileSync(resolve(ROOT, 'data/history.json'), 'utf8'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, detail === undefined ? '' : '→', JSON.stringify(detail)); }
}

const ids = (list) => list.map((f) => f.id);
const prefixOf = (list) => [...new Set(list.map((f) => String(f.id).replace(/\d+$/, '')))];

console.log('\n[1] 双色球 / 大乐透完整公式集是两个独立实例');
check('SSQF 与 DLTF 的 front 对象不共享引用', SSQF.front[0] !== DLTF.front[0]);
check('SSQF 与 DLTF 的 back 对象不共享引用', SSQF.back[0] !== DLTF.back[0]);
check('SSQF id 前缀为 SF', JSON.stringify(prefixOf(SSQF.front)) === '["SF"]', prefixOf(SSQF.front));
check('DLTF id 前缀为 DF', JSON.stringify(prefixOf(DLTF.front)) === '["DF"]', prefixOf(DLTF.front));
const overlap = ids(SSQF.front).filter((x) => ids(DLTF.front).includes(x));
check('两套完整公式 id 完全不重叠', overlap.length === 0, overlap.slice(0, 5));

console.log('\n[2] 各彩种专属公式 id 前缀互不重叠');
const groups = {
  ssq_extra: prefixOf(SSQ.all),
  dlt_extra: prefixOf(DLT.all),
  extra_ssq: prefixOf(EXTRA.ssq.list),
  extra_dlt: prefixOf(EXTRA.dlt.list),
  kl8: prefixOf(KL8.all),
  fc3d: prefixOf(DIGIT.fc3d.list),
  pl5: prefixOf(DIGIT.pl5.list)
};
for (const [k, v] of Object.entries(groups)) console.log('   ', k, '→', v.join(','));
check('大乐透专属与双色球专属前缀不同', String(groups.dlt_extra) !== String(groups.ssq_extra));
check('EXTRA 两套前缀 X / Y 不同', groups.extra_ssq[0] === 'X' && groups.extra_dlt[0] === 'Y');
check('3D 与排列五前缀不同', String(groups.fc3d) !== String(groups.pl5));

console.log('\n[3] 3D / 排列五位置公式独立');
check('fc3d.byZone 覆盖三位', ['hundreds', 'tens', 'units'].every((z) => DIGIT.fc3d.byZone[z]));
check('pl5.byZone 覆盖五位', ['pos1', 'pos2', 'pos3', 'pos4', 'pos5'].every((z) => DIGIT.pl5.byZone[z]));
check('fc3d 与 pl5 的公式对象不共享', DIGIT.fc3d.list[0] !== DIGIT.pl5.list[0]);
check('fc3d 三位之间公式对象不共享', DIGIT.fc3d.byZone.hundreds[0] !== DIGIT.fc3d.byZone.tens[0]);

console.log('\n[4] 策略按彩种 / 数字位正确过滤');
const special = (list) => list.filter((s) => s.games || s.digit).map((s) => s.id);
for (const key of ['ssq', 'dlt', 'fc3d', 'kl8', 'pl5']) {
  const meta = Core.GAMES[key];
  for (const zone of meta.ticketZones) {
    const list = S.forZone(key, zone, meta[zone]);
    const bad = list.filter((s) => {
      if (s.games && s.games.indexOf(key) === -1) return true;
      if (s.digit && !(meta[zone].min === 0 && meta[zone].max === 9 && meta[zone].pick === 1)) return true;
      return false;
    });
    check(`${key}/${zone} 无越界策略（${list.length} 个）`, bad.length === 0, bad.map((s) => s.id));
  }
}
const ssqFront = S.forZone('ssq', 'front', Core.GAMES.ssq.front).map((s) => s.id);
check('快乐8 专属策略不出现在双色球', !ssqFront.includes('kl8spread') && !ssqFront.includes('kl8cooccur'));
const ssqBack = S.forZone('ssq', 'back', Core.GAMES.ssq.back).map((s) => s.id);
check('胆码策略不出现在双色球蓝球（pick=1 但不是 0–9）', !ssqBack.includes('danma3') && !ssqBack.includes('dudan3'));
const dltFront = S.forZone('dlt', 'front', Core.GAMES.dlt.front).map((s) => s.id);
check('大乐透前区不含快乐8 专属', !dltFront.includes('kl8cooccur'));

console.log('\n[5] 策略无状态：同视图两次结果完全一致');
for (const key of ['ssq', 'fc3d', 'kl8']) {
  const meta = Core.GAMES[key];
  const zone = meta.ticketZones[0];
  const draws = history[key].draws;
  const view = S.view(draws, key, zone, meta[zone], draws.length - 1, 'next');
  const list = S.forZone(key, zone, meta[zone]);
  const a = S.runAll(list, view).map((r) => r.strategy + ':' + r.numbers.join(','));
  const b = S.runAll(list, view).map((r) => r.strategy + ':' + r.numbers.join(','));
  check(`${key}/${zone} 两次运行结果一致`, JSON.stringify(a) === JSON.stringify(b));
}

console.log('\n[6] 同一策略在不同彩种上独立计算');
const common = ['hot10', 'omission', 'markov1'];
for (const id of common) {
  const st = S.all().find((s) => s.id === id);
  const r1 = S.run(st, S.view(history.ssq.draws, 'ssq', 'front', Core.GAMES.ssq.front, 100, 'n'));
  const r2 = S.run(st, S.view(history.dlt.draws, 'dlt', 'front', Core.GAMES.dlt.front, 100, 'n'));
  check(`${id} 在双色球/大乐透上号码池不同`, JSON.stringify(r1.numbers) !== JSON.stringify(r2.numbers),
    { ssq: r1.numbers, dlt: r2.numbers });
}

console.log('\n[7] 前端缓存键隔离（静态检查）');
const appJs = readFileSync(resolve(ROOT, 'assets/app.js'), 'utf8');
check('formulaCache 的 key 由 彩种|位置 组成', /var ck = key \+ '\|' \+ zone;/.test(appJs));
check('缓存键含 freqWindow 与 salt', /key \+ '\|' \+ zone \+ '\|0\|f' \+ freqWindowFor\(key\)/.test(appJs));
check('黑名单加载后会同时清空 formulaCache', /state\.blacklist = j; cache = \{\}; formulaCache = \{\};/.test(appJs));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) process.exitCode = 1;

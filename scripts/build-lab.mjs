#!/usr/bin/env node
/**
 * 生成策略实验室数据 data/lab.json
 *
 *   node scripts/build-lab.mjs [--detail=60] [--tickets=5] [--halfLife=40]
 *
 * 做的事：
 *   1. 对 5 个彩种、每个号码区，用 walking-forward 回测 26 个独立策略
 *   2. 统计每个策略的命中、z 值、p 值、Bonferroni 校正后的 p、状态
 *   3. 用 EWMA 自适应权重合成「委员会」推荐下一期
 *   4. 用缩水算法生成多注覆盖
 *   5. 输出 data/lab.json（前端只读这一份，不在浏览器跑回测）
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const S = require(resolve(ROOT, 'assets/strategies.js'));
const Lab = require(resolve(ROOT, 'assets/lab.js'));
const P = require(resolve(ROOT, 'assets/portfolio.js'));
const Core = require(resolve(ROOT, 'assets/core.js'));

const args = process.argv.slice(2);
function arg(name, dflt) {
  const hit = args.find((a) => a.startsWith('--' + name + '='));
  return hit ? Number(hit.split('=')[1]) : dflt;
}

const DETAIL = arg('detail', 60);
const TICKETS = arg('tickets', 5);
const HALF_LIFE = arg('halfLife', 40);

const history = JSON.parse(readFileSync(resolve(ROOT, 'data/history.json'), 'utf8'));
const GAMES = ['ssq', 'dlt', 'fc3d', 'kl8', 'pl5'];

/* 期号 +1；只用于给 random / 玄学策略一个确定性的「下一期」种子。
   跨年时官方期号会重置，这里不做年份推断，页面会以「下一期」展示。 */
function bumpIssue(issue) {
  const s = String(issue);
  const n = Number(s.replace(/\D/g, '')) + 1;
  return String(n).padStart(s.length, '0');
}

function rankToScores(ranking) {
  const out = {};
  ranking.forEach((n, i) => { out[n] = ranking.length - i; });
  return out;
}

const out = {
  version: 2,
  generatedAt: new Date().toISOString(),
  params: { detail: DETAIL, tickets: TICKETS, halfLife: HALF_LIFE },
  method: {
    backtest: 'walking-forward：第 i 期只使用 0..i-1 期数据出号，再与实际开奖比对',
    statistics: '超几何精确期望与方差；z = (命中 − 期望) / √方差；双侧正态 p 值；Bonferroni 多重比较校正',
    weights: 'EWMA（半衰期 ' + HALF_LIFE + ' 期），按每期「实际命中 ÷ 期望」更新',
    tickets: '缩水覆盖：分数 − 5×已用次数 贪心，首注为委员会最高分',
    disclaimer: '彩票为独立随机事件，本实验室不提高中奖概率；显著优于随机的策略大概率是多重比较造成的偶然。'
  },
  strategies: S.all().map((s) => ({
    id: s.id, name: s.name, family: s.family, desc: s.desc, mystic: !!s.mystic
  })),
  games: {}
};

for (const key of GAMES) {
  const meta = Core.GAMES[key];
  const data = history[key];
  if (!data || !data.draws || !data.draws.length) continue;
  const draws = data.draws;
  const nextIssue = bumpIssue(draws[draws.length - 1].issue);
  const zones = {};

  for (const zone of meta.ticketZones) {
    const cfg = meta[zone];
    const list = S.forZone(key, zone, cfg);
    const res = Lab.runZone(draws, key, zone, cfg, list, {
      detail: DETAIL, halfLife: HALF_LIFE, nextIssue
    });
    Lab.classify(res.strategies, list.length);
    /* 淘汰的策略放到末尾，其余按 |z| 排序，便于阅读 */
    const ranked = res.strategies.slice().sort((a, b) => {
      if (a.status === 'retired' && b.status !== 'retired') return 1;
      if (b.status === 'retired' && a.status !== 'retired') return -1;
      return Math.abs(b.z) - Math.abs(a.z);
    });

    const view = S.view(draws, key, zone, cfg, draws.length, nextIssue);
    const committee = Lab.committee(res, view, list);

    let tickets = null;
    let coverage = null;
    if (cfg.pick > 1) {
      tickets = P.build(cfg, committee.scores, TICKETS);
      coverage = P.coverage(tickets, cfg);
    }

    zones[zone] = {
      zone,
      label: cfg.label || zone,
      kind: cfg.pick === 1 ? 'digit' : 'group',
      cfg: {
        min: cfg.min,
        max: cfg.max,
        pick: cfg.pick,
        drawPick: cfg.drawPick || cfg.pick
      },
      expected: res.expected,
      variance: res.variance,
      drawPick: res.drawPick,
      strategies: ranked,
      committee: {
        numbers: committee.numbers,
        ranking: committee.ranking.slice(0, 15),
        usedWeight: committee.usedWeight
      },
      tickets,
      coverage,
      audit: Lab.audit(draws, key, zone)
    };
  }

  /* 位置型玩法（3D / 排列五）在游戏层合成多注 */
  let gameTickets = null;
  const zoneList = meta.ticketZones;
  if (zoneList.length > 1 && meta[zoneList[0]].pick === 1) {
    const positionScores = zoneList.map((z) => {
      const ranking = zones[z].committee.ranking;
      return ranking.map((n, i) => ({ n, score: ranking.length - i }));
    });
    gameTickets = P.digitTickets(positionScores, TICKETS);
  }

  out.games[key] = {
    name: meta.name,
    nextIssue,
    drawCount: draws.length,
    lastIssue: String(draws[draws.length - 1].issue),
    lastDate: draws[draws.length - 1].date,
    zones,
    tickets: gameTickets
  };
}

const target = resolve(ROOT, 'data/lab.json');
writeFileSync(target, JSON.stringify(out), 'utf8');

/* ---------------- 控制台摘要 ---------------- */
console.log('写入', target);
console.log('参数', JSON.stringify(out.params));
let total = 0;
for (const [gk, g] of Object.entries(out.games)) {
  console.log('\n==', g.name, '下一期', g.nextIssue, '历史', g.drawCount, '期');
  for (const [zk, z] of Object.entries(g.zones)) {
    const retired = z.strategies.filter((s) => s.status === 'retired').length;
    const cand = z.strategies.filter((s) => s.status === 'candidate').length;
    const audit = z.audit.ok ? '无前视' : '异常!' + JSON.stringify(z.audit.bad);
    console.log(
      '  ' + (z.label || zk).padEnd(4),
      '策略 ' + String(z.strategies.length).padStart(2),
      '| 淘汰 ' + retired,
      '| 待复验 ' + cand,
      '| 期望 ' + z.expected,
      '| 推荐 ' + z.committee.numbers.join(' '),
      '| ' + audit
    );
    if (!z.audit.ok) process.exitCode = 1;
    total += z.strategies.length;
  }
  if (g.tickets) console.log('  多注', g.tickets.map((t) => t.join('')).join(' / '));
}
console.log('\n策略记录合计', total, '条');

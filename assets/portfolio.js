/* 数彩实验室 · 多注组合与缩水覆盖（浏览器 + Node 共用）
 *
 * 思路：同样的预算，与其把 5 注都押在最热的同一批号上，不如让 5 注覆盖
 * 更多号码与结构。这里用「分数 - λ×已用次数」的贪心，确定性地生成 M 注，
 * 保证：① 第一注仍是委员会最高分；② 后续注逐步向未覆盖的号扩散。
 *
 * 对 3D / 排列五这种位置型玩法，用拉丁方式轮转每位的前 K 名，
 * 使每位的高分号在 M 注里被均匀覆盖。
 */
(function (root) {
  'use strict';

  var P = {};

  function cands(cfg) {
    var out = [];
    for (var n = cfg.min; n <= cfg.max; n++) out.push(n);
    return out;
  }

  function rankByScore(cfg, scores) {
    return cands(cfg).slice().sort(function (a, b) {
      var d = (scores[b] || 0) - (scores[a] || 0);
      if (Math.abs(d) > 1e-12) return d;
      return a - b;
    });
  }

  function overlap(a, b) {
    var set = {}, c = 0, i;
    for (i = 0; i < a.length; i++) set[a[i]] = 1;
    for (i = 0; i < b.length; i++) if (set[b[i]]) c++;
    return c;
  }

  function key(t) { return t.slice().sort(function (a, b) { return a - b; }).join(','); }

  /* 单区多注 */
  P.build = function (cfg, scores, m, opts) {
    opts = opts || {};
    var mCount = Math.max(1, m || 1);
    var poolSize = Math.min(cfg.max - cfg.min + 1, opts.pool || cfg.pick * mCount);
    var lambda = opts.lambda === undefined ? 5 : opts.lambda;
    var ranked = rankByScore(cfg, scores);
    var pool = ranked.slice(0, poolSize);
    var usage = {};
    var tickets = [];
    var seen = {};
    var i, t;

    for (i = 0; i < pool.length; i++) usage[pool[i]] = 0;

    for (t = 0; t < mCount; t++) {
      var order = pool.map(function (n, idx) {
        var base = pool.length - idx; /* 排名越靠前基础分越高 */
        return { n: n, v: base - lambda * usage[n] };
      }).sort(function (a, b) {
        var d = b.v - a.v;
        if (Math.abs(d) > 1e-12) return d;
        return a.n - b.n;
      });

      var ticket = [];
      for (i = 0; i < order.length && ticket.length < cfg.pick; i++) {
        var cand = order[i].n;
        /* 避免与已出的注完全相同 */
        var probe = ticket.concat([cand]);
        if (probe.length === cfg.pick && seen[key(probe)]) continue;
        ticket.push(cand);
      }
      /* 极端情况下池不足，用剩余号码补齐 */
      if (ticket.length < cfg.pick) {
        for (i = 0; i < ranked.length && ticket.length < cfg.pick; i++) {
          if (ticket.indexOf(ranked[i]) === -1) ticket.push(ranked[i]);
        }
      }
      ticket.sort(function (a, b) { return a - b; });
      seen[key(ticket)] = 1;
      tickets.push(ticket);
      for (i = 0; i < ticket.length; i++) usage[ticket[i]]++;
    }

    return tickets;
  };

  /* 位置型（3D / 排列五）：positionScores 是每位按分数降序的 [{n,score}] */
  P.digitTickets = function (positionScores, m, opts) {
    opts = opts || {};
    var mCount = Math.max(1, m || 1);
    var K = Math.min(opts.topK || 3, 10);
    var out = [];
    for (var t = 0; t < mCount; t++) {
      var row = [];
      for (var p = 0; p < positionScores.length; p++) {
        var list = positionScores[p];
        var idx = (t + p) % K;
        row.push(list[Math.min(idx, list.length - 1)].n);
      }
      out.push(row);
    }
    /* 去重：重复的注往后移动一位候选 */
    var seen = {};
    for (t = 0; t < out.length; t++) {
      var k = key(out[t]);
      var guard = 0;
      while (seen[k] && guard++ < K * 2) {
        for (var q = 0; q < out[t].length; q++) {
          var lst = positionScores[q];
          var pos = 0;
          for (var r = 0; r < lst.length; r++) if (lst[r].n === out[t][q]) { pos = r; break; }
          out[t][q] = lst[(pos + 1) % lst.length].n;
        }
        k = key(out[t]);
      }
      seen[k] = 1;
    }
    return out;
  };

  /* 结构描述：和值、奇偶、大小、跨度、AC 值、三区分布 */
  P.structure = function (cfg, nums) {
    var sum = 0, odd = 0, i, j;
    for (i = 0; i < nums.length; i++) {
      sum += nums[i];
      if (nums[i] % 2 === 1) odd++;
    }
    var span = nums.length ? Math.max.apply(null, nums) - Math.min.apply(null, nums) : 0;
    var diffs = {};
    for (i = 0; i < nums.length; i++) {
      for (j = i + 1; j < nums.length; j++) diffs[Math.abs(nums[i] - nums[j])] = 1;
    }
    var ac = Math.max(0, Object.keys(diffs).length - (nums.length - 1));
    var zones = [0, 0, 0];
    var size = (cfg.max - cfg.min + 1) / 3;
    for (i = 0; i < nums.length; i++) {
      var z = Math.min(2, Math.floor((nums[i] - cfg.min) / size));
      zones[z]++;
    }
    return {
      numbers: nums,
      sum: sum,
      odd: odd,
      even: nums.length - odd,
      span: span,
      ac: ac,
      zones: zones
    };
  };

  /* 覆盖统计：每个号被多少注包含，用于证明「缩水」确实扩散了覆盖面 */
  P.coverage = function (tickets, cfg) {
    var used = {}, i, j;
    var list = cands(cfg);
    for (i = 0; i < list.length; i++) used[list[i]] = 0;
    for (i = 0; i < tickets.length; i++) {
      for (j = 0; j < tickets[i].length; j++) {
        if (used[tickets[i][j]] !== undefined) used[tickets[i][j]]++;
      }
    }
    var covered = 0, max = 0, total = 0;
    for (i = 0; i < list.length; i++) {
      var c = used[list[i]];
      if (c > 0) covered++;
      if (c > max) max = c;
      total += c;
    }
    var pairs = 0;
    for (i = 0; i < tickets.length; i++) {
      for (j = i + 1; j < tickets.length; j++) pairs += overlap(tickets[i], tickets[j]);
    }
    var pairsCount = tickets.length * (tickets.length - 1) / 2;
    return {
      coveredNumbers: covered,
      poolSize: list.length,
      coverageRate: +(covered / list.length).toFixed(3),
      maxReuse: max,
      avgPerNumber: +(total / list.length).toFixed(2),
      avgOverlap: +(pairsCount ? pairs / pairsCount : 0).toFixed(2),
      tickets: tickets.length
    };
  };

  /* 对比：同样注数下，「全押最高分」与「缩水覆盖」的覆盖差异 */
  P.compare = function (cfg, scores, m) {
    var maxScore = rankByScore(cfg, scores).slice(0, cfg.pick);
    var naive = [];
    for (var i = 0; i < m; i++) naive.push(maxScore.slice());
    var spread = P.build(cfg, scores, m);
    return {
      naive: { tickets: naive, coverage: P.coverage(naive, cfg) },
      spread: { tickets: spread, coverage: P.coverage(spread, cfg) }
    };
  };

  root.LotteryPortfolio = P;
  if (typeof module !== 'undefined' && module.exports) module.exports = P;
})(typeof globalThis !== 'undefined' ? globalThis : this);

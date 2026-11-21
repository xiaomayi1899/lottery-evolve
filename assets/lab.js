/* 数彩实验室 · 回测与统计（浏览器 + Node 共用）
 *
 * walking-forward 回测：第 i 期只用 0..i-1 期的数据出号，再与第 i 期实际开奖比对。
 * 统计口径：
 *   - 期望与方差用超几何分布精确计算（不是简单二项近似）
 *   - z = (总命中 - 总期望) / sqrt(总方差)
 *   - 双侧 p 值用正态近似
 *   - 多个策略同时检验时必须做多重比较校正（Bonferroni），否则必然出现「假冠军」
 *   - 淘汰只针对「显著差于随机」的策略；「显著优于随机」一律标为待复验，
 *     因为彩票是独立随机事件，长期优于随机在数学上不应存在。
 */
(function (root) {
  'use strict';

  var S = (typeof module !== 'undefined' && module.exports)
    ? require('./strategies.js')
    : root.LotteryStrategies;

  var Lab = {};

  /* ---------------- 统计工具 ---------------- */

  /* 标准正态分布 CDF（Abramowitz–Stegun 7.1.26，误差 < 7.5e-8） */
  function phi(x) {
    var t = 1 / (1 + 0.2316419 * Math.abs(x));
    var d = 0.3989422804014327 * Math.exp(-x * x / 2);
    var p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return x > 0 ? 1 - p : p;
  }

  function twoSidedP(z) {
    return 2 * (1 - phi(Math.abs(z)));
  }

  function overlap(a, b) {
    var set = {}, c = 0, i;
    for (i = 0; i < a.length; i++) set[a[i]] = 1;
    for (i = 0; i < b.length; i++) if (set[b[i]]) c++;
    return c;
  }

  function mean(a) {
    if (!a.length) return 0;
    var s = 0;
    for (var i = 0; i < a.length; i++) s += a[i];
    return s / a.length;
  }

  /* ---------------- 回测 ---------------- */

  /*
   * opts:
   *   start      从第几期开始回测（默认 1）
   *   detail     保留最近多少期的逐期明细（默认 120）
   *   halfLife   EWMA 半衰期（默认 40 期）
   *   nextIssue  下一期期号（用于 random / 玄学策略的确定性种子）
   */
  Lab.runZone = function (draws, game, zone, cfg, strategies, opts) {
    opts = opts || {};
    var start = opts.start || 1;
    var detail = opts.detail || 120;
    var halfLife = opts.halfLife || 40;
    var drawPick = cfg.drawPick || cfg.pick;
    var dist = S.expected(cfg, drawPick);
    var expected = dist.expected;
    var variance = dist.variance;
    var alpha = 1 - Math.pow(0.5, 1 / halfLife);

    var acc = {};
    strategies.forEach(function (s) {
      acc[s.id] = {
        id: s.id,
        name: s.name,
        family: s.family,
        desc: s.desc,
        mystic: !!s.mystic,
        n: 0,
        hits: 0,
        weights: [],
        records: [],
        ewma: 1
      };
    });

    for (var i = start; i < draws.length; i++) {
      var view = S.view(draws, game, zone, cfg, i, opts.nextIssue);
      var actual = draws[i][zone] || [];
      for (var k = 0; k < strategies.length; k++) {
        var st = strategies[k];
        var rec = acc[st.id];
        var run = S.run(st, view);
        if (!run.numbers.length) continue;
        var hit = overlap(run.numbers, actual);
        rec.n++;
        rec.hits += hit;
        /* 自适应权重：每期按「实际命中 / 期望」的截断比值做 EWMA */
        var ratio = expected > 0 ? hit / expected : 1;
        ratio = Math.max(0, Math.min(2.5, ratio));
        rec.ewma = rec.ewma * (1 - alpha) + ratio * alpha;
        rec.weights.push(+rec.ewma.toFixed(4));
        rec.records.push({
          issue: String(draws[i].issue),
          date: draws[i].date,
          pick: run.numbers,
          hits: hit
        });
      }
    }

    var out = [];
    strategies.forEach(function (s) {
      var rec = acc[s.id];
      if (!rec.n) return;
      var detailStart = Math.max(0, rec.records.length - detail);
      var recent = rec.records.slice(detailStart);
      var recentHits = recent.reduce(function (sum, r) { return sum + r.hits; }, 0);
      var sd = Math.sqrt(rec.n * variance);
      var z = sd > 0 ? (rec.hits - rec.n * expected) / sd : 0;
      var p = twoSidedP(z);
      var avgHit = rec.hits / rec.n;
      var se = sd / rec.n;
      out.push({
        id: rec.id,
        name: rec.name,
        family: rec.family,
        desc: rec.desc,
        mystic: rec.mystic,
        n: rec.n,
        hits: rec.hits,
        avgHit: +avgHit.toFixed(4),
        expected: +expected.toFixed(4),
        diff: +(avgHit - expected).toFixed(4),
        sd: +sd.toFixed(4),
        z: +z.toFixed(3),
        p: p,
        ci95: [
          +(avgHit - 1.96 * se).toFixed(4),
          +(avgHit + 1.96 * se).toFixed(4)
        ],
        weight: +rec.ewma.toFixed(4),
        weightCurve: rec.weights.slice(Math.max(0, rec.weights.length - 40)),
        recentN: recent.length,
        recentAvgHit: recent.length ? +(recentHits / recent.length).toFixed(4) : null,
        records: recent
      });
    });

    return {
      zone: zone,
      drawPick: drawPick,
      expected: +expected.toFixed(4),
      variance: +variance.toFixed(6),
      strategies: out
    };
  };

  /*
   * 多重比较校正 + 状态判定。
   * mTests = 同一彩种同一区参与检验的策略总数。
   */
  Lab.classify = function (strategies, mTests) {
    strategies.forEach(function (s) {
      s.pAdj = Math.min(1, s.p * mTests);
      if (s.n < 60) {
        s.status = 'collecting';
        s.statusText = '样本不足';
      } else if (s.z <= -1.645 && s.pAdj < 0.10) {
        s.status = 'retired';
        s.statusText = '显著劣于随机';
      } else if (s.z >= 1.96 && s.pAdj < 0.10) {
        s.status = 'candidate';
        s.statusText = '待复验';
      } else {
        s.status = 'active';
        s.statusText = '与随机无显著差异';
      }
    });
    return strategies;
  };

  /* ---------------- 组合融合 ---------------- */

  /*
   * 用自适应权重把各策略的分数合成一个「委员会分」。
   * retired 的策略权重置 0；mystic 策略权重乘 0.5（保留作为对照，不放大噪音）。
   */
  Lab.committee = function (zoneResult, view, strategies) {
    var byId = {};
    zoneResult.strategies.forEach(function (s) { byId[s.id] = s; });
    var scores = {};
    var list = S.util.cands(view.cfg);
    var i, j;
    for (i = 0; i < list.length; i++) scores[list[i]] = 0;
    var totalW = 0;

    for (i = 0; i < strategies.length; i++) {
      var st = strategies[i];
      var info = byId[st.id];
      if (!info || info.status === 'retired') continue;
      var run = S.run(st, view);
      if (!run.scores) continue;
      var w = Math.max(0.1, Math.min(3, info.weight || 1));
      if (st.mystic) w *= 0.5;
      totalW += w;
      for (j = 0; j < list.length; j++) {
        var n = list[j];
        scores[n] += (run.scores[n] || 0) * w;
      }
    }
    if (totalW > 0) {
      for (i = 0; i < list.length; i++) scores[list[i]] /= totalW;
    }
    var ranked = list.slice().sort(function (a, b) {
      var d = scores[b] - scores[a];
      if (Math.abs(d) > 1e-12) return d;
      return a - b;
    });
    return {
      scores: scores,
      ranking: ranked,
      numbers: ranked.slice(0, view.cfg.pick).sort(function (a, b) { return a - b; }),
      usedWeight: +totalW.toFixed(3)
    };
  };

  /* 无前视自检：视图里的历史长度必须恰好等于 i */
  Lab.audit = function (draws, game, zone) {
    var bad = [];
    for (var i = 1; i < draws.length; i++) {
      var v = S.view(draws, game, zone, { min: 0, max: 1, pick: 1 }, i);
      if (v.seqs.length !== i) bad.push(i);
    }
    return { ok: bad.length === 0, bad: bad.slice(0, 5) };
  };

  Lab.stats = { phi: phi, twoSidedP: twoSidedP, overlap: overlap };

  root.LotteryLab = Lab;
  if (typeof module !== 'undefined' && module.exports) module.exports = Lab;
})(typeof globalThis !== 'undefined' ? globalThis : this);

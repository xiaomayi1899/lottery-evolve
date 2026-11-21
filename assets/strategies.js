/* 数彩实验室 · 策略引擎（浏览器 + Node 共用）
 *
 * 设计原则
 *   1. 每个策略只读「当期之前」的历史（view.seqs），绝不接触未来数据。
 *   2. 策略统一输出「每个候选号的分数」，分数越高越看好；回测取前 pick 个作为一注。
 *   3. 策略之间互不参考，各自独立归档，才能被单独评分、单独淘汰。
 *   4. 玄学策略（周易/奇门/太乙）是可复现的确定性映射，明确标注为对照组：
 *      它们的期望值就是随机，用来证明「玄学不优于随机」。
 */
(function (root) {
  'use strict';

  var S = {};

  /* ---------------- 基础工具 ---------------- */

  function hashStr(s) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function cands(cfg) {
    var out = [];
    for (var n = cfg.min; n <= cfg.max; n++) out.push(n);
    return out;
  }

  function isDigit(cfg) {
    return cfg.min === 0 && cfg.max === 9 && cfg.pick === 1;
  }

  /* 把原始计数转成 z 分数，便于跨策略比较；标准差为 0 时全部归零 */
  function norm(sc, cfg) {
    var list = cands(cfg), i, n;
    var m = 0;
    for (i = 0; i < list.length; i++) m += sc[list[i]] || 0;
    m /= list.length;
    var v = 0;
    for (i = 0; i < list.length; i++) {
      var d = (sc[list[i]] || 0) - m;
      v += d * d;
    }
    var sd = Math.sqrt(v / list.length) || 1;
    var out = {};
    for (i = 0; i < list.length; i++) {
      n = list[i];
      out[n] = ((sc[n] || 0) - m) / sd;
    }
    return out;
  }

  function counts(seqs, cfg) {
    var c = {}, list = cands(cfg), i;
    for (i = 0; i < list.length; i++) c[list[i]] = 0;
    for (i = 0; i < seqs.length; i++) {
      var s = seqs[i];
      for (var j = 0; j < s.length; j++) {
        if (c[s[j]] !== undefined) c[s[j]]++;
      }
    }
    return c;
  }

  /* 当前遗漏：从最后一期往前数，多少期没出现 */
  function omission(seqs, n) {
    for (var i = seqs.length - 1, k = 0; i >= 0; i--, k++) {
      if (seqs[i].indexOf(n) !== -1) return k;
    }
    return seqs.length + 1;
  }

  /* 收集每个号「两次出现之间的间隔」，用于逾期系数 */
  function gaps(seqs, n) {
    var out = [], last = -1, i;
    for (i = 0; i < seqs.length; i++) {
      if (seqs[i].indexOf(n) !== -1) {
        if (last >= 0) out.push(i - last);
        last = i;
      }
    }
    return out;
  }

  function mean(a) {
    if (!a.length) return 0;
    var s = 0;
    for (var i = 0; i < a.length; i++) s += a[i];
    return s / a.length;
  }

  function lastOf(seqs) {
    return seqs.length ? seqs[seqs.length - 1] : [];
  }

  /* 上期号码的邻号（±1，按号码池环绕） */
  function neighbors(prev, cfg) {
    var out = [];
    for (var i = 0; i < prev.length; i++) {
      var a = prev[i] - 1;
      var b = prev[i] + 1;
      if (a < cfg.min) a = cfg.max;
      if (b > cfg.max) b = cfg.min;
      out.push(a, b);
    }
    return out;
  }

  function tailOf(n) { return n % 10; }

  function zoneOf(n, cfg, parts) {
    var size = (cfg.max - cfg.min + 1) / parts;
    return Math.min(parts - 1, Math.floor((n - cfg.min) / size));
  }

  /* 按分数取前 pick 个；同分时取号码小的，保证确定性 */
  function topPick(scores, cfg) {
    var list = cands(cfg).slice();
    list.sort(function (a, b) {
      var d = (scores[b] || 0) - (scores[a] || 0);
      if (Math.abs(d) > 1e-12) return d;
      return a - b;
    });
    return list.slice(0, cfg.pick);
  }

  /* ---------------- 策略定义 ---------------- */

  var REG = [];

  function def(o) {
    if (!o.id || !o.score) throw new Error('策略缺少 id/score: ' + (o.id || '?'));
    REG.push(o);
  }

  /* ---------- 通用：频率 ---------- */

  function hot(w) {
    return function (view) {
      if (view.seqs.length < Math.min(w, 5)) return null;
      var recent = view.seqs.slice(-w);
      return norm(counts(recent, view.cfg), view.cfg);
    };
  }

  function cold(w) {
    return function (view) {
      if (view.seqs.length < Math.min(w, 5)) return null;
      var c = counts(view.seqs.slice(-w), view.cfg);
      var sc = {};
      for (var n in c) sc[n] = -c[n];
      return norm(sc, view.cfg);
    };
  }

  def({ id: 'hot10', name: '热号 10 期', family: '频率', need: 10,
    desc: '最近 10 期出现次数最多的号码。', score: hot(10) });
  def({ id: 'hot30', name: '热号 30 期', family: '频率', need: 10,
    desc: '最近 30 期出现次数最多的号码。', score: hot(30) });
  def({ id: 'hot100', name: '热号 100 期', family: '频率', need: 20,
    desc: '最近 100 期出现次数最多的号码。', score: hot(100) });
  def({ id: 'cold10', name: '冷号 10 期', family: '频率', need: 10,
    desc: '最近 10 期出现最少的号码（补冷）。', score: cold(10) });
  def({ id: 'cold30', name: '冷号 30 期', family: '频率', need: 10,
    desc: '最近 30 期出现最少的号码。', score: cold(30) });

  def({ id: 'bayes', name: '贝叶斯平滑', family: '频率', need: 20,
    desc: 'Dirichlet(α=0.5) 后验均值，避免小样本热号被过度放大。',
    score: function (view) {
      if (view.seqs.length < 20) return null;
      var w = Math.min(60, view.seqs.length);
      var recent = view.seqs.slice(-w);
      var c = counts(recent, view.cfg);
      var K = view.cfg.max - view.cfg.min + 1;
      var alpha = 0.5;
      var sc = {};
      for (var n in c) sc[n] = (c[n] + alpha) / (recent.length * view.cfg.pick + alpha * K);
      return norm(sc, view.cfg);
    } });

  /* ---------- 通用：遗漏与间隔 ---------- */

  def({ id: 'omission', name: '最大遗漏', family: '遗漏', need: 10,
    desc: '当前遗漏期数最长的号码（追长冷）。',
    score: function (view) {
      if (view.seqs.length < 10) return null;
      var sc = {}, list = cands(view.cfg);
      for (var i = 0; i < list.length; i++) sc[list[i]] = omission(view.seqs, list[i]);
      return norm(sc, view.cfg);
    } });

  def({ id: 'gapratio', name: '逾期系数', family: '遗漏', need: 20,
    desc: '当前遗漏 ÷ 历史平均间隔。比值越大，代表「比平时更久没出」。',
    score: function (view) {
      if (view.seqs.length < 20) return null;
      var sc = {}, list = cands(view.cfg);
      for (var i = 0; i < list.length; i++) {
        var n = list[i];
        var g = gaps(view.seqs, n);
        var avg = mean(g) || 1;
        sc[n] = omission(view.seqs, n) / avg;
      }
      return norm(sc, view.cfg);
    } });

  /* ---------- 通用：形态 ---------- */

  def({ id: 'repeat', name: '重号延续', family: '形态', need: 5,
    desc: '上期出现过的号码，认为有延续性。',
    score: function (view) {
      if (!view.seqs.length) return null;
      var prev = lastOf(view.seqs), sc = {};
      var list = cands(view.cfg);
      for (var i = 0; i < list.length; i++) sc[list[i]] = prev.indexOf(list[i]) !== -1 ? 1 : 0;
      return norm(sc, view.cfg);
    } });

  def({ id: 'neighbor', name: '邻号', family: '形态', need: 5,
    desc: '上期号码的 ±1 邻号。',
    score: function (view) {
      if (!view.seqs.length) return null;
      var nb = neighbors(lastOf(view.seqs), view.cfg);
      var sc = {}, list = cands(view.cfg);
      for (var i = 0; i < list.length; i++) sc[list[i]] = nb.indexOf(list[i]) !== -1 ? 1 : 0;
      return norm(sc, view.cfg);
    } });

  def({ id: 'tailhot', name: '尾数热', family: '形态', need: 10,
    desc: '最近 30 期出现最多的尾数，其对应的号码加分。',
    score: function (view) {
      if (view.seqs.length < 10) return null;
      var recent = view.seqs.slice(-30);
      var tf = {}, i, j;
      for (i = 0; i < 10; i++) tf[i] = 0;
      for (i = 0; i < recent.length; i++) {
        for (j = 0; j < recent[i].length; j++) tf[tailOf(recent[i][j])]++;
      }
      var sc = {}, list = cands(view.cfg);
      for (i = 0; i < list.length; i++) sc[list[i]] = tf[tailOf(list[i])] || 0;
      return norm(sc, view.cfg);
    } });

  def({ id: 'zonecold', name: '区间回补', family: '形态', need: 20,
    desc: '把号码池分 3 区，统计最近 10 期各区出现次数，回补最冷的区。',
    score: function (view) {
      if (view.seqs.length < 20) return null;
      var recent = view.seqs.slice(-10), i, j;
      var zc = [0, 0, 0];
      for (i = 0; i < recent.length; i++) {
        for (j = 0; j < recent[i].length; j++) zc[zoneOf(recent[i][j], view.cfg, 3)]++;
      }
      var maxZ = Math.max(zc[0], zc[1], zc[2]);
      var sc = {}, list = cands(view.cfg);
      for (i = 0; i < list.length; i++) {
        var z = zoneOf(list[i], view.cfg, 3);
        sc[list[i]] = maxZ - zc[z];
      }
      return norm(sc, view.cfg);
    } });

  /* ---------- 通用：转移 ---------- */

  def({ id: 'markov1', name: '一阶马尔可夫', family: '转移', need: 30,
    desc: '统计历史「上期含 A → 下期含 B」的转移频率，从上一期每个号出发预测。',
    score: function (view) {
      var seqs = view.seqs;
      if (seqs.length < 30) return null;
      var trans = {}, i, j, k;
      for (i = 1; i < seqs.length; i++) {
        var prev = seqs[i - 1], cur = seqs[i];
        for (j = 0; j < prev.length; j++) {
          var a = prev[j];
          if (!trans[a]) trans[a] = {};
          for (k = 0; k < cur.length; k++) {
            trans[a][cur[k]] = (trans[a][cur[k]] || 0) + 1;
          }
        }
      }
      var sc = {}, list = cands(view.cfg);
      for (i = 0; i < list.length; i++) sc[list[i]] = 0;
      var last = lastOf(seqs);
      for (j = 0; j < last.length; j++) {
        var m = trans[last[j]];
        if (!m) continue;
        var total = 0;
        for (k in m) total += m[k];
        if (!total) continue;
        for (k in m) {
          var nb = +k;
          if (sc[nb] !== undefined) sc[nb] += m[k] / total;
        }
      }
      return norm(sc, view.cfg);
    } });

  def({ id: 'cooccur', name: '共现伙伴', family: '转移', need: 30,
    desc: '历史上与上期号码同时出现的次数最多的号（同期共现）。',
    score: function (view) {
      var seqs = view.seqs;
      if (seqs.length < 30) return null;
      var co = {}, i, j, k;
      for (i = 0; i < seqs.length; i++) {
        var row = seqs[i];
        for (j = 0; j < row.length; j++) {
          if (!co[row[j]]) co[row[j]] = {};
          for (k = 0; k < row.length; k++) {
            if (k === j) continue;
            co[row[j]][row[k]] = (co[row[j]][row[k]] || 0) + 1;
          }
        }
      }
      var sc = {}, list = cands(view.cfg);
      for (i = 0; i < list.length; i++) sc[list[i]] = 0;
      var last = lastOf(seqs);
      for (j = 0; j < last.length; j++) {
        var m = co[last[j]];
        if (!m) continue;
        for (k in m) {
          var nb = +k;
          if (sc[nb] !== undefined) sc[nb] += m[k];
        }
      }
      return norm(sc, view.cfg);
    } });

  /* ---------- 通用：基线与融合 ---------- */

  def({ id: 'random', name: '随机基线', family: '基线', need: 1,
    desc: '用期号做种子的确定性随机。它是所有策略的对照组：任何策略都不应长期显著优于它。',
    score: function (view) {
      var rnd = mulberry32(hashStr('random|' + view.game + '|' + view.zone + '|' + view.issue));
      var sc = {}, list = cands(view.cfg);
      for (var i = 0; i < list.length; i++) sc[list[i]] = rnd();
      return norm(sc, view.cfg);
    } });

  def({ id: 'balanced', name: '均衡融合', family: '融合', need: 30,
    desc: '热号 30 期 + 遗漏 + 尾数热的 z 分数等权平均，避免单一维度走极端。',
    score: function (view) {
      if (view.seqs.length < 30) return null;
      var cfg = view.cfg;
      var h = norm(counts(view.seqs.slice(-30), cfg), cfg);
      var o = {}, list = cands(cfg), i, j;
      for (i = 0; i < list.length; i++) o[list[i]] = omission(view.seqs, list[i]);
      o = norm(o, cfg);
      var recent = view.seqs.slice(-30), tf = {};
      for (i = 0; i < 10; i++) tf[i] = 0;
      for (i = 0; i < recent.length; i++) {
        for (j = 0; j < recent[i].length; j++) tf[tailOf(recent[i][j])]++;
      }
      var t = {};
      for (i = 0; i < list.length; i++) t[list[i]] = tf[tailOf(list[i])] || 0;
      t = norm(t, cfg);
      var sc = {};
      for (i = 0; i < list.length; i++) {
        var n = list[i];
        sc[n] = (h[n] + o[n] + t[n]) / 3;
      }
      return norm(sc, cfg);
    } });

  def({ id: 'cycle', name: '周期轮换', family: '融合', need: 20,
    desc: '按历史长度在 10 / 30 / 60 / 100 期热号之间轮换，模拟「换周期看号」的做法。',
    score: function (view) {
      if (view.seqs.length < 20) return null;
      var wins = [10, 30, 60, 100];
      var w = wins[view.seqs.length % wins.length];
      var recent = view.seqs.slice(-w);
      return norm(counts(recent, view.cfg), view.cfg);
    } });

  /* ---------- 数字型：胆码 / 杀号 ---------- */

  function danma(k) {
    return function (view) {
      if (!isDigit(view.cfg)) return null;
      if (view.seqs.length < k) return null;
      var recent = view.seqs.slice(-k);
      var hit = {}, i, j;
      for (i = 0; i < 10; i++) hit[i] = 0;
      for (i = 0; i < recent.length; i++) {
        var seen = {};
        for (j = 0; j < recent[i].length; j++) {
          if (seen[recent[i][j]]) continue;
          seen[recent[i][j]] = 1;
          hit[recent[i][j]]++;
        }
      }
      var sc = {};
      for (i = 0; i < 10; i++) {
        /* 连续 k 期都出现 = 强胆（k+1 分）；出现过但不满 k 期 = 部分分 */
        sc[i] = hit[i] >= k ? k + 1 : (hit[i] / k);
      }
      return norm(sc, view.cfg);
    };
  }

  function dudan(k) {
    return function (view) {
      if (!isDigit(view.cfg)) return null;
      if (view.seqs.length < k + 5) return null;
      var recent = view.seqs.slice(-k);
      var seen = {}, i, j;
      for (i = 0; i < 10; i++) seen[i] = 0;
      for (i = 0; i < recent.length; i++) {
        for (j = 0; j < recent[i].length; j++) seen[recent[i][j]]++;
      }
      var sc = {};
      for (i = 0; i < 10; i++) {
        /* 最近 k 期出现越少，越接近「被杀的冷号」；这里反向作为选号分数，
           用于检验「冷号该杀」是否成立：若命中率显著低于随机，杀号才有依据。 */
        sc[i] = k - seen[i];
      }
      return norm(sc, view.cfg);
    };
  }

  def({ id: 'danma3', name: '胆码 3 期', family: '胆码', need: 10, digit: true,
    desc: '最近 3 期都出现过的数字（连续命中），配合连中期数过滤。',
    score: danma(3) });
  def({ id: 'danma5', name: '胆码 5 期', family: '胆码', need: 12, digit: true,
    desc: '最近 5 期都出现过的数字。',
    score: danma(5) });
  def({ id: 'dudan3', name: '杀号反选 3 期', family: '胆码', need: 10, digit: true,
    desc: '反向检验：选最近 3 期没出现过的数字。若它的命中率显著低于随机，才说明「冷号该杀」成立。',
    score: dudan(3) });
  def({ id: 'dudan5', name: '杀号反选 5 期', family: '胆码', need: 12, digit: true,
    desc: '反向检验：选最近 5 期没出现过的数字。',
    score: dudan(5) });

  /* ---------- 快乐8 专属 ---------- */

  def({ id: 'kl8spread', name: '四区均衡', family: '形态', need: 20, games: ['kl8'],
    desc: '1–80 分 4 区，回补最近 10 期最冷的区，避免号码集中在一段。',
    score: function (view) {
      if (view.seqs.length < 20) return null;
      var recent = view.seqs.slice(-10), i, j;
      var zc = [0, 0, 0, 0];
      for (i = 0; i < recent.length; i++) {
        for (j = 0; j < recent[i].length; j++) zc[zoneOf(recent[i][j], view.cfg, 4)]++;
      }
      var maxZ = Math.max.apply(null, zc);
      var sc = {}, list = cands(view.cfg);
      for (i = 0; i < list.length; i++) {
        sc[list[i]] = maxZ - zc[zoneOf(list[i], view.cfg, 4)];
      }
      return norm(sc, view.cfg);
    } });

  def({ id: 'kl8cooccur', name: '共现图谱', family: '转移', need: 40, games: ['kl8'],
    desc: '快乐8 每期开 20 个，共现结构比单号热度更有信息量；按历史同期共现率加权。',
    score: function (view) {
      var seqs = view.seqs;
      if (seqs.length < 40) return null;
      var co = {}, i, j, k;
      for (i = 0; i < seqs.length; i++) {
        var row = seqs[i];
        for (j = 0; j < row.length; j++) {
          if (!co[row[j]]) co[row[j]] = {};
          for (k = 0; k < row.length; k++) {
            if (k === j) continue;
            co[row[j]][row[k]] = (co[row[j]][row[k]] || 0) + 1;
          }
        }
      }
      var sc = {}, list = cands(view.cfg);
      for (i = 0; i < list.length; i++) sc[list[i]] = 0;
      var last = lastOf(seqs);
      for (j = 0; j < last.length; j++) {
        var m = co[last[j]];
        if (!m) continue;
        for (k in m) {
          var nb = +k;
          if (sc[nb] !== undefined) sc[nb] += m[k] / seqs.length;
        }
      }
      return norm(sc, view.cfg);
    } });

  /* ---------- 玄学对照组 ---------- */

  /* 期号 → 六十四卦序号。过程可解释、可复现，但本质是把期号映射成均匀分布。 */
  function guaOf(issue) {
    var h = hashStr('zhouyi|' + issue);
    var up = (h % 8) + 1;
    var down = ((h >>> 3) % 8) + 1;
    return (up - 1) * 8 + down; /* 1..64 */
  }

  def({ id: 'zhouyi', name: '周易卦象（对照组）', family: '玄学', need: 1, mystic: true,
    desc: '把期号映射为六十四卦，再按卦序取模分配到号码池。与随机同源，仅作对照组。',
    score: function (view) {
      var gua = guaOf(view.issue);
      var rnd = mulberry32(hashStr('gua|' + gua + '|' + view.cfg.min + '-' + view.cfg.max));
      var sc = {}, list = cands(view.cfg);
      for (var i = 0; i < list.length; i++) {
        /* 卦序决定起点，随机决定其余：保证同卦同期可复现 */
        var span = list.length;
        sc[list[i]] = ((i + gua) % span) * 0.001 + rnd();
      }
      return norm(sc, view.cfg);
    } });

  def({ id: 'qimen', name: '奇门八门（对照组）', family: '玄学', need: 1, mystic: true,
    desc: '用开奖日期的天干地支推八门序，再取模映射到号码池。与随机同源，仅作对照组。',
    score: function (view) {
      var base = hashStr('qimen|' + view.issue + '|' + (view.date || ''));
      var men = (base % 8) + 1;
      var rnd = mulberry32(hashStr('men|' + men));
      var sc = {}, list = cands(view.cfg);
      for (var i = 0; i < list.length; i++) sc[list[i]] = rnd() + ((i + men) % 8) * 0.02;
      return norm(sc, view.cfg);
    } });

  def({ id: 'taiyi', name: '太乙积年（对照组）', family: '玄学', need: 1, mystic: true,
    desc: '把期号当作积年数取太乙局，再取模映射。与随机同源，仅作对照组。',
    score: function (view) {
      var issueNum = parseInt(String(view.issue).replace(/\D/g, ''), 10) || 1;
      var ju = issueNum % 72;
      var rnd = mulberry32(hashStr('taiyi|' + ju));
      var sc = {}, list = cands(view.cfg);
      for (var i = 0; i < list.length; i++) sc[list[i]] = rnd() + ((i * ju) % list.length) * 0.0005;
      return norm(sc, view.cfg);
    } });

  /* ---------------- 对外接口 ---------------- */

  /* 某彩种某区可用的策略（含 zone 适配过滤） */
  S.forZone = function (game, zone, cfg) {
    var out = [];
    for (var i = 0; i < REG.length; i++) {
      var s = REG[i];
      if (s.games && s.games.indexOf(game) === -1) continue;
      if (s.digit && !isDigit(cfg)) continue;
      out.push(s);
    }
    return out;
  };

  S.all = function () { return REG.slice(); };

  /* 构建一个只含历史的视图：draws[0..i-1]，绝不包含第 i 期。
     i 可以等于 draws.length，表示「预测下一期」，此时 issue 用 nextIssue。 */
  S.view = function (draws, game, zone, cfg, i, nextIssue) {
    var seqs = [];
    for (var t = 0; t < i && t < draws.length; t++) {
      var arr = draws[t][zone];
      if (arr) seqs.push(arr);
    }
    var issue, date;
    if (i < draws.length) {
      issue = String(draws[i].issue);
      date = draws[i].date;
    } else {
      issue = String(nextIssue || (draws.length ? draws[draws.length - 1].issue : '0'));
      date = draws.length ? draws[draws.length - 1].date : '';
    }
    return {
      game: game,
      zone: zone,
      cfg: cfg,
      seqs: seqs,
      issue: issue,
      date: date
    };
  };

  /* 运行一个策略，返回 { numbers, scores, raw }，数据不足时 numbers 为空 */
  S.run = function (strategy, view) {
    var raw = strategy.score(view);
    if (!raw) return { strategy: strategy.id, numbers: [], scores: null };
    var nums = topPick(raw, view.cfg).sort(function (a, b) { return a - b; });
    return { strategy: strategy.id, numbers: nums, scores: raw };
  };

  /* 一次算出某区所有策略的推荐（供前端展示与回测） */
  S.runAll = function (strategies, view) {
    var out = [];
    for (var i = 0; i < strategies.length; i++) {
      var r = S.run(strategies[i], view);
      if (r.numbers.length) out.push(r);
    }
    return out;
  };

  /* 超几何期望与方差：从 N 个号中选 k，开奖开 m 个 */
  S.expected = function (cfg, drawPick) {
    var N = cfg.max - cfg.min + 1;
    var k = cfg.pick;
    var m = drawPick === undefined ? cfg.pick : drawPick;
    var p = m / N;
    var e = k * p;
    var v = k * p * (1 - p) * (N - k) / (N - 1);
    return { expected: e, variance: v };
  };

  S.util = { cands: cands, norm: norm, topPick: topPick, hashStr: hashStr, mulberry32: mulberry32, isDigit: isDigit };

  root.LotteryStrategies = S;
  if (typeof module !== 'undefined' && module.exports) module.exports = S;
})(typeof globalThis !== 'undefined' ? globalThis : this);

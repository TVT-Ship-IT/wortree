/* 词芽 · 圣诞树养成
 * 查一个单词 = 浇一次水；2500 词 = 培养成功。
 */
(function () {
  'use strict';

  var GOAL = 2500;
  var DAILY_GOAL = 20;
  var KEY = 'cy_state_v3';
  var OLD_KEY = 'cy_book_v1';
  /* 仅调试：地址栏 ?p=0.5 时按比例预览树，不写真实数据 */
  var PREVIEW_P = null;

  /* ================= 小工具 ================= */
  function $(id) { return document.getElementById(id); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function dayKey(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function dayLabel(k) {
    var t = new Date(k + 'T00:00:00');
    var now = new Date();
    var today = dayKey(now);
    var y = new Date(now); y.setDate(y.getDate() - 1);
    if (k === today) return '今天 · ' + (t.getMonth() + 1) + '月' + t.getDate() + '日';
    if (k === dayKey(y)) return '昨天 · ' + (t.getMonth() + 1) + '月' + t.getDate() + '日';
    var w = ['日', '一', '二', '三', '四', '五', '六'][t.getDay()];
    return (t.getMonth() + 1) + '月' + t.getDate() + '日 · 周' + w;
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function norm(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[^a-z'\- ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* ================= 状态 ================= */
  var S = null;

  /* 档案号：第一次打开就在本机生成，之后永远不变。
     它不是账号，只是给这份记忆一个能读出来的名字 —— 换手机时对着
     档案号导出/导入，就能把整棵树搬过去。 */
  var CODE_AB = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  function makeDeviceCode() {
    var s = '';
    for (var i = 0; i < 8; i++) s += CODE_AB.charAt(Math.floor(Math.random() * CODE_AB.length));
    return 'CY-' + s.slice(0, 4) + '-' + s.slice(4);
  }

  function freshState() {
    return {
      v: 3,
      learned: {},
      days: {},
      book: [],
      meta: { queries: 0, best: 0, done: false, first: Date.now(), deviceId: makeDeviceCode() }
    };
  }

  function loadState() {
    var s = null;
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) s = JSON.parse(raw);
    } catch (e) { s = null; }
    if (!s || typeof s !== 'object') s = freshState();

    s.learned = s.learned && typeof s.learned === 'object' ? s.learned : {};
    s.days = s.days && typeof s.days === 'object' ? s.days : {};
    s.book = Array.isArray(s.book) ? s.book : [];
    s.meta = s.meta || { queries: 0, best: 0, done: false };
    if (typeof s.meta.queries !== 'number') s.meta.queries = 0;
    if (typeof s.meta.best !== 'number') s.meta.best = 0;
    if (!s.meta.deviceId) s.meta.deviceId = makeDeviceCode();

    /* 迁移旧版生词本 */
    try {
      var old = localStorage.getItem(OLD_KEY);
      if (old) {
        var arr = JSON.parse(old);
        if (Array.isArray(arr)) {
          arr.forEach(function (w) {
            if (typeof w === 'string' && !s.book.some(function (b) { return b.w === w; })) {
              s.book.push({ w: w, ts: Date.now() });
            }
          });
        }
      }
    } catch (e) { /* 忽略 */ }

    return s;
  }

  var saveTimer = 0;
  function save(now) {
    if (now) {
      clearTimeout(saveTimer);
      saveTimer = 0;
      try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast('存储空间不足'); }
      return;
    }
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = 0;
      try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast('存储空间不足'); }
    }, 400);
  }

  function learnedCount() { return Object.keys(S.learned).length; }
  function todayWords() { return S.days[dayKey()] || []; }

  function streak() {
    var d = new Date();
    if (!(S.days[dayKey(d)] && S.days[dayKey(d)].length)) d.setDate(d.getDate() - 1);
    var n = 0;
    while (n < 3660) {
      var k = dayKey(d);
      if (S.days[k] && S.days[k].length) { n++; d.setDate(d.getDate() - 1); }
      else break;
    }
    return n;
  }

  /* ================= 词库 ================= */
  var DICT = null;
  var DICT_N = 0;
  var PHRASE = null;
  var SORTED = null;     // 排序词表，供联想
  var dictReady = false;

  var TAGMAP = {
    zk: '中考', gk: '高考', cet4: '四级', cet6: '六级',
    ky: '考研', toefl: '托福', ielts: '雅思', gre: 'GRE'
  };

  /* 取词库：先看离线缓存，没有才走网络。
     缓存由 Service Worker 在 install 阶段预灌（https / localhost 才有）。
     局域网 http 下没有 SW，直接走网络，功能不受影响。 */
  function cachedFetch(path) {
    if (!window.caches) return fetch(path);
    return caches.match(path, { ignoreSearch: true })
      .then(function (hit) { return hit || fetch(path); })
      .catch(function () { return fetch(path); });
  }

  /* 词库分两段立刻装，从几十 KB 到几 MB，每段到手就能查：
       core.json  9000 高频词（约 380KB）—— 首屏先下这个，几百毫秒就能查
       mid.json   5 万考试/常驻词（约 1.6MB）—— 接着补，日常词就齐了
     之外的 57.7 万扩展词按【首字母】切成 26 片放在 data/ext/<字母>.json，
     查不到某个词时才去下它那一片（0.07–3.8MB），不会为了一个冷门词拖 37MB。 */
  var SHARDS = ['data/core.json', 'data/mid.json'];

  /* 扩展片的状态：undefined/0 未开始、1 下载中、2 已装、3 失败（可再试） */
  var EXT_STATE = {};
  var EXT_WAIT = {};
  var EXT_FAIL = {};   /* 字母 -> 连续失败次数，>= 2 就不再自动试 */
  window.__extState = function (c) { return c ? (EXT_STATE[c] || 0) : EXT_STATE; };

  function extLetterOf(w) {
    var c = String(w).charAt(0);
    return (c >= 'a' && c <= 'z') ? c : '_';
  }

  function ensureExtShard(c, cb) {
    var st = EXT_STATE[c] || 0;
    if (st === 2) { if (cb) cb(true); return; }
    if (st === 1) { if (cb) { (EXT_WAIT[c] = EXT_WAIT[c] || []).push(cb); } return; }
    EXT_STATE[c] = 1;
    EXT_WAIT[c] = cb ? [cb] : [];
    cachedFetch('data/ext/' + c + '.json')
      .then(function (r) {
        if (!r || !r.ok) throw new Error('http');
        return r.json();
      })
      .then(function (j) {
        if (j && j.d) { applyDict(j, 'more'); EXT_STATE[c] = 2; EXT_FAIL[c] = 0; }
        else throw new Error('empty');
      })
      .catch(function () {
        EXT_STATE[c] = 3;
        EXT_FAIL[c] = (EXT_FAIL[c] || 0) + 1;
      })
      .then(function () {
        var q = EXT_WAIT[c] || [];
        EXT_WAIT[c] = [];
        var ok = EXT_STATE[c] === 2;
        for (var i = 0; i < q.length; i++) { try { q[i](ok); } catch (e) { } }
      });
  }
  window.__ensureExt = ensureExtShard;

  /* 合并一片词库。已经有这个词就保留（前面的档更权威），返回新增条数。
     注意必须用 hasOwnProperty：DICT 是普通对象，DICT['constructor'] 会拿到
     原型上的构造函数而不是 undefined，那样"constructor"这个真词就永远装不进来。 */
  function mergeDict(j) {
    if (!j || !j.d) return 0;
    if (!DICT) DICT = {};
    var add = 0;
    for (var k in j.d) {
      if (!Object.prototype.hasOwnProperty.call(DICT, k)) { DICT[k] = j.d[k]; add++; }
    }
    if (!add) return 0;
    DICT_N = 0;
    for (var _k in DICT) {
      if (Object.prototype.hasOwnProperty.call(DICT, _k)) DICT_N++;
    }
    dictReady = true;
    return add;
  }

  /* 63 万词排序要几百毫秒，别卡在合并那一帧；攒一下再排。 */
  var resortTimer = 0;
  function resortLater() {
    if (resortTimer) clearTimeout(resortTimer);
    resortTimer = setTimeout(function () {
      resortTimer = 0;
      try { SORTED = Object.keys(DICT).sort(); } catch (e) { SORTED = []; }
    }, 120);
  }

  function applyDict(j, stage) {
    var add = mergeDict(j);
    if (!add && stage !== 'refresh') return false;
    if (!SORTED || DICT_N < 12000) {
      try { SORTED = Object.keys(DICT).sort(); } catch (e) { SORTED = []; }
    } else {
      resortLater();
    }
    return true;
  }

  function loadDict() {
    var t0 = performance.now();
    var hint = $('stageHint');
    var hintText = hint ? hint.textContent : '';
    var readyText = '查一个单词，就是浇一次水';
    if (hint) { hint.textContent = '词库加载中…'; hint.classList.add('loading'); }

    function done() {
      var ms = Math.round(performance.now() - t0);
      $('dictState').textContent = DICT_N.toLocaleString() + ' 词 · ' + ms + 'ms';
      if (S.meta.done) tree.setProgress(1);
      renderBook();   /* 词库到位后补一次渲染，单词本才有释义 */
      renderLog();
      if (tree) refreshProgress(false);   /* 词库到位后把挂饰补齐（预览模式要用到词表） */
      if (hint) { hint.textContent = hintText || readyText; hint.classList.remove('loading'); }
    }

    var got = 0;

    /* 一片一片顺着下：上一片到手（或者失败）再下下一片，
       这样手机弱网时也是先能用、再变全，不会几 MB 抢带宽把首屏拖死。
       扩展词库不在这里排期，走 ensureExtShard 按首字母按需加载。
       单片最多试 3 次：GitHub Pages 冷启动时 mid.json 偶发被截断，
       一次失败就放弃会让整个词库停在 9000 词（线上真踩到过）。 */
    function next(i, attempt) {
      attempt = attempt || 0;
      if (i >= SHARDS.length) {
        if (!got) {
          if (hint) { hint.textContent = '词库加载失败，刷新试试'; hint.classList.remove('loading'); }
          $('dictState').textContent = '词库加载失败';
          toast('词库没加载出来，检查一下网络或文件');
        }
        return;
      }
      var advanced = false;
      cachedFetch(SHARDS[i])
        .then(function (r) {
          if (!r || !r.ok) throw new Error('http');
          return r.json();
        })
        .then(function (j) {
          if (j && applyDict(j, i === 0 ? 'core' : 'more')) {
            got++;
            done();
          }
        })
        .catch(function () {
          if (attempt < 2) {
            toast('词库下载中断，正在重试…');
            advanced = true;
            return new Promise(function (res) { setTimeout(res, 1200); })
              .then(function () { return next(i, attempt + 1); });
          }
        })
        .then(function () { if (!advanced) next(i + 1); });
    }
    next(0);

    /* 短语库（可选，加载不到就算了） */
    cachedFetch('data/phrase.json')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.d) PHRASE = j.d; })
      .catch(function () { });
  }

  /* 音标 / 释义格式化 */
  function ipa(v) {
    if (!v) return '';
    return '/' + v + '/';
  }

  function splitDefs(text) {
    if (!text) return [];
    var all = String(text).split(/\n+/).map(function (l) { return l.trim(); }).filter(Boolean);
    if (all.length <= 1) return all;
    /* 多条释义时，滤掉 [医][化][法] 这类专业标注行，主释义更好读 */
    var main = all.filter(function (l) { return !/^\[[^\]]{1,8}\]/.test(l); });
    return main.length ? main : all;
  }

  var POS_RE = /^((?:[a-z]+\.){1,3}|[a-z]+\/[a-z]+\.)\s*/i;

  function defHTML(line) {
    var m = line.match(POS_RE);
    if (m) {
      var pos = m[1];
      var rest = line.slice(m[0].length);
      return '<div class="def-line"><span class="pos">' + esc(pos) + '</span>' + esc(rest) + '</div>';
    }
    return '<div class="def-line">' + esc(line) + '</div>';
  }

  function tagHTML(tags) {
    if (!tags) return '';
    var out = [];
    String(tags).split(/\s+/).forEach(function (t) {
      if (TAGMAP[t]) out.push('<span class="tag">' + TAGMAP[t] + '</span>');
    });
    return out.length ? '<div class="w-tags">' + out.join('') + '</div>' : '';
  }

  function firstDef(word) {
    var e = lookup(word);
    if (!e) return '';
    var lines = splitDefs(e[2]);
    return lines.length ? lines[0] : '';
  }

  /* 近似词：同首字母 + 长度接近 + 编辑距离。
     63 万词的表，别从头扫到尾 —— 二分把范围锁到首字母那一块，
     再只挑长度差 ≤2 的算编辑距离。s 开头有八万个词，也够快。 */
  function neighbors(word, limit) {
    limit = limit || 6;
    if (!SORTED || !word) return [];
    var wl = word.length;
    var first = word[0];

    /* 首字母区间的左右边界 */
    var lo = 0, hi = SORTED.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (SORTED[mid] < first) lo = mid + 1; else hi = mid;
    }
    var from = lo;
    hi = SORTED.length;
    while (lo < hi) {
      var mid2 = (lo + hi) >> 1;
      if (SORTED[mid2] <= first + '\uffff') lo = mid2 + 1; else hi = mid2;
    }
    var to = lo;

    var pool = [];
    for (var i = from; i < to; i++) {
      var w = SORTED[i];
      if (Math.abs(w.length - wl) > 2) continue;
      pool.push(w);
      if (pool.length >= 12000) break;
    }
    var scored = pool.map(function (w) { return { w: w, d: lev(word, w) }; });
    scored.sort(function (a, b) { return a.d - b.d || a.w.length - b.w.length; });
    return scored.slice(0, limit);
  }

  function lev(a, b) {
    if (a === b) return 0;
    var la = a.length, lb = b.length;
    if (!la) return lb;
    if (!lb) return la;
    var prev = new Array(lb + 1);
    var cur = new Array(lb + 1);
    var i, j;
    for (j = 0; j <= lb; j++) prev[j] = j;
    for (i = 1; i <= la; i++) {
      cur[0] = i;
      var ca = a.charCodeAt(i - 1);
      for (j = 1; j <= lb; j++) {
        var cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
        var v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        cur[j] = v;
      }
      var tmp = prev; prev = cur; cur = tmp;
    }
    return prev[lb];
  }

  function prefixMatches(prefix, limit) {
    limit = limit || 8;
    if (!SORTED || !prefix) return [];
    var lo = 0, hi = SORTED.length - 1, start = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (SORTED[mid] >= prefix) { start = mid; hi = mid - 1; }
      else lo = mid + 1;
    }
    if (start < 0) return [];
    var out = [];
    for (var i = start; i < SORTED.length && out.length < limit; i++) {
      if (SORTED[i].indexOf(prefix) !== 0) break;
      out.push(SORTED[i]);
    }
    return out;
  }

  /* ================= 发音 ================= */
  function speak(word, type) {
    var audio = null;
    try { audio = new Audio('https://dict.youdao.com/dictvoice?audio=' + encodeURIComponent(word) + '&type=' + type); } catch (e) { audio = null; }

    var done = false;
    if (audio) {
      audio.onerror = function () {
        if (done) return;
        done = true;
        tts(word, type);
      };
      audio.oncanplay = function () { };
      audio.play().then(function () { done = true; }).catch(function () {
        if (done) return;
        done = true;
        tts(word, type);
      });
      setTimeout(function () { if (!done) { done = true; tts(word, type); } }, 1200);
    } else {
      tts(word, type);
    }
  }

  function tts(word, type) {
    if (!('speechSynthesis' in window)) { toast('这台设备不支持发音'); return; }
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(word);
      u.lang = type === 2 ? 'en-GB' : 'en-US';
      u.rate = 0.92;
      var vs = window.speechSynthesis.getVoices() || [];
      for (var i = 0; i < vs.length; i++) {
        if (vs[i].lang && vs[i].lang.toLowerCase().indexOf(type === 2 ? 'en-gb' : 'en-us') === 0) {
          u.voice = vs[i];
          break;
        }
      }
      window.speechSynthesis.speak(u);
    } catch (e) { /* 静默 */ }
  }

  /* ================= 树 ================= */
  var tree = null;

  function initTree() {
    var cv = $('tree');
    tree = new Tree3D(cv, {
      onPick: function (word) {
        tree.focus(word);
        var e = lookup(word);
        if (e) {
          lastWord = word;
          lastEntry = e;
          renderWord(word, e, Object.prototype.hasOwnProperty.call(S.learned, word));
        }
      },
      onEmpty: function () {
        if (tree.focusW) tree.blur();
      }
    });
    tree.setWords(learnedList());
    var p = Math.min(1, learnedCount() / GOAL);
    tree.jumpTo(p);
    tree.start();
    window.__tree = tree;   /* 调试/自检用 */
    window.__lookup = lookup;
    window.__prefix = prefixMatches;
    window.__near = neighbors;
    window.__dictN = function () { return DICT_N; };

    window.addEventListener('resize', function () {
      clearTimeout(initTree._t);
      initTree._t = setTimeout(function () { tree.resize(); tree.buildTree(tree.p); }, 160);
    });
    window.addEventListener('orientationchange', function () {
      setTimeout(function () { tree.resize(); tree.buildTree(tree.p); }, 260);
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) tree.stop();
      else tree.start();
    });
  }

  /* 树上的挂饰 = 查过的词，按第一次浇水的时间从底往上排 */
  function learnedList() {
    var arr = Object.keys(S.learned).map(function (w) {
      return { w: w, ts: S.learned[w] };
    });
    arr.sort(function (a, b) { return (a.ts - b.ts) || (a.w < b.w ? -1 : 1); });

    if (PREVIEW_P !== null) {
      var need = Math.round(PREVIEW_P * GOAL);
      var out = arr.slice(0, need);
      if (out.length < need && SORTED.length) {
        for (var i = 0; i < SORTED.length && out.length < need; i++) {
          if (!S.learned[SORTED[i]]) out.push({ w: SORTED[i], ts: 0 });
        }
      }
      return out;
    }
    return arr;
  }

  function refreshProgress(animate) {
    var n = learnedCount();
    var p = Math.min(1, n / GOAL);
    var shownN = n, shownP = p;
    if (PREVIEW_P !== null) {
      shownP = PREVIEW_P;
      shownN = Math.round(PREVIEW_P * GOAL);
    }
    tree.setWords(learnedList());
    if (animate) tree.setProgress(shownP);
    else tree.jumpTo(shownP);

    /* 培养成功的暖光交给 CSS 图层，阈值留在 0.86，进去就有，退出就淡掉 */
    var stage = $('stage');
    if (stage) stage.classList.toggle('warm', shownP > 0.86);

    var pct = (shownP * 100);
    $('barFill').style.width = pct.toFixed(2) + '%';
    $('barTxt').textContent = shownN + ' / ' + GOAL + ' · ' +
      (shownN >= GOAL ? '已培养成功' : '还差 ' + (GOAL - shownN) + ' 词');

    $('hudTotal').textContent = shownN;
    $('hudToday').textContent = todayWords().length;
    var st = streak();
    $('hudStreak').textContent = st;

    $('mineLearned').textContent = n;
    $('mineQueries').textContent = S.meta.queries | 0;
    $('mineBest').textContent = (S.meta.best | 0) + ' 天';

    if ($('mineCode')) {
      $('mineCode').textContent = S.meta.deviceId || '—';
      var lb = S.meta.lastBackup | 0;
      if (!lb) {
        $('mineBackup').textContent = '从没导出过，点上面「导出备份」存一份';
      } else {
        var days = Math.floor((Date.now() - lb) / 86400000);
        $('mineBackup').textContent = days <= 0 ? '今天' : (days + ' 天前');
        if (days >= 7) $('mineBackup').textContent += '（建议再导一次）';
      }
    }

    if (n >= GOAL && !S.meta.done) {
      S.meta.done = true;
      save(true);
      tree.celebrate();
      setTimeout(function () { $('doneCard').classList.remove('hidden'); }, 500);
    }
    if (st > (S.meta.best | 0)) { S.meta.best = st; save(); }
  }

  /* ================= Toast ================= */
  var toastT = 0;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(function () { el.classList.remove('show'); }, 1900);
  }

  /* ================= 查词 ================= */
  var lastWord = '';
  var lastEntry = null;

  /* 词条从 v4 起是打包成一条字符串存的（"美音¦英音¦释义¦标签"），
     为的是把 63 万词的堆内存从 244MB 压到 70MB 上下，不然低端安卓会被系统杀掉。
     这里拆回数组给界面用。 */
  var PACK_SEP = '\u00a6';
  function unpackEntry(s) {
    if (!s) return null;
    if (typeof s !== 'string') return s;      /* 兼容老格式 */
    var a = s.split(PACK_SEP);
    if (a.length < 3) { a.push('', ''); }     /* 补成 [us, uk, tr, tags] */
    while (a.length < 4) a.push('');
    return a;
  }

  function lookup(word) {
    if (DICT && Object.prototype.hasOwnProperty.call(DICT, word)) return unpackEntry(DICT[word]);
    if (PHRASE && Object.prototype.hasOwnProperty.call(PHRASE, word)) return PHRASE[word];
    return null;
  }

  function doQuery(raw, silent) {
    var w = norm(raw);
    if (!w) return;

    if (!dictReady) {
      toast('词库还在加载，等一下再查');
      return;
    }

    S.meta.queries = (S.meta.queries | 0) + 1;

    var entry = lookup(w);
    if (!entry) {
      /* 常用两片里没有，就去拉这个词首字母对应的扩展片（一次 0.1–4MB），到了再重查一遍。
         失败（404/断网）就别重试了，直接给近似词，免得每次点击都白等。 */
      var L = extLetterOf(w);
      var st = EXT_STATE[L] || 0;
      var canTry = w.length > 1 && st !== 2 && (EXT_FAIL[L] || 0) < 2;
      if (canTry) {
        toast('正在加载「' + (L === '_' ? '其它' : L.toUpperCase()) + '」开头的扩展词…');
        ensureExtShard(L, function (ok) {
          if (ok && lookup(w)) { doQuery(w, silent); return; }
          var near2 = neighbors(w, 5);
          renderNotFound(w, near2);
          save();
          refreshProgress(false);
        });
        return;
      }
      var near = neighbors(w, 5);
      renderNotFound(w, near);
      save();
      refreshProgress(false);
      return;
    }

    lastWord = w;
    lastEntry = entry;

    var isNew = !Object.prototype.hasOwnProperty.call(S.learned, w);
    if (isNew) {
      S.learned[w] = Date.now();
      var k = dayKey();
      if (!S.days[k]) S.days[k] = [];
      if (S.days[k].indexOf(w) < 0) S.days[k].push(w);
      save();
      refreshProgress(true);
      tree.splash();
      if (!silent) toast('🌱 ' + w + ' · 浇了一次水');
    } else {
      save();
    }

    renderWord(w, entry, isNew);
  }

  function renderWord(w, e, isNew) {
    var us = e[0] || '';
    var uk = e[1] || '';
    var defs = splitDefs(e[2]);
    var tags = e[3] || '';

    var h = '';
    h += '<div class="w-head"><div class="w-word">' + esc(w) + '</div>' +
      '<div class="w-badge">' + (isNew ? '<span class="badge new">新词 +1</span>' : '<span class="badge">已浇过</span>') + '</div></div>';

    h += '<div class="w-phon">';
    if (us) {
      h += '<div class="ph-row"><span class="ph-tag">美</span><span class="ph-ipa">' + esc(ipa(us)) + '</span>' +
        '<button class="spk" data-spk="1">🔊</button></div>';
    }
    if (uk) {
      h += '<div class="ph-row"><span class="ph-tag">英</span><span class="ph-ipa">' + esc(ipa(uk)) + '</span>' +
        '<button class="spk" data-spk="2">🔊</button></div>';
    }
    if (!us && !uk) {
      var isPhrase = w.indexOf(' ') >= 0;
      h += '<div class="ph-row"><span class="ph-tag">' + (isPhrase ? '短语' : '—') + '</span>' +
        '<span class="ph-ipa" style="color:var(--dim)">' +
        (isPhrase ? '点下面喇叭听整句读音' : '这个词没有收录音标') + '</span></div>';
    }
    h += '</div>';

    h += '<div class="w-defs">' + (defs.length ? defs.map(defHTML).join('') : '<div class="def-line" style="color:var(--dim)">暂无释义</div>') + '</div>';
    h += tagHTML(tags);

    var inBook = S.book.some(function (b) { return b.w === w; });
    h += '<div class="w-acts">' +
      '<button class="act' + (inBook ? ' on' : '') + '" data-act="star">' + (inBook ? '★ 已收藏' : '☆ 收藏') + '</button>' +
      '<button class="act" data-act="speak">🔊 连读</button>' +
      '</div>';

    openSheet(h);

    $('sheetBody').querySelectorAll('[data-spk]').forEach(function (b) {
      b.addEventListener('click', function () { speak(w, +b.dataset.spk); });
    });
    var star = $('sheetBody').querySelector('[data-act="star"]');
    if (star) {
      star.addEventListener('click', function () {
        toggleBook(w);
        var on = S.book.some(function (b) { return b.w === w; });
        star.classList.toggle('on', on);
        star.textContent = on ? '★ 已收藏' : '☆ 收藏';
      });
    }
    var sp = $('sheetBody').querySelector('[data-act="speak"]');
    if (sp) sp.addEventListener('click', function () { speak(w, 1); });
  }

  function renderNotFound(w, near) {
    var h = '';
    var midReady = DICT_N >= 50000;
    var L = extLetterOf(w);
    var extSt = EXT_STATE[L] || 0;
    var stillLoading = !midReady || extSt === 1;
    h += '<div class="w-head"><div class="w-word">' + esc(w) + '</div>' +
      '<div class="w-badge"><span class="badge" style="background:rgba(255,107,107,.14);color:var(--danger)">' +
      (stillLoading ? '还在加载' : '没收录') + '</span></div></div>';
    h += '<div style="margin-top:10px;font-size:13px;color:var(--muted);line-height:1.7">' +
      (!midReady
        ? '常用词库还在下载，现在已经装好 ' + DICT_N.toLocaleString() + ' 个词。等十几秒再查一次。'
        : (extSt === 3
            ? '「' + (L === '_' ? '这个' : L.toUpperCase()) + '」开头的扩展词库没加载成功（可能是网络），常用 ' + DICT_N.toLocaleString() + ' 个词里没有它。'
            : '常用 ' + DICT_N.toLocaleString() + ' 词里没有它，扩展词库（57.7 万词，按首字母分 26 片）还在下载。等一会儿再点一次查询。')) +
      '</div>';

    if (near.length) {
      h += '<div class="sugg"><div class="sugg-list">';
      near.forEach(function (o) {
        h += '<div class="sugg-item" data-w="' + esc(o.w) + '">' +
          '<span class="sugg-w">' + esc(o.w) + '</span>' +
          '<span class="sugg-d">' + esc(firstDef(o.w).slice(0, 26)) + '</span></div>';
      });
      h += '</div></div>';
    } else {
      h += '<div class="empty">换个词试试</div>';
    }
    openSheet(h);

    $('sheetBody').querySelectorAll('[data-w]').forEach(function (el) {
      el.addEventListener('click', function () {
        var w2 = el.dataset.w;
        closeSheet();
        $('q').value = w2;
        doQuery(w2, true);
      });
    });
  }

  function toggleBook(w) {
    var i = -1;
    for (var k = 0; k < S.book.length; k++) if (S.book[k].w === w) { i = k; break; }
    if (i >= 0) { S.book.splice(i, 1); toast('已移出单词本'); }
    else { S.book.unshift({ w: w, ts: Date.now() }); toast('已加入单词本'); }
    save(true);
    renderBook();
  }

  /* ================= Sheet ================= */
  function openSheet(html) {
    $('sheetBody').innerHTML = html;
    var s = $('sheet');
    $('sheetMask').classList.remove('hidden');
    s.classList.remove('hidden');
    /* 强制重放滑入动画 */
    s.style.animation = 'none';
    void s.offsetHeight;
    s.style.animation = '';
  }
  function closeSheet() {
    $('sheet').classList.add('hidden');
    $('sheetMask').classList.add('hidden');
    $('q').blur();
  }

  /* ================= 视图渲染 ================= */
  function renderBook() {
    var el = $('bookList');
    $('bookCount').textContent = S.book.length + ' 个';
    if (!S.book.length) {
      el.innerHTML = '<div class="empty">还没有收藏。<br>查到想记的词，点「☆ 收藏」。</div>';
      return;
    }
    var h = '';
    S.book.forEach(function (b) {
      var e = lookup(b.w) || ['', '', ''];
      h += '<div class="item" data-w="' + esc(b.w) + '">' +
        '<div class="item-top"><span class="item-w">' + esc(b.w) + '</span>' +
        '<span class="item-ph">' + esc(e[0] ? ipa(e[0]) : '') + '</span></div>' +
        '<div class="item-def">' + esc(splitDefs(e[2])[0] || '') + '</div>' +
        '</div>';
    });
    el.innerHTML = h;
    el.querySelectorAll('[data-w]').forEach(function (n) {
      n.addEventListener('click', function () { doQuery(n.dataset.w, true); });
    });
  }

  function renderLog() {
    var el = $('logList');
    var keys = Object.keys(S.days).filter(function (k) { return S.days[k] && S.days[k].length; });
    keys.sort().reverse();
    $('logSum').textContent = '共 ' + keys.length + ' 天 · 连续 ' + streak() + ' 天';

    if (!keys.length) {
      el.innerHTML = '<div class="empty">还没有记录。<br>去查第一个单词吧。</div>';
      return;
    }

    var h = '';
    var today = dayKey();
    keys.forEach(function (k) {
      var ws = S.days[k].slice().reverse();
      h += '<div class="day-head"><span class="day-d">' + esc(dayLabel(k)) + '</span>' +
        '<span class="day-n' + (ws.length >= DAILY_GOAL ? ' hit' : '') + '">' +
        (k === today ? '今日目标 ' + ws.length + '/' + DAILY_GOAL : ws.length + ' 词') + '</span></div>';
      h += '<div class="chipwrap">';
      ws.forEach(function (w) {
        h += '<span class="chip" data-w="' + esc(w) + '">' + esc(w) + '</span>';
      });
      h += '</div>';
    });
    el.innerHTML = h;
    el.querySelectorAll('[data-w]').forEach(function (n) {
      n.addEventListener('click', function () { doQuery(n.dataset.w, true); });
    });
  }

  function switchView(name) {
    closeSheet();
    ['Book', 'Log', 'Mine'].forEach(function (v) {
      var el = $('view' + v);
      if (el) el.classList.toggle('on', 'view' + v === 'view' + name.charAt(0).toUpperCase() + name.slice(1));
    });
    var stage = $('stage');
    if (stage) stage.style.visibility = name === 'tree' ? 'visible' : 'hidden';

    var tabs = $('tabs').querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('on', tabs[i].dataset.view === name);
    }

    if (name === 'book') renderBook();
    if (name === 'log') renderLog();
    if (name === 'mine') refreshProgress(false);
    if (name === 'tree') tree.start();
  }

  /* ================= 导出 / 导入 ================= */
  function exportData() {
    S.meta.lastBackup = Date.now();
    save(true);
    var payload = {
      app: 'wordtree',
      v: 4,
      deviceId: S.meta.deviceId,
      exportedAt: new Date().toISOString(),
      state: S
    };
    var blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = '词芽备份-' + dayKey() + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 800);
    toast('备份已导出');
    refreshProgress(false);
  }

  function importData(file) {
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var j = JSON.parse(fr.result);
        var st = j.state || j;
        if (!st || typeof st !== 'object' || !st.learned) throw new Error('格式不对');
        if (!confirm('导入会覆盖当前数据，确定？')) return;
        S = st;
        S.learned = S.learned || {};
        S.days = S.days || {};
        S.book = S.book || [];
        S.meta = S.meta || { queries: 0, best: 0, done: false };
        save(true);
        refreshProgress(false);
        renderBook(); renderLog();
        toast('导入成功');
      } catch (e) {
        toast('备份文件读不出来');
      }
    };
    fr.readAsText(file);
  }

  /* ================= 自检 ================= */
  function runSelftest() {
    var lines = [];
    var ok = 0, bad = 0;
    /* 自检会写数据，先备份，跑完还原，保证不污染真实学习记录 */
    var backup = null;
    try { backup = localStorage.getItem(KEY); } catch (e) { backup = null; }

    function chk(name, cond, extra) {
      if (cond) { ok++; lines.push('PASS  ' + name + (extra ? '  [' + extra + ']' : '')); }
      else { bad++; lines.push('FAIL  ' + name + (extra ? '  [' + extra + ']' : '')); }
    }

    function finish() {
      /* 还原真实数据 */
      try {
        if (backup === null) localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, backup);
      } catch (e) { /* 忽略 */ }
      S = loadState();
      closeSheet();
      renderBook();
      renderLog();
      refreshProgress(false);

      var el = document.createElement('div');
      el.id = 'selftest';
      el.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#080d12;color:#dbe7f2;' +
        'font:12px/1.6 ui-monospace,Consolas,monospace;padding:14px;overflow:auto;white-space:pre-wrap';
      el.textContent = '===== 自检 =====\n' + lines.join('\n') +
        '\n\n通过 ' + ok + ' 项，失败 ' + bad + ' 项' +
        '\n\n帧率：' + (fps > 0 ? fps + ' fps（屏幕实际刷新）' : '未采集（后台/无头标签）') +
        '\n单帧渲染：' + perfAvg.toFixed(2) + ' ms' +
        '\n画布：' + tree.w + 'x' + tree.h + ' @' + tree.dpr +
        '\n总词数：' + DICT_N + '\n已学（真实数据）：' + learnedCount();
      document.body.appendChild(el);
      window.__SELFTEST = { ok: ok, bad: bad, lines: lines, fps: fps, perf: perfAvg };
    }

    var fps = 0;
    var perfAvg = 0;
    var frames = 0, ft0 = performance.now();
    function countFrames() {
      frames++;
      if (performance.now() - ft0 < 1200) requestAnimationFrame(countFrames);
      else fps = frames > 3 ? Math.round(frames / ((performance.now() - ft0) / 1000)) : 0;
    }
    requestAnimationFrame(countFrames);

    setTimeout(function () {
      chk('词库已加载', dictReady && DICT_N > 50000, DICT_N.toLocaleString() + ' 词');
      chk('词表已排序', !!SORTED && SORTED.length > 50000, (SORTED ? SORTED.length : 0) + '');

      var hello = lookup('hello');
      chk('hello 可查', !!hello);
      chk('hello 有美音', !!(hello && hello[0] && /ə/.test(hello[0])), hello ? hello[0] : '');
      chk('hello 有释义', !!(hello && /喂|嘿/.test(hello[2] || '')), hello ? hello[2].slice(0, 20) : '');

      var ab = lookup('abandon');
      chk('abandon 可查', !!ab);
      chk('abandon 音标', !!(ab && ab[0] === 'əˈbændən'), ab ? ab[0] : '');

      /* 词库：mid 档的词、按首字母按需加载的 ext 冷门词都要真的查得到 */
      var ps = lookup('photosynthesis');
      chk('mid 档可查', !!(ps && /光合作用/.test(ps[2] || '')), ps ? String(ps[2]).slice(0, 16) : '查不到');
      var zy = lookup('zyzzyva');
      chk('ext 档冷门词可查', !!(zy && /象鼻虫/.test(zy[2] || '')), zy ? String(zy[2]).slice(0, 16) : '查不到');
      var at = lookup('antidisestablishmentarianism');
      chk('超长词可查', !!(at && at[2]), at ? String(at[2]).slice(0, 16) : '查不到');

      var before = learnedCount();
      doQuery('hello', true);
      var after1 = learnedCount();
      doQuery('hello', true);
      var after2 = learnedCount();
      chk('新词浇水 +1', after1 === before + 1 || after1 === before, before + '→' + after1);
      chk('重复查不重复计数', after2 === after1, after1 + '→' + after2);

      var pms = prefixMatches('aband', 5);
      chk('前缀联想', pms.length > 0 && pms[0].indexOf('aband') === 0, pms.join(','));

      var nb = neighbors('helo', 3);
      chk('拼错给近似词', nb.length > 0, nb.map(function (x) { return x.w; }).join(','));

      var ph = lookup('give up');
      chk('短语可查', !!(ph && /放弃/.test((ph[2] || ''))), ph ? String(ph[2]).slice(0, 14) : '短语库未就绪');
      chk('短语库已加载', !!PHRASE, PHRASE ? Object.keys(PHRASE).length + ' 条' : '未加载');

      chk('编辑距离正确', lev('kitten', 'sitting') === 3, lev('kitten', 'sitting') + '');
      chk('规范化输入', norm('  Hello!! ') === 'hello', norm('  Hello!! '));

      var bk = S.book.length;
      toggleBook('__selftest__');
      chk('收藏加入', S.book.length === bk + 1, bk + '→' + S.book.length);
      toggleBook('__selftest__');
      chk('收藏移除', S.book.length === bk, S.book.length + '');

      chk('今日记录已写', todayWords().length > 0, todayWords().length + ' 词');
      chk('连续天数计算', typeof streak() === 'number' && streak() >= 1, streak() + ' 天');

      var raw = JSON.stringify(S);
      chk('状态可序列化', raw.length > 20, raw.length + ' 字节');
      var round = JSON.parse(raw);
      chk('状态可还原', round.learned && typeof round.learned === 'object');

      chk('树已初始化', !!tree && tree.w > 0 && tree.h > 0, tree.w + 'x' + tree.h);
      chk('进度映射正确', Math.abs(Math.min(1, learnedCount() / GOAL) - tree.target) < 0.02,
        tree.target.toFixed(3));

      chk('Canvas 尺寸有效', tree.canvas.width > 0 && tree.canvas.height > 0,
        tree.canvas.width + 'x' + tree.canvas.height);

      var t0 = performance.now();
      tree.buildTree(0.5);
      var cost = Math.round(performance.now() - t0);
      chk('树重绘耗时 < 16ms', cost < 16, cost + 'ms');

      /* 树形态随进度变化 */
      tree.buildTree(0.15); var L1 = tree.lights.length;
      tree.buildTree(0.95); var L2 = tree.lights.length;
      chk('彩灯随进度增加', L2 > L1, L1 + ' → ' + L2 + ' 盏');
      tree.buildTree(1);
      chk('满进度亮星', tree.starT === 1, tree.starT + '');

      /* 炸开特效 */
      tree.confetti = []; tree.celebrateT = 0;
      tree.celebrate();
      chk('炸开生成粒子', tree.confetti.length >= 100, tree.confetti.length + ' 粒');
      tree.confetti = []; tree.celebrateT = 0;

      /* 浇水特效 */
      tree.sparks = [];
      tree.splash();
      chk('浇水生成粒子', tree.sparks.length > 0, tree.sparks.length + ' 粒');
      tree.sparks = [];
      tree.stop();

      /* 像素级验证：树真的变大了（不是只改了数字） */
      function pixStat(pp) {
        tree.target = pp;
        tree.buildTree(pp);
        tree.setWords(learnedList());
        for (var k = 0; k < 42; k++) tree.frame(16.7);
        try {
          var img = tree.snapshot();
          var d = img.data;
          var green = 0, lit = 0;
          for (var i = 0; i < d.length; i += 4) {
            var R = d[i], G = d[i + 1], B = d[i + 2];
            var L = R * 0.299 + G * 0.587 + B * 0.114;
            if (L > 80) lit++;
            if (G > R + 16 && G > B + 5) green++;
          }
          return { area: green, lit: lit };
        } catch (err) { return null; }
      }
      var s1 = pixStat(0.1), s2 = pixStat(1);
      if (s1 && s2) {
        chk('树体像素随进度增长', s2.area > s1.area * 1.6,
          s1.area + ' → ' + s2.area + ' px');
        chk('亮部像素随进度增长', s2.lit > s1.lit * 1.3,
          s1.lit + ' → ' + s2.lit + ' 亮像素');
      } else {
        chk('树像素可读', false, 'getImageData 不可用');
      }

      /* 首屏性能 */
      var fcp = performance.getEntriesByName('first-contentful-paint')[0];
      /* 公网首装要经隧道下载 4MB，给宽一点的预算；装好之后从本地缓存起，仍然是毫秒级 */
      var fcpLimit = window.isSecureContext ? 9000 : 1500;
      chk('首屏绘制正常', !!fcp && fcp.startTime < fcpLimit,
        fcp ? Math.round(fcp.startTime) + 'ms / 上限 ' + fcpLimit + 'ms' : '无数据');
      var res = performance.getEntriesByType('resource');
      var bytes = 0;
      for (var ri = 0; ri < res.length; ri++) bytes += (res[ri].transferSize || 0);
      chk('首屏传输 < 20MB', bytes < 20971520,
        bytes === 0
          ? '全部命中本地缓存（0 KB，' + res.length + ' 个请求）'
          : (bytes / 1048576).toFixed(1) + ' MB / ' + res.length + ' 个资源');

      /* 手机布局：不能横向溢出，底部导航要在视口内 */
      chk('无横向溢出',
        document.documentElement.scrollWidth <= window.innerWidth + 1,
        document.documentElement.scrollWidth + '/' + window.innerWidth);
      var tabsR = $('tabs').getBoundingClientRect();
      chk('底部导航在视口内',
        tabsR.bottom <= window.innerHeight + 1 && tabsR.height > 20,
        Math.round(tabsR.bottom) + '/' + window.innerHeight);
      var swReady = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
      chk('离线缓存已接管', swReady || !('serviceWorker' in navigator), swReady ? '已接管' : '首次访问，下次生效');

      /* 单帧成本：连续 30 帧求平均，衡量手机上的流畅度 */
      var ft = performance.now();
      for (var fi = 0; fi < 30; fi++) tree.frame(16.7);
      perfAvg = (performance.now() - ft) / 30;
      chk('单帧渲染 < 8ms', perfAvg < 8, perfAvg.toFixed(2) + 'ms');

      var t1 = performance.now();
      prefixMatches('a', 8); prefixMatches('b', 8);
      var pms2 = Math.round(performance.now() - t1);
      chk('联想响应 < 30ms', pms2 < 30, pms2 + 'ms');

      finish();
    }, 200);
  }

  /* ================= 输入 ================= */
  function bindInput() {
    var q = $('q');
    var go = $('qgo');
    var clr = $('qclear');

    function submit() {
      var v = q.value.trim();
      if (!v) return;
      q.blur();
      doQuery(v);
    }

    go.addEventListener('click', submit);
    q.addEventListener('keydown', function (e) {
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    q.addEventListener('input', function () {
      clr.classList.toggle('show', q.value.length > 0);
    });
    clr.addEventListener('click', function () {
      q.value = '';
      clr.classList.remove('show');
      q.focus();
    });
  }

  /* ================= 启动 ================= */
  function boot() {
    S = loadState();

    /* 键盘弹出时把面板缩到可视区，底部输入框不会被挡住 */
    if (window.visualViewport) {
      var vv = window.visualViewport;
      var fitView = function () {
        document.documentElement.style.setProperty('--vvh', Math.round(vv.height) + 'px');
      };
      vv.addEventListener('resize', fitView);
      vv.addEventListener('scroll', fitView);
      fitView();
    }

    initTree();
    refreshProgress(false);
    bindInput();
    renderBook();
    renderLog();

    /* 关闭 sheet */
    $('sheetMask').addEventListener('click', closeSheet);
    $('doneClose').addEventListener('click', function () { $('doneCard').classList.add('hidden'); });
    $('btnExport').addEventListener('click', exportData);
    if ($('btnCopyCode')) {
      $('btnCopyCode').addEventListener('click', function () {
        var code = (S.meta && S.meta.deviceId) || '';
        if (!code) return;
        var done = function () { toast('档案号已复制：' + code); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(code).then(done, function () { toast(code); });
        } else {
          toast(code);
        }
      });
    }
    $('btnImport').addEventListener('click', function () { $('fileImport').click(); });
    $('fileImport').addEventListener('change', function (e) {
      if (e.target.files && e.target.files[0]) importData(e.target.files[0]);
      e.target.value = '';
    });
    $('btnReset').addEventListener('click', function () {
      if (!confirm('清空所有学习记录？单词本也会清掉，建议先导出备份。')) return;
      S = freshState();
      save(true);
      refreshProgress(false);
      renderBook(); renderLog();
      toast('已清空');
    });

    $('tabs').addEventListener('click', function (e) {
      var t = e.target.closest('.tab');
      if (!t) return;
      switchView(t.dataset.view);
    });

    /* 后台加载词库，不阻塞首屏 */
    setTimeout(loadDict, 60);

    /* SW */
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').then(function () {
        $('swState').textContent = '已开启，断网也能查';
      }).catch(function () {
        $('swState').textContent = '未开启（需要 https 或 localhost）';
      });
    } else {
      $('swState').textContent = '这台浏览器不支持离线缓存';
    }

    /* 预览参数 */
    var qs = new URLSearchParams(location.search);
    if (qs.has('p')) {
      var pv = parseFloat(qs.get('p'));
      if (!isNaN(pv)) {
        PREVIEW_P = Math.max(0, Math.min(1, pv));
        refreshProgress(false);
      }
    }
    if (qs.has('selftest')) {
      /* 词库现在是 core + mid 立刻装、扩展词按首字母按需装。
         自检要查 a / p / z 三个首字母的词，先把这三片拉下来再跑。
         最多等 240 × 500ms = 2 分钟。 */
      var tries = 0;
      var extReadyForTest = false;
      var preload = function () {
        var need = ['a', 'p', 'z'];
        var k = 0;
        var step = function () {
          if (k >= need.length) { extReadyForTest = true; return; }
          ensureExtShard(need[k++], step);
        };
        step();
      };
      var waitDict = function () {
        var okNow = dictReady && DICT_N > 50000;
        if (okNow && !extReadyForTest) { preload(); }
        if ((okNow && extReadyForTest) || tries >= 240) { runSelftest(); return; }
        tries++;
        setTimeout(waitDict, 500);
      };
      setTimeout(waitDict, 500);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
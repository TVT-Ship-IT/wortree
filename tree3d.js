/* ============================================================
   词芽 · 3D 圣诞树引擎（纯 Canvas 2D 手写透视投影，无第三方库）
   ------------------------------------------------------------
   - 树上每个挂饰 = 一个查过的单词，按查询顺序从底往上盘旋生长
   - 单指拖拽 = 环绕旋转　双指 = 缩放　点击挂饰 = 镜头推近
   - 2500 个挂饰也能跑，靠视锥裁剪 + 屏幕空间 LOD
   ============================================================ */
(function (g) {
  'use strict';

  var TAU = Math.PI * 2;
  var GOLD = 2.399963229728653;      /* 黄金角，让挂饰均匀铺满锥面 */

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function ease(t) { return 1 - Math.pow(1 - t, 3); }
  function ease2(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function rand(seed) {              /* mulberry32，保证每次重绘一致 */
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var LAMP_COLORS = ['#ffd76e', '#ff7b8a', '#7ee0ff', '#9dff9d', '#ffe6a8', '#d5a3ff'];

  function rgba(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /* 预烘焙光点贴图：每帧 2500 次 createRadialGradient 会直接拖垮手机，
     换成一次 drawImage 就快一个数量级。 */
  /* 半径分级：把球按屏幕半径量化到这些档，绘制时用三参数 drawImage
     直接 blit 原图，不再让浏览器每帧做双线性缩放（满树 900 次缩放
     在软件光栅化下就是 20ms 起步）。 */
  var SPR_TIERS = [3, 4, 6, 8, 11, 15, 20, 26];
  function makeDot(hex, R) {
    var S = R * 2;
    var c = document.createElement('canvas');
    c.width = c.height = S;
    var x = c.getContext('2d');
    var h = S / 2;
    var g = x.createRadialGradient(h, h, 0, h, h, h);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.14, '#ffffff');
    g.addColorStop(0.26, hex);
    g.addColorStop(0.52, rgba(hex, 0.55));
    g.addColorStop(1, rgba(hex, 0));
    x.fillStyle = g;
    x.fillRect(0, 0, S, S);
    return c;
  }
  function makeSpriteSet(hex) {
    var arr = [];
    for (var t = 0; t < SPR_TIERS.length; t++) arr.push(makeDot(hex, SPR_TIERS[t]));
    return arr;
  }
  function pickTier(r) {
    for (var i = 0; i < SPR_TIERS.length; i++) if (SPR_TIERS[i] >= r) return i;
    return SPR_TIERS.length - 1;
  }
  function makeSprites() {
    var out = [];
    for (var i = 0; i < LAMP_COLORS.length; i++) out.push(makeSpriteSet(LAMP_COLORS[i]));
    return out;
  }

  function Tree3D(canvas, opts) {
    opts = opts || {};
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onPick = opts.onPick || function () { };
    this.onEmpty = opts.onEmpty || function () { };

    /* ---- 世界尺寸 ---- */
    this.H = 10.4;                  /* 满树高度（世界单位） */
    this.R = 3.05;                  /* 满树底半径 */
    this.goal = 2500;

    /* ---- 状态 ---- */
    this.p = 0;                     /* 当前显示的进度 */
    this.target = 0;                /* 目标进度 */
    this.shown = 0;
    this.t = 0;
    this.starT = 0;
    this.celebrateT = 0;
    this.lights = [];
    this.words = [];                /* 挂饰 */
    this.byWord = {};
    this.pending = [];              /* 正在弹出的挂饰 */
    this.confetti = [];
    this.sparks = [];
    this.snow = [];
    this.stars = [];
    this.focusW = null;

    /* ---- 相机 ---- */
    this.cam = { yaw: 0.62, pitch: -0.16, dist: 15.6 };
    this.goalCam = { yaw: 0.62, pitch: -0.16, dist: 15.6 };
    this.pivot = { x: 0, y: 0, z: 0 };
    this.goalPivot = { x: 0, y: 0, z: 0 };

    /* ---- 交互 ---- */
    this.drag = null;
    this.pinch = null;
    this.pointers = {};
    this.tap = null;

    this.w = 1; this.h = 1; this.dpr = 1; this.scx = 0; this.scy = 0; this.focal = 1;
    this.running = false;
    this.last = 0;
    this.spin = 0.0005;             /* 静止时的自动微旋 */

    this.sprites = makeSprites();
    this._list = [];
    this._bg = null;
    this._warm = null; this._warmCv = null;
    this._cy = 1; this._sy = 0; this._cp = 1; this._sp = 0;

    this.resize();
    this.seed();
    this.bindInput();
    this.updateCam();
  }

  var P = Tree3D.prototype;

  /* ================= 布局 ================= */
  P.resize = function () {
    var r = this.canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(r.width || this.canvas.clientWidth || 360));
    var h = Math.max(1, Math.round(r.height || this.canvas.clientHeight || 420));
    var dpr = Math.min(2, g.devicePixelRatio || 1);
    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.scx = w / 2;
    this.scy = h * 0.50;
    this.focal = h * 1.02;
    this._bg = null;
    this._warm = null; this._warmCv = null;
    this.seed();
  };

  P.seed = function () {
    var i, r = rand(20241225);
    this.snow = [];
    for (i = 0; i < 70; i++) {
      this.snow.push({
        x: r() * this.w, y: r() * this.h,
        r: 0.6 + r() * 1.7, v: 6 + r() * 22,
        d: r() * TAU, o: 0.15 + r() * 0.5
      });
    }
    this.stars = [];
    for (i = 0; i < 56; i++) {
      this.stars.push({
        x: r() * this.w, y: r() * this.h * 0.72,
        r: 0.4 + r() * 1.1, a: 0.15 + r() * 0.6, ph: r() * TAU
      });
    }
  };

  /* ================= 坐标 =================
     树的当前尺寸：苗也有一定高度，不然进度低时几乎看不见。
     第 i 个挂饰的相对高度 tn = i / (goal * p)，永远贴在当前锥面上。 */
  P.dims = function () {
    var p = Math.max(0.0008, this.p);
    return {
      Hv: this.H * (0.20 + 0.80 * p),
      Rv: this.R * (0.34 + 0.66 * p),
      p: p
    };
  };

  P.wordPos = function (i, out) {
    var d = this.dims();
    var t = i / this.goal;
    var tn = t / d.p;
    out.t = tn;
    out.vis = tn <= 1.0008 && t <= d.p + 0.0008;
    out.y = (tn - 0.5) * d.Hv;
    var rr = d.Rv * (1 - Math.min(1, Math.max(0, tn))) * 0.94;
    var it = this.words[i];
    if (it) {
      out.x = it.ca * rr;
      out.z = it.sa * rr;
    } else {
      var ang = i * GOLD;
      out.x = Math.cos(ang) * rr;
      out.z = Math.sin(ang) * rr;
    }
    return out;
  };

  /* 相机的三角函数每帧只算一次 */
  P.updateCam = function () {
    this._cy = Math.cos(this.cam.yaw); this._sy = Math.sin(this.cam.yaw);
    this._cp = Math.cos(this.cam.pitch); this._sp = Math.sin(this.cam.pitch);
  };

  /* ================= 投影 ================= */
  P.project = function (x, y, z, out) {
    var px = x - this.pivot.x, py = y - this.pivot.y, pz = z - this.pivot.z;
    var x1 = px * this._cy - pz * this._sy;
    var z1 = px * this._sy + pz * this._cy;
    var y2 = py * this._cp - z1 * this._sp;
    var z2 = py * this._sp + z1 * this._cp;
    var zc = z2 + this.cam.dist;
    if (zc < 0.55) return false;
    var f = this.focal / zc;
    out.x = this.scx + x1 * f;
    out.y = this.scy - y2 * f;
    out.s = f;
    out.z = zc;
    return true;
  };

  var _pp = { x: 0, y: 0, s: 1, z: 0 };

  /* ================= 挂饰 ================= */
  P.setWords = function (list) {
    var old = this.byWord, next = {}, out = [], i, it, w;
    for (i = 0; i < list.length && i < this.goal; i++) {
      w = list[i].w;
      it = old[w];
      if (it) {
        it.i = i;
        if (list[i].ts) it.ts = list[i].ts;
        next[w] = it;
        out.push(it);
      } else {
        var ang = i * GOLD;
        it = {
          w: w, i: i, ts: list[i].ts || 0,
          ca: Math.cos(ang), sa: Math.sin(ang),
          sx: 0, sy: 0, ss: 1, vis: false, app: 0.001,
          hue: LAMP_COLORS[i % LAMP_COLORS.length],
          spr: this.sprites[i % LAMP_COLORS.length],
          ph: (i * 0.618) % TAU
        };
        next[w] = it;
        out.push(it);
      }
    }
    this.words = out;
    this.byWord = next;
  };

  /* 新增的词做弹出动画 */
  P.syncAppear = function () {
    for (var i = 0; i < this.words.length; i++) {
      var it = this.words[i];
      if (it.app >= 1) continue;
      if (it.i > this.shown * this.goal - 0.5) it.app = 0.001;
    }
  };

  P.addWord = function (word, ts) {
    if (this.byWord[word]) return null;
    var n = this.words.length;
    var ang = n * GOLD;
    var it = {
      w: word, i: n, ts: ts || Date.now(),
      ca: Math.cos(ang), sa: Math.sin(ang),
      sx: 0, sy: 0, ss: 1, vis: false, app: 0.001,
      hue: LAMP_COLORS[n % LAMP_COLORS.length],
      spr: this.sprites[n % LAMP_COLORS.length],
      ph: (n * 0.618) % TAU
    };
    this.words.push(it);
    this.byWord[word] = it;
    return it;
  };

  /* ================= 进度 ================= */
  P.buildTree = function (p) {
    p = clamp(p, 0, 1);
    this.p = p;
    this.shown = p;

    /* 彩灯：满进度 62 盏，最后 10% 加密 */
    var d = this.dims();
    var n = Math.floor(p * 34) + (p > 0.9 ? Math.round((p - 0.9) / 0.1 * 30) : 0);
    var r = rand(7331);
    this.lights.length = 0;
    for (var i = 0; i < n; i++) {
      var tn = r();
      var rr = d.Rv * (1 - tn) * (0.86 + r() * 0.16);
      var ang = r() * TAU;
      this.lights.push({
        x: Math.cos(ang) * rr, y: (tn - 0.5) * d.Hv, z: Math.sin(ang) * rr,
        c: LAMP_COLORS[i % LAMP_COLORS.length],
        spr: this.sprites[i % LAMP_COLORS.length],
        ph: r() * TAU, sz: 1 + r() * 1.4
      });
    }
    this.starT = p > 0.52 ? clamp((p - 0.52) / 0.48, 0, 1) : 0;
  };

  P.jumpTo = function (p) {
    this.target = clamp(p, 0, 1);
    this.buildTree(this.target);
  };

  P.setProgress = function (p) {
    this.target = clamp(p, 0, 1);
    var self = this;
    if (!this.running) {
      this.buildTree(this.target);
      if (this.words.length) this.splash();
      return;
    }
    if (this.target > this.p + 0.0004) this.splash();
  };

  /* ================= 特效 ================= */
  P.splash = function () {
    var r = this.words.length ? this.words[this.words.length - 1] : null;
    var bx = 0, by = -this.H / 2, bz = 0;
    if (r) { var o = {}; this.wordPos(r.i, o); bx = o.x; by = o.y; bz = o.z; }
    for (var i = 0; i < 16; i++) {
      var a = Math.random() * TAU, sp = 0.5 + Math.random() * 1.6;
      this.sparks.push({
        x: bx, y: by, z: bz,
        vx: Math.cos(a) * sp * 0.5, vy: 1.2 + Math.random() * 2.0, vz: Math.sin(a) * sp * 0.5,
        life: 1, hue: Math.random() < 0.5 ? '#7ee0ff' : '#9dff9d'
      });
    }
    this.shake = 0.9;
  };

  P.celebrate = function () {
    this.celebrateT = 1;
    for (var i = 0; i < 150; i++) this.extraConfetti();
  };

  P.extraConfetti = function () {
    var a = Math.random() * TAU, sp = 2 + Math.random() * 6;
    this.confetti.push({
      x: 0, y: this.H * 0.5, z: 0,
      vx: Math.cos(a) * sp * 0.55, vy: 3 + Math.random() * 7, vz: Math.sin(a) * sp * 0.55,
      life: 1, sz: 0.03 + Math.random() * 0.045,
      c: LAMP_COLORS[(Math.random() * LAMP_COLORS.length) | 0],
      rot: Math.random() * TAU, vr: (Math.random() - 0.5) * 6
    });
  };

  /* ================= 聚焦 ================= */
  P.focus = function (word) {
    var it = this.byWord[word];
    if (!it) return false;
    var o = {};
    this.wordPos(it.i, o);
    if (!o.vis) return false;
    this.focusW = word;
    /* 注视点下移到词下方 0.75 单位 → 词在屏幕上被抬到画布偏上，
       避免底部弹出的词卡把刚点中的那个词盖住 */
    this.goalPivot.x = o.x; this.goalPivot.y = o.y - 0.75; this.goalPivot.z = o.z;
    /* 让该点转到正前方 */
    var want = -Math.atan2(o.x, o.z);
    var cur = this.cam.yaw;
    var d = ((want - cur + Math.PI * 3) % TAU) - Math.PI;
    this.goalCam.yaw = cur + d;
    this.goalCam.pitch = -0.06;
    this.goalCam.dist = 6.0;
    return true;
  };

  P.blur = function () {
    this.focusW = null;
    this.goalPivot.x = 0; this.goalPivot.y = 0; this.goalPivot.z = 0;
    this.goalCam.pitch = -0.16;
    this.goalCam.dist = 15.6;
  };

  /* ================= 交互 ================= */
  P.bindInput = function () {
    var self = this, cv = this.canvas;

    function pos(e) {
      var r = cv.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    /* 三个原语：按下 / 移动 / 抬起。指针事件和触摸事件都走这里，
       这样老浏览器（不产 pointer 事件）也能拖得动。 */
    function pruneStale() {
      /* 真机上 pointerup 可能丢失（手指滑出屏幕、来电、切后台），
         留下的幽灵指针会让之后的点击全变成"双指"，永远点不中词。
         超过 1.5 秒没动过的触点直接清掉。 */
      var now = Date.now();
      var ids = Object.keys(self.pointers);
      for (var i = 0; i < ids.length; i++) {
        var p = self.pointers[ids[i]];
        if (now - (p.t || 0) > 1500) {
          delete self.pointers[ids[i]];
          if (!Object.keys(self.pointers).length) { self.drag = null; self.pinch = null; }
        }
      }
    }

    function down(id, x, y) {
      pruneStale();
      self.pointers[id] = { x: x, y: y, t: Date.now() };
      var ids = Object.keys(self.pointers);
      if (ids.length > 2) {                 /* 意外的第三根手指：整体重置，别猜 */
        self.pointers = {};
        self.pointers[id] = { x: x, y: y, t: Date.now() };
        ids = Object.keys(self.pointers);
      }
      if (ids.length === 1) {
        self.drag = { x: x, y: y, t: Date.now(), moved: 0, yaw: self.goalCam.yaw, pitch: self.goalCam.pitch };
        self.pinch = null;
      } else if (ids.length === 2) {
        var a = self.pointers[ids[0]], b = self.pointers[ids[1]];
        self.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), dist: self.goalCam.dist };
        self.drag = null;
      }
    }

    function move(id, x, y) {
      if (!self.pointers[id]) return;
      self.pointers[id] = { x: x, y: y, t: Date.now() };
      var ids = Object.keys(self.pointers);

      if (ids.length >= 2 && self.pinch) {
        var a = self.pointers[ids[0]], b = self.pointers[ids[1]];
        var d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d > 8) {
          var kk = self.pinch.d / d;
          self.goalCam.dist = clamp(self.pinch.dist * kk, 3.2, 30);
          self.cam.dist = self.goalCam.dist;
        }
        return;
      }
      if (!self.drag) return;
      var dx = x - self.drag.x, dy = y - self.drag.y;
      self.drag.moved = Math.max(self.drag.moved, Math.hypot(dx, dy));
      self.goalCam.yaw = self.drag.yaw + dx * 0.0072;
      self.goalCam.pitch = clamp(self.drag.pitch + dy * 0.0045, -1.15, 0.72);
      self.cam.yaw = self.goalCam.yaw;
      self.cam.pitch = self.goalCam.pitch;
    }

    function lift(id) {
      var p = self.pointers[id];
      delete self.pointers[id];
      var ids = Object.keys(self.pointers);
      if (ids.length < 2) self.pinch = null;
      if (!p) return;
      if (ids.length === 0) {
        var d = self.drag;
        self.drag = null;
        if (d && d.moved < 10 && Date.now() - d.t < 600) self.tapAt(p.x, p.y);
      }
    }

    /* --- 指针事件（现代浏览器主路径） --- */
    var seenPointer = false;
    cv.addEventListener('pointerdown', function (e) {
      seenPointer = true;
      cv.setPointerCapture && cv.setPointerCapture(e.pointerId);
      var p = pos(e);
      down(e.pointerId, p.x, p.y);
    }, { passive: true });

    cv.addEventListener('pointermove', function (e) {
      if (!self.pointers[e.pointerId]) return;
      var p = pos(e);
      move(e.pointerId, p.x, p.y);
    }, { passive: true });

    cv.addEventListener('pointerup', function (e) { lift(e.pointerId); }, { passive: true });
    cv.addEventListener('pointercancel', function (e) { lift(e.pointerId); }, { passive: true });

    /* --- 触摸兜底：只有在本浏览器完全不产 pointer 事件时才启用 --- */
    function tpos(t) {
      var r = cv.getBoundingClientRect();
      return { x: t.clientX - r.left, y: t.clientY - r.top };
    }
    cv.addEventListener('touchstart', function (e) {
      if (seenPointer && !self.forceTouch) return;
      for (var i = 0; i < e.changedTouches.length; i++) {
        var t = e.changedTouches[i];
        var p = tpos(t);
        down('t' + t.identifier, p.x, p.y);
      }
    }, { passive: true });

    cv.addEventListener('touchmove', function (e) {
      if (seenPointer && !self.forceTouch) return;
      for (var i = 0; i < e.changedTouches.length; i++) {
        var t = e.changedTouches[i];
        var p = tpos(t);
        move('t' + t.identifier, p.x, p.y);
      }
    }, { passive: true });

    function tend(e) {
      if (seenPointer && !self.forceTouch) return;
      for (var i = 0; i < e.changedTouches.length; i++) {
        lift('t' + e.changedTouches[i].identifier);
      }
    }
    cv.addEventListener('touchend', tend, { passive: true });
    cv.addEventListener('touchcancel', tend, { passive: true });

    /* 双击复位 */
    var lastTap = 0;
    cv.addEventListener('dblclick', function () {
      var now = Date.now();
      if (now - lastTap < 400) { self.blur(); self.goalCam.yaw = 0.62; }
      lastTap = now;
    });
  };

  P.tapAt = function (x, y) {
    /* 传进来的是 CSS 像素（手指位置），而 it.sx / it.sy 是 canvas 物理像素。
       dpr=2 时必须先换算，否则永远点不中（曾经的 bug）。 */
    var cw = this.canvas.clientWidth || this.w;
    var k = cw > 0 ? this.w / cw : 1;
    x *= k; y *= k;
    var best = null, bd = 1e9;
    for (var i = this.words.length - 1; i >= 0; i--) {
      var it = this.words[i];
      if (!it.vis) continue;
      var d = Math.hypot(it.sx - x, it.sy - y);
      var lim = Math.max(16, 0.55 * it.ss);
      if (d < lim && d < bd) { bd = d; best = it; }
    }
    if (best) this.onPick(best.w);
    else this.onEmpty();
  };

  /* ================= 主循环 ================= */
  P.start = function () {
    if (this.running) return;
    this.running = true;
    this.last = 0;
    var self = this;
    function loop(ts) {
      if (!self.running) return;
      var dt = self.last ? Math.min(60, ts - self.last) : 16.7;
      self.last = ts;
      self.frame(dt);
      self.raf = g.requestAnimationFrame(loop);
    }
    this.raf = g.requestAnimationFrame(loop);
  };

  P.stop = function () {
    this.running = false;
    if (this.raf) g.cancelAnimationFrame(this.raf);
    this.raf = 0;
  };

  P.frame = function (dt) {
    var s = dt / 16.7;
    if (!isFinite(s) || s <= 0) s = 1;
    this.t += dt / 1000;

    /* 进度追赶 */
    if (Math.abs(this.p - this.target) > 0.0002) {
      this.p += (this.target - this.p) * Math.min(1, 0.14 * s);
      if (Math.abs(this.p - this.target) < 0.0002) this.p = this.target;
      this.buildTree(this.p);
    }

    /* 相机缓动 */
    var g = this.goalCam, c = this.cam;
    c.yaw += (g.yaw - c.yaw) * Math.min(1, 0.12 * s);
    c.pitch += (g.pitch - c.pitch) * Math.min(1, 0.12 * s);
    c.dist += (g.dist - c.dist) * Math.min(1, 0.12 * s);
    this.pivot.x += (this.goalPivot.x - this.pivot.x) * Math.min(1, 0.11 * s);
    this.pivot.y += (this.goalPivot.y - this.pivot.y) * Math.min(1, 0.11 * s);
    this.pivot.z += (this.goalPivot.z - this.pivot.z) * Math.min(1, 0.11 * s);

    if (!this.drag && !this.focusW) this.goalCam.yaw += this.spin * s;

    /* 挂饰弹出动画 */
    for (var i = 0; i < this.words.length; i++) {
      var it = this.words[i];
      if (it.app < 1) it.app = Math.min(1, it.app + 0.06 * s);
    }

    /* 粒子 */
    var j;
    for (j = this.sparks.length - 1; j >= 0; j--) {
      var sp = this.sparks[j];
      sp.x += sp.vx * s * 0.06; sp.y += sp.vy * s * 0.06; sp.z += sp.vz * s * 0.06;
      sp.vy -= 0.055 * s; sp.life -= 0.016 * s;
      if (sp.life <= 0) this.sparks.splice(j, 1);
    }
    for (j = this.confetti.length - 1; j >= 0; j--) {
      var cf = this.confetti[j];
      cf.x += cf.vx * s * 0.06; cf.y += cf.vy * s * 0.06; cf.z += cf.vz * s * 0.06;
      cf.vy -= 0.16 * s; cf.rot += cf.vr * s * 0.06;
      cf.life -= 0.0075 * s;
      if (cf.life <= 0 || cf.y < -this.H) this.confetti.splice(j, 1);
    }
    if (this.celebrateT > 0.12 && this.confetti.length < 260) {
      for (j = 0; j < 3; j++) this.extraConfetti();
    }
    if (this.celebrateT > 0) this.celebrateT = Math.max(0, this.celebrateT - 0.0035 * s);
    if (this.shake > 0) this.shake = Math.max(0, this.shake - 0.05 * s);

    this.draw();
  };

  /* ================= 绘制 ================= */
  P.draw = function () {
    var ctx = this.ctx, w = this.w, h = this.h, t = this.t;
    var p = this.p;

    this.updateCam();
    ctx.clearRect(0, 0, w, h);

    /* 背景由 #stage 的 CSS 渐变负责（合成器免费），canvas 透明，
       每帧只 clearRect。以前这里是全屏 createLinearGradient + fillRect，
       780×1338 下每帧白烧 8ms 以上。 */

    /* 星空：合并成一条路径 */
    ctx.fillStyle = '#cfe6ff';
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    for (var si = 0; si < this.stars.length; si++) {
      var st = this.stars[si];
      var r = st.r * (0.7 + 0.3 * Math.sin(t * 1.6 + st.ph));
      ctx.moveTo(st.x + r, st.y);
      ctx.arc(st.x, st.y, r, 0, TAU);
    }
    ctx.fill();
    ctx.globalAlpha = 1;

    var shx = this.shake ? (Math.random() - 0.5) * this.shake * 2.2 : 0;
    var shy = this.shake ? (Math.random() - 0.5) * this.shake * 2.2 : 0;
    ctx.save();
    ctx.translate(shx, shy);

    this.drawTree(ctx);
    this.drawOrnaments(ctx);
    this.drawLights(ctx);
    this.drawStar(ctx);
    this.drawParticles(ctx);

    ctx.restore();

    this.drawSnow(ctx);

    /* 满进度暖光已移到 CSS 的 #stage.warm（合成器渲染，零 canvas 开销，
       也不受 canvas globalAlpha 叠加的影响）。canvas 里不再画全屏色块。 */
  };

  /* --- 树体：分段圆台 + 针叶 --- */
  P.drawTree = function (ctx) {
    var p = this.p;
    if (p <= 0.0005) { this.drawPot(ctx); return; }

    var d = this.dims();
    var yBase = -d.Hv / 2;
    var segN = 14;
    var a = {}, b = {};

    /* 树干 */
    this.drawTrunk(ctx, d);

    ctx.save();
    for (var s = 0; s < segN; s++) {
      var t0 = s / segN, t1 = (s + 1) / segN;
      var y0 = yBase + d.Hv * t0;
      var y1 = yBase + d.Hv * t1;
      var r0 = d.Rv * (1 - t0), r1 = d.Rv * (1 - t1);

      /* 该段的明暗：越靠上越亮，受光在左前 */
      var lit = 0.30 + 0.55 * t0;
      var g0 = Math.round(28 + 62 * lit), g1 = Math.round(58 + 74 * lit);
      var fill = 'rgb(' + Math.round(g0 * 0.55) + ',' + g1 + ',' + Math.round(g0 * 0.82) + ')';

      /* 侧面：用上下两圈轮廓围成环形曲面 */
      ctx.beginPath();
      var N = 26, first = true;
      for (var k = 0; k <= N; k++) {
        var ang = k / N * TAU;
        if (!this.project(Math.cos(ang) * r0, y0, Math.sin(ang) * r0, a)) { first = true; continue; }
        if (first) { ctx.moveTo(a.x, a.y); first = false; } else ctx.lineTo(a.x, a.y);
      }
      for (var k2 = N; k2 >= 0; k2--) {
        var ang2 = k2 / N * TAU;
        if (!this.project(Math.cos(ang2) * r1, y1, Math.sin(ang2) * r1, b)) continue;
        ctx.lineTo(b.x, b.y);
      }
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();

      /* 针叶：沿母线撒短线，制造毛茸茸的边 */
      ctx.strokeStyle = 'rgba(150,255,190,0.16)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (var n = 0; n < 15; n++) {
        var an = (n / 15) * TAU + s * 0.4;
        var rr = r0 * (0.9 + 0.1 * Math.sin(n * 3.1 + s));
        if (!this.project(Math.cos(an) * rr, y0, Math.sin(an) * rr, a)) continue;
        if (!this.project(Math.cos(an) * rr * 0.55, y1 - 0.1, Math.sin(an) * rr * 0.55, b)) continue;
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
    }
    ctx.restore();

    /* 雪：树冠上的白边 */
    ctx.save();
    for (var m = 0; m < 12; m++) {
      var tt = (m + 1) / 13;
      var yy = yBase + d.Hv * tt;
      var rr2 = d.Rv * (1 - tt);
      for (var q = 0; q < 8; q++) {
        var aq = (q / 8) * TAU + m;
        if (!this.project(Math.cos(aq) * rr2, yy, Math.sin(aq) * rr2, a)) continue;
        ctx.globalAlpha = 0.28 * (1 - tt * 0.7);
        ctx.fillStyle = '#eaf6ff';
        ctx.beginPath();
        ctx.arc(a.x, a.y, Math.max(0.6, K_SNOW * a.s), 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  };

  P.drawTrunk = function (ctx, d) {
    var y0 = -d.Hv / 2, y1 = -d.Hv / 2 + Math.min(1.3, d.Hv * 0.3);
    var rw = 0.30, a = {}, b = {};
    ctx.save();
    for (var i = 0; i < 2; i++) {
      var ang = i === 0 ? 0 : Math.PI;
      if (!this.project(Math.cos(ang) * rw, y0, Math.sin(ang) * rw, a)) continue;
      if (!this.project(Math.cos(ang) * rw, y1, Math.sin(ang) * rw, b)) continue;
      ctx.strokeStyle = i === 0 ? '#5a3a22' : '#3d2617';
      ctx.lineWidth = Math.max(2, 0.15 * a.s);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  };

  P.drawPot = function (ctx) {
    var a = {};
    if (!this.project(0, -this.H * 0.085, 0, a)) return;
    var s = a.s;
    ctx.save();
    ctx.fillStyle = '#2a1d14';
    ctx.beginPath();
    ctx.ellipse(a.x, a.y + 0.13 * s, 0.54 * s, 0.19 * s, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#3a2a1c';
    ctx.beginPath();
    ctx.ellipse(a.x, a.y + 0.04 * s, 0.42 * s, 0.14 * s, 0, 0, TAU);
    ctx.fill();
    /* 土里的小芽 */
    ctx.strokeStyle = '#3ddc97';
    ctx.lineWidth = Math.max(1.4, 0.05 * s);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y + 0.04 * s);
    ctx.lineTo(a.x, a.y - 0.26 * s);
    ctx.stroke();
    ctx.fillStyle = '#3ddc97';
    ctx.beginPath();
    ctx.ellipse(a.x + 0.10 * s, a.y - 0.26 * s, 0.13 * s, 0.073 * s, -0.5, 0, TAU);
    ctx.fill();
    ctx.restore();
  };

  /* ================= 尺寸口径 =================
     世界单位：树高 10、底半径 3。投影后 1 世界单位 ≈ focal/dist 像素。
     所有「屏幕上多大」的常数都必须先乘 a.s，别直接当像素用。 */
  var K_DOT = 0.052;        /* 挂饰球半径（世界单位） */
  var K_LAMP = 0.030;       /* 彩灯半径 */
  var K_STAR = 0.18;        /* 顶星半径 */
  var K_SNOW = 0.030;       /* 树冠雪点 */
  var K_SPARK = 0.045;      /* 浇水粒子 */
  var K_CONF = 0.028;       /* 纸屑基础尺寸 */

  /* --- 挂饰（单词） --- */
  P.drawOrnaments = function (ctx) {
    var i, it, o = {}, list = this._list;
    list.length = 0;
    for (i = 0; i < this.words.length; i++) {
      it = this.words[i];
      it.lab = false;                    /* 每帧重算标签，避免不可见词的旧标记残留 */
      this.wordPos(it.i, o);
      if (!o.vis) { it.vis = false; continue; }
      if (!this.project(o.x, o.y, o.z, _pp)) { it.vis = false; continue; }
      it.sx = _pp.x; it.sy = _pp.y; it.ss = _pp.s; it.zz = _pp.z;
      it.vis = true;
      list.push(it);
    }
    if (!list.length) return;

    list.sort(function (a, b) { return b.zz - a.zz; });   /* 远的先画 */

    /* 屏幕网格去重：2500 个点挤在一起时，同一格里只留最近的那个。
       视觉上几乎无差别（本来也是重叠的），但 drawImage 次数能砍掉一大半。
       点击判定是独立遍历所有词的，不受影响。 */
    var CELL = 8;
    var gw = Math.ceil(this.w / CELL) + 1;
    var gh = Math.ceil(this.h / CELL) + 1;
    var need = gw * gh;
    if (!this._seen || this._seen.length < need) this._seen = new Uint8Array(need);
    var seen = this._seen;
    seen.fill(0, 0, need);
    if (!this._keep || this._keep.length < list.length) this._keep = new Uint8Array(list.length);
    var keep = this._keep, kept = 0;

    for (i = list.length - 1; i >= 0; i--) {      /* 从近到远标记，保证近的优先 */
      it = list[i];
      var cx = (it.sx / CELL) | 0, cy = (it.sy / CELL) | 0;
      if (cx < 0 || cy < 0 || cx >= gw || cy >= gh) { keep[i] = 1; kept++; continue; }
      var k = cy * gw + cx;
      if (seen[k]) { keep[i] = 0; continue; }
      seen[k] = 1;
      keep[i] = 1;
      kept++;
    }
    this.keptCount = kept;

    var focus = this.focusW;
    var kdot = K_DOT * 2.2 * 2.6;

    /* --- 标签分配：按屏幕尺寸降序（近的先），带矩形防重叠 ---
       先决定哪些词带文字，再统一绘制，这样"近的、大的"优先拿到标签，
       不会像原来那样被远处先遍历的词把预算吃光。 */
    if (!this._labOrder) this._labOrder = [];
    var order = this._labOrder;
    order.length = 0;
    for (i = 0; i < list.length; i++) { if (keep[i]) order.push(list[i]); }
    order.sort(function (a, b) { return b.ss - a.ss; });

    var boxes = this._labBoxes || (this._labBoxes = []);
    boxes.length = 0;
    var LABEL_MAX = 34;
    for (i = 0; i < order.length && boxes.length < LABEL_MAX * 4; i++) {
      it = order[i];
      var isFocus = it.w === focus;
      if (!isFocus && it.ss < 0.80) continue;
      var fsL = isFocus ? clamp(0.30 * it.ss, 13, 30) : clamp(0.205 * it.ss, 9, 15);
      var tw = it.w.length * fsL * 0.56 + 4;
      var tyL = it.sy - kdot * it.ss * 0.5 - fsL * 0.72;
      var bx0 = it.sx - tw * 0.5, bx1 = it.sx + tw * 0.5;
      var by0 = tyL - fsL * 0.62, by1 = tyL + fsL * 0.62;
      var hit = false;
      for (var b = 0; b < boxes.length; b += 4) {
        if (bx0 < boxes[b + 2] && bx1 > boxes[b] && by0 < boxes[b + 3] && by1 > boxes[b + 1]) {
          hit = true; break;
        }
      }
      if (hit) continue;
      boxes.push(bx0, by0, bx1, by1);
      it.lab = true;
    }

    function drawLabel(o, focused) {
      var fs = focused ? clamp(0.30 * o.ss, 13, 30) : clamp(0.205 * o.ss, 9, 15);
      var szo = Math.max(0.9, K_DOT * o.ss * (0.5 + 0.5 * o.app));
      var ty = o.sy - szo * 2.2 * 2.6 - fs * 0.62;
      ctx.font = (focused ? '700 ' : '500 ') + fs.toFixed(1) + 'px system-ui,-apple-system,"Segoe UI",sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (focused) {
        /* 只有被点中的那个词值得付描边+发光的代价 */
        ctx.lineWidth = Math.max(2, fs * 0.26);
        ctx.strokeStyle = 'rgba(5,10,8,0.88)';
        ctx.strokeText(o.w, o.sx, ty);
        ctx.shadowColor = o.hue;
        ctx.shadowBlur = 16;
        ctx.fillStyle = '#ffffff';
        ctx.fillText(o.w, o.sx, ty);
        ctx.shadowBlur = 0;
      } else {
        /* 普通标签千万不能用 shadowBlur：34 个词每帧模糊一遍能把帧率从
           55 打到 20。用一个偏移的黑字做描边，两遍纯 fillText，便宜得多。 */
        ctx.fillStyle = 'rgba(3,8,6,0.82)';
        ctx.fillText(o.w, o.sx + 1.1, ty + 1.1);
        ctx.fillStyle = 'rgba(240,246,252,0.95)';
        ctx.fillText(o.w, o.sx, ty);
      }
    }

    /* 第一遍：普通挂饰。
       小球的 drawImage 每次都有固定开销（状态机 + clip + 采样设置），
       901 次就是十几毫秒。所以分两档：
         · 远处小球（r < 6）合进一条 path，一次 fill 全画完；
         · 近处大球（r >= 6）才逐个小图绘制。
       远处球本来就只有几个像素、颜色糊成一片，合并后肉眼几乎无差别。 */
    var NEAR = 6.5, FAR_A = [0.42, 0.72, 1];
    var farP = [new Path2D(), new Path2D(), new Path2D()];
    var farN = 0;
    ctx.globalAlpha = 1;
    for (i = 0; i < list.length; i++) {
      if (!keep[i]) continue;
      it = list[i];
      if (it.w === focus) continue;
      var sz = Math.max(0.9, K_DOT * it.ss * (0.5 + 0.5 * it.app));
      var r = sz * 2.2;
      var alpha = it.app * clamp(1.35 - it.zz / 26, 0.2, 1);

      if (r < NEAR) {
        var ft = alpha < 0.55 ? 0 : (alpha < 0.82 ? 1 : 2);
        farP[ft].moveTo(it.sx + r, it.sy);
        farP[ft].arc(it.sx, it.sy, r, 0, TAU);
        farN++;
      } else {
        ctx.globalAlpha = alpha;
        var rq = Math.round(r);
        if (it.kq !== rq) { it.kq = rq; it.ti = pickTier(rq); }
        var img = it.spr[it.ti];
        ctx.drawImage(img, it.sx - img.width * 0.5, it.sy - img.height * 0.5);
      }
      if (it.lab) { ctx.globalAlpha = alpha * 0.94; drawLabel(it, false); }
    }
    if (farN) {
      ctx.fillStyle = '#c3f7d9';
      for (var fq = 0; fq < 3; fq++) {
        ctx.globalAlpha = FAR_A[fq];
        ctx.fill(farP[fq]);
      }
      ctx.globalAlpha = 1;
    }

    /* 第二遍：被点中的那个词单独画在最上层，永远不会被别的球盖住 */
    if (focus) {
      it = this.byWord[focus];
      if (it && it.vis) {
        var sz2 = Math.max(0.9, K_DOT * it.ss * (0.5 + 0.5 * it.app));
        var r2 = sz2 * 2.2;
        ctx.globalAlpha = 1;
        var rq2 = Math.round(r2);
        if (it.kq !== rq2) { it.kq = rq2; it.ti = pickTier(rq2); }
        var img2 = it.spr[it.ti];
        ctx.drawImage(img2, it.sx - img2.width * 0.5, it.sy - img2.height * 0.5);
        drawLabel(it, true);
      }
    }
    ctx.globalAlpha = 1;
  };

  /* --- 彩灯 --- */
  P.drawLights = function (ctx) {
    var t = this.t, a = {};
    var glow = 1 + 0.6 * Math.max(0, (this.p - 0.7) / 0.3);
    for (var i = 0; i < this.lights.length; i++) {
      var L = this.lights[i];
      if (!this.project(L.x, L.y, L.z, a)) continue;
      var pulse = 0.55 + 0.45 * Math.sin(t * 2.3 + L.ph);
      var r = Math.max(1.2, K_LAMP * a.s * L.sz * (1.5 + 0.8 * pulse) * glow) * 2.6;
      ctx.globalAlpha = 0.38 + 0.44 * pulse;
      var lq = Math.round(r);
      if (L.kq !== lq) { L.kq = lq; L.ti = pickTier(lq); }
      var lspr = L.spr[L.ti];
      ctx.drawImage(lspr, a.x - lspr.width * 0.5, a.y - lspr.height * 0.5);
    }
    ctx.globalAlpha = 1;
  };

  /* --- 顶星 --- */
  P.drawStar = function (ctx) {
    if (this.starT <= 0) return;
    var a = {};
    var d = this.dims();
    var topY = d.Hv / 2 + 0.34;
    if (!this.project(0, topY, 0, a)) return;
    var st = this.starT;
    var big = 1 + 0.16 * Math.sin(this.t * 2.4);
    var r = Math.max(2, K_STAR * a.s * st * big);
    ctx.save();
    ctx.globalAlpha = st;
    var gd = ctx.createRadialGradient(a.x, a.y, 0, a.x, a.y, r * 4);
    gd.addColorStop(0, 'rgba(255,236,170,0.95)');
    gd.addColorStop(0.3, 'rgba(255,206,90,0.55)');
    gd.addColorStop(1, 'rgba(255,190,60,0)');
    ctx.fillStyle = gd;
    ctx.beginPath();
    ctx.arc(a.x, a.y, r * 4, 0, TAU);
    ctx.fill();
    ctx.translate(a.x, a.y);
    ctx.rotate(this.t * 0.5);
    ctx.fillStyle = '#fff6cf';
    ctx.beginPath();
    for (var i = 0; i < 10; i++) {
      var ang = i * Math.PI / 5 - Math.PI / 2;
      var rr = i % 2 === 0 ? r : r * 0.44;
      if (i === 0) ctx.moveTo(Math.cos(ang) * rr, Math.sin(ang) * rr);
      else ctx.lineTo(Math.cos(ang) * rr, Math.sin(ang) * rr);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };

  /* --- 粒子 --- */
  P.drawParticles = function (ctx) {
    var i, a = {}, s;
    ctx.save();
    for (i = 0; i < this.sparks.length; i++) {
      s = this.sparks[i];
      if (!this.project(s.x, s.y, s.z, a)) continue;
      ctx.globalAlpha = Math.max(0, s.life) * 0.9;
      ctx.fillStyle = s.hue;
      ctx.beginPath();
      ctx.arc(a.x, a.y, Math.max(0.6, K_SPARK * a.s), 0, TAU);
      ctx.fill();
    }
    for (i = 0; i < this.confetti.length; i++) {
      s = this.confetti[i];
      if (!this.project(s.x, s.y, s.z, a)) continue;
      ctx.globalAlpha = Math.max(0, Math.min(1, s.life * 1.4));
      ctx.fillStyle = s.c;
      ctx.save();
      ctx.translate(a.x, a.y);
      ctx.rotate(s.rot);
      var cw = Math.max(1.2, s.sz * a.s);
      ctx.fillRect(-cw, -cw * 0.45, cw * 2, cw * 0.9);
      ctx.restore();
    }
    ctx.restore();
  };

  P.drawSnow = function (ctx) {
    var dt = 1, i, s;
    ctx.save();
    for (i = 0; i < this.snow.length; i++) {
      s = this.snow[i];
      ctx.globalAlpha = s.o;
      ctx.fillStyle = '#dbe9f7';
      ctx.beginPath();
      ctx.arc(s.x + Math.sin(this.t * 0.6 + s.d) * 8, s.y, s.r, 0, TAU);
      ctx.fill();
      s.y += s.v * 0.016;
      if (s.y > this.h + 4) { s.y = -4; s.x = Math.random() * this.w; }
    }
    ctx.restore();
  };

  /* 自检用：拿主画布的像素 */
  P.snapshot = function () {
    return this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
  };

  g.Tree3D = Tree3D;
})(window);
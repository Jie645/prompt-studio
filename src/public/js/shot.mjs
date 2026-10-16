/**
 * shot.mjs —— 「投篮」交互（零依赖 / 无构建 / 原生 ESM）
 *
 * 职责边界：本模块只负责动效与篮筐状态机，不认识任何业务状态
 * （对话、四阶段流水线、接口 CRUD、变量、历史会话都不在这里）。
 * app.js 决定「什么时候投、投什么形态、入网之后做什么」。
 *
 * 时间线（默认）：起手 80ms → 飞行 480ms → 入网收尾 60ms，合计约 620ms。
 * 与网络请求并行：调用方在 t=0 同时发请求，入网后 await 本模块返回的 Promise 再上屏。
 *
 * 性能约定：
 *   1. 只动 transform / opacity；几何量一次 getBoundingClientRect 之后走缓存（resize 时重算）。
 *   2. 粒子走对象池（预建 40 个，复用，不在飞行中 createElement）。
 *   3. will-change 只在飞行期间挂，落地立刻摘。
 *   4. 一个 rAF 主循环收敛全部运动；结束即 cancelAnimationFrame。
 *   5. prefers-reduced-motion: reduce → 不做抛物线、不做粒子，球原地 200ms 淡出。
 */

/* ---------- 几何：与 index.html 里 #hoop 的 SVG viewBox(0 0 120 108) 对齐 ---------- */
const RIM_FX = 0.5;          // 篮圈中心的横向比例
const RIM_FY = 68 / 108;     // 篮圈中心的纵向比例

/* ---------- 时间线（ms） ---------- */
const T_WINDUP = 80;         // 起手：蓄力回拉
const T_FLIGHT = 480;        // 飞行
const T_DROP = 120;          // 落网：球缩到 0.2 并淡出
const T_TAIL = 60;           // 入网后到"可以上屏"的收尾（合计约 620ms）
const T_ROLLBACK = 320;      // 「这轮跳过」滚回去
const T_SHAKE = 180;         // 空输入：原地晃
const T_REDUCED = 200;       // 降级：原地淡出

/* ---------- 拖尾粒子 ---------- */
const POOL_SIZE = 40;        // 对象池容量
const PARTICLE_LIFE = 380;   // 粒子寿命
const PARTICLE_EVERY = 24;   // 抛粒子间隔
const GHOST_LAG = [60, 120, 180];
const GHOST_OPACITY = [0.28, 0.16, 0.08];

/* ---------- 小的兼容层：测试环境（Node + DOM 桩）没有 rAF / matchMedia ---------- */
const raf = (cb) =>
  (typeof requestAnimationFrame === "function" ? requestAnimationFrame(cb) : setTimeout(() => cb(nowMs()), 16));
const caf = (id) =>
  (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(id) : clearTimeout(id));
const nowMs = () =>
  (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

const num = (v, d) => (typeof v === "number" && v === v ? v : d);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const easeInQuad = (t) => t * t;
const easeOutQuad = (t) => 1 - (1 - t) * (1 - t);
const rnd = (a, b) => a + Math.random() * (b - a);
const lerp = (a, b, t) => a + (b - a) * t;

function prefersReduced() {
  try {
    if (typeof matchMedia !== "function") return false;
    return Boolean(matchMedia("(prefers-reduced-motion: reduce)").matches);
  } catch {
    return false;
  }
}

function narrowScreen() {
  const w = typeof innerWidth === "number" ? innerWidth : 0;
  return w > 0 && w <= 767;
}

/** 取元素中心（视口坐标）；拿不到元素时返回 null，不抛错 */
function centerOf(el) {
  if (!el || typeof el.getBoundingClientRect !== "function") return null;
  let r = null;
  try { r = el.getBoundingClientRect(); } catch { return null; }
  if (!r) return null;
  const w = num(r.width, 0);
  const h = num(r.height, 0);
  const left = num(r.left, 0);
  const top = num(r.top, 0);
  if (!w && !h && !left && !top) return null;
  return { x: left + w / 2, y: top + h / 2, w, h };
}

/* ================================================================== */
/* 挂载                                                                */
/* ================================================================== */

/**
 * @param {object} options
 * @param {Element} options.layerEl  #shotLayer —— position:fixed 的投掷层（球/残影/粒子/光环都在这里）
 * @param {Element} options.hoopEl   #hoop —— 篮筐（内联 SVG）
 * @param {(info:object)=>void} [options.onSwish] 入网回调（音效开关等由挂载方决定）
 */
export function mountShot(options = {}) {
  const layerEl = options.layerEl || null;
  const hoopEl = options.hoopEl || null;
  const onSwish = typeof options.onSwish === "function" ? options.onSwish : null;

  const view = {
    variant: "energy",      // energy | classic（篮筐配色）；球形态另由每次投掷决定
    sound: false,           // 入网音效，默认关闭
    loading: false,
  };

  const state = {
    flying: false,
    reduced: false,
    pendingFail: false,
    rafId: 0,
    particles: [],
    pool: null,
    hoopTimer: 0,
    flashTimer: 0,
    haloId: 0,
    sparkId: 0,
    audioCtx: null,
    lastRim: { x: 0, y: 0 },
  };

  let ball = null;
  let ghosts = [];
  let halo = null;

  /* ---------- 建层：球 / 残影 / 光环 / 粒子池（一次建好，之后只改 style） ---------- */
  function ensureLayer() {
    if (!layerEl || ball) return;
    ball = document.createElement("div");
    ball.className = "shot-ball";
    ball.setAttribute("data-live", "0");
    layerEl.appendChild(ball);

    ghosts = GHOST_LAG.map(() => {
      const g = document.createElement("div");
      g.className = "shot-ball shot-ghost";
      g.setAttribute("data-live", "0");
      layerEl.appendChild(g);
      return g;
    });

    halo = document.createElement("div");
    halo.className = "shot-halo";
    halo.setAttribute("data-live", "0");
    layerEl.appendChild(halo);

    state.pool = [];
    for (let i = 0; i < POOL_SIZE; i += 1) {
      const p = document.createElement("i");
      p.className = "shot-particle";
      p.setAttribute("data-live", "0");
      p.style.opacity = "0";
      layerEl.appendChild(p);
      state.pool.push({ el: p, live: false, x: 0, y: 0, born: 0, life: 0, vx: 0, vy: 0, kind: "trail" });
    }
  }

  /* ---------- 坐标 ---------- */
  function rimPoint() {
    if (!hoopEl || typeof hoopEl.getBoundingClientRect !== "function") return null;
    let r = null;
    try { r = hoopEl.getBoundingClientRect(); } catch { return null; }
    if (!r) return null;
    const w = num(r.width, 0);
    const h = num(r.height, 0);
    const left = num(r.left, 0);
    const top = num(r.top, 0);
    if (!w && !h) return null;
    return { x: left + w * RIM_FX, y: top + h * RIM_FY };
  }

  /** 兜底终点：视口右下（篮筐永远在视口内，正常不会走到这里） */
  function fallbackRim() {
    const w = typeof innerWidth === "number" ? innerWidth : 360;
    const h = typeof innerHeight === "number" ? innerHeight : 720;
    return { x: w * 0.76, y: h * 0.84 };
  }

  /** 控制点：显式抛物线（竖向 easeInQuad 收尾，横向匀速） */
  function controlPoint(a, b) {
    const dx = b.x - a.x;
    return {
      x: (a.x + b.x) / 2 + dx * 0.18,
      y: Math.min(a.y, b.y) - Math.max(120, Math.abs(dx) * 0.42),
    };
  }

  /** 二次贝塞尔（只取竖向；横向按规格走匀速） */
  function bezierY(a, c, b, u) {
    const k = 1 - u;
    return k * k * a.y + 2 * k * u * c.y + u * u * b.y;
  }

  function place(el, x, y, scale, rotate) {
    if (!el) return;
    el.style.transform =
      "translate(-50%, -50%) translate3d(" + x.toFixed(2) + "px, " + y.toFixed(2) + "px, 0)" +
      (rotate ? " rotate(" + rotate.toFixed(2) + "deg)" : "") +
      " scale(" + scale.toFixed(3) + ")";
  }

  function show(el, on) {
    if (el) el.setAttribute("data-live", on ? "1" : "0");
  }

  /* ---------- 粒子池 ---------- */
  function takeParticle() {
    if (!state.pool) return null;
    for (const p of state.pool) if (!p.live) return p;
    return state.pool[0] || null;   // 池满：复用第一个（宁可有轻微重影，也不新建 DOM）
  }

  function spawnTrail(x, y, at) {
    const p = takeParticle();
    if (!p) return;
    p.live = true;
    p.kind = "trail";
    p.x = x + rnd(-6, 6);
    p.y = y + rnd(-6, 6);
    p.born = at;
    p.life = PARTICLE_LIFE;
    p.vx = 0;
    p.vy = 0;
    p.el.setAttribute("data-kind", "trail");
    p.el.setAttribute("data-live", "1");
  }

  function spawnSpark(x, y, at, count, kind) {
    const n = state.reduced ? 0 : count;
    for (let i = 0; i < n; i += 1) {
      const p = takeParticle();
      if (!p) return;
      const ang = (i / n) * Math.PI * 2 + rnd(-0.25, 0.25);
      const speed = rnd(90, 190);
      p.live = true;
      p.kind = kind;
      p.x = x;
      p.y = y;
      p.born = at;
      p.life = 420;
      p.vx = Math.cos(ang) * speed;
      p.vy = Math.sin(ang) * speed - 40;
      p.el.setAttribute("data-kind", kind);
      p.el.setAttribute("data-live", "1");
    }
  }

  function stepParticles(at) {
    if (!state.pool) return;
    for (const p of state.pool) {
      if (!p.live) continue;
      const age = at - p.born;
      const k = age / p.life;
      if (k >= 1 || k < 0) {
        p.live = false;
        p.el.setAttribute("data-live", "0");
        p.el.style.opacity = "0";
        continue;
      }
      if (p.kind === "trail") {
        const op = 0.9 * (1 - k);
        const sc = lerp(1, 0.2, k);
        p.el.style.opacity = op.toFixed(3);
        place(p.el, p.x, p.y, sc, 0);
      } else {
        const s = age / 1000;
        const x = p.x + p.vx * s;
        const y = p.y + p.vy * s + 0.5 * 220 * s * s;   // 一点重力，别飞成直线
        p.el.style.opacity = (1 - k).toFixed(3);
        place(p.el, x, y, lerp(1, 0.5, k), 0);
      }
    }
  }

  /* ---------- 篮筐状态 ---------- */
  function setHoop(nextState, holdMs) {
    if (!hoopEl) return;
    hoopEl.dataset.state = nextState;
    if (state.hoopTimer) clearTimeout(state.hoopTimer);
    state.hoopTimer = 0;
    if (holdMs) {
      state.hoopTimer = setTimeout(() => {
        state.hoopTimer = 0;
        hoopEl.dataset.state = view.loading ? "loading" : "idle";
      }, holdMs);
    }
  }

  function flashRim(color, ms) {
    if (!hoopEl) return;
    hoopEl.dataset.flash = color;
    if (state.flashTimer) clearTimeout(state.flashTimer);
    state.flashTimer = setTimeout(() => {
      state.flashTimer = 0;
      hoopEl.dataset.flash = "";
    }, ms);
  }

  function burstHalo(at) {
    if (!halo || state.reduced) return;
    place(halo, state.lastRim.x, state.lastRim.y, 0.26, 0);
    halo.style.opacity = "0.8";
    halo.setAttribute("data-live", "1");
    const t0 = at;
    const tick = () => {
      const k = (nowMs() - t0) / 520;
      if (k >= 1) {
        halo.setAttribute("data-live", "0");
        halo.style.opacity = "0";
        state.haloId = 0;
        return;
      }
      place(halo, state.lastRim.x, state.lastRim.y, lerp(0.26, 2, easeOutQuad(k)), 0);
      halo.style.opacity = (0.8 * (1 - k)).toFixed(3);
      state.haloId = raf(tick);
    };
    tick();
  }

  /* ---------- 入网音效（懒加载 AudioContext；默认关闭，不创建） ---------- */
  function swishSound() {
    if (!view.sound || typeof window === "undefined") return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!state.audioCtx) state.audioCtx = new AC();
      const ac = state.audioCtx;
      if (ac.state === "suspended" && ac.resume) ac.resume();
      const sr = ac.sampleRate || 44100;
      const dur = 0.22;
      const buf = ac.createBuffer(1, Math.floor(sr * dur), sr);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i += 1) {
        const k = i / data.length;
        const attack = k < 0.05 ? k / 0.05 : 1;
        data[i] = (Math.random() * 2 - 1) * attack * Math.pow(1 - k, 3.2);
      }
      const src = ac.createBufferSource();
      src.buffer = buf;
      const bp = ac.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 2500;
      bp.Q.value = 0.7;
      const gain = ac.createGain();
      gain.gain.value = 0.13;
      src.connect(bp);
      bp.connect(gain);
      gain.connect(ac.destination);
      src.start();
    } catch {
      /* 音效是可选的，失败就不响 */
    }
  }

  /* ---------- 入网反馈（swish，约 380ms） ---------- */
  function swish(at) {
    state.lastRim = rimPoint() || state.lastRim;
    setHoop("swish", 420);
    flashRim("ok", 400);
    burstHalo(at);
    spawnSpark(state.lastRim.x, state.lastRim.y, at, state.reduced ? 0 : (narrowScreen() ? 8 : 14), "spark");
    swishSound();
    if (onSwish) onSwish({ x: state.lastRim.x, y: state.lastRim.y });
  }

  /* ---------- 主循环 ---------- */
  function runThrow(from, variant, done) {
    ensureLayer();
    const t0 = nowMs();
    const origin = { x: from.x, y: from.y };
    let target = rimPoint() || fallbackRim();
    let ctrl = controlPoint(origin, target);
    state.flying = true;
    state.lastRim = target;

    // 起手位置：向斜后方回拉一点（"蓄力"）
    const pull = { x: -10 * Math.sign(target.x - origin.x || 1), y: 5 };
    const start = { x: origin.x + pull.x, y: origin.y + pull.y };
    const reduceTrail = narrowScreen();
    const every = reduceTrail ? PARTICLE_EVERY * 2 : PARTICLE_EVERY;
    let lastPart = -1e9;
    let landed = false;
    let finished = false;
    let wdId = 0;

    const setShape = (el, shape) => { if (el) el.setAttribute("data-variant", shape); };
    setShape(ball, variant);
    for (const g of ghosts) setShape(g, variant);
    if (state.pool) for (const p of state.pool) p.el.setAttribute("data-variant", variant);

    if (ball) ball.style.willChange = "transform, opacity";
    for (const g of ghosts) g.style.willChange = "transform, opacity";

    show(ball, true);
    if (ball) ball.style.opacity = "1";
    for (const g of ghosts) show(g, false);

    const onResize = () => {
      if (finished) return;
      const next = rimPoint();
      if (!next) return;
      target = next;
      state.lastRim = next;
      ctrl = controlPoint(start, target);   // 按新位置重算弹道，继续按当前进度飞
    };
    if (typeof addEventListener === "function") addEventListener("resize", onResize);

    const cleanup = () => {
      if (finished) return;
      finished = true;
      if (wdId) { clearTimeout(wdId); wdId = 0; }
      state.flying = false;
      if (typeof removeEventListener === "function") removeEventListener("resize", onResize);
      if (ball) { ball.style.willChange = ""; show(ball, false); ball.style.opacity = "0"; }
      for (const g of ghosts) { g.style.willChange = ""; show(g, false); }
      if (state.rafId) { caf(state.rafId); state.rafId = 0; }
      /* 入网这一刻如果还在生成中，把筐里的能量环接上来（投篮期间不抢状态） */
      if (hoopEl) hoopEl.dataset.state = view.loading ? "loading" : "idle";
      /* 球还在空中时收到的失败：等入网反馈播完再报红（绿→红的顺序才读得懂） */
      if (state.pendingFail) {
        state.pendingFail = false;
        setTimeout(showError, 420);
      }
      if (done) done();
    };
    /* 兜底：万一 rAF 被挂起（切后台、被测试冻结），也不能让"球还在空中"把发送卡死 */
    wdId = setTimeout(cleanup, T_WINDUP + T_FLIGHT + T_DROP + 600);

    const frame = () => {
      const at = nowMs();
      const el = at - t0;

      if (el < T_WINDUP) {
        const k = clamp(el / T_WINDUP, 0, 1);
        const s = lerp(0.88, 1.14, easeOutQuad(k));
        place(ball, lerp(origin.x, start.x, k), lerp(origin.y, start.y, k), s, lerp(-160, -130, k));
        state.rafId = raf(frame);
        return;
      }

      const raw = clamp((el - T_WINDUP) / T_FLIGHT, 0, 1);
      if (!landed && raw < 1) {
        const ux = raw;                 // 横向：匀速
        const uy = easeInQuad(raw);     // 竖向：收尾加速（落下来要有重力感）
        const bx = lerp(start.x, target.x, ux);
        const by = bezierY(start, ctrl, target, uy);
        const rot = lerp(-160, 25, raw);
        const sc = lerp(1.14, 0.62, raw);
        place(ball, bx, by, sc, rot);
        ball.style.opacity = "1";

        ghosts.forEach((g, i) => {
          const lagged = clamp((el - T_WINDUP - GHOST_LAG[i]) / T_FLIGHT, 0, 1);
          if (lagged <= 0) { show(g, false); return; }
          const gx = lerp(start.x, target.x, lagged);
          const gy = bezierY(start, ctrl, target, easeInQuad(lagged));
          show(g, true);
          g.style.opacity = String(GHOST_OPACITY[i]);
          place(g, gx, gy, lerp(1.14, 0.62, lagged), lerp(-160, 25, lagged));
        });

        if (at - lastPart >= every) {
          lastPart = at;
          spawnTrail(bx, by, at);
        }
      } else if (!landed) {
        landed = true;
        place(ball, target.x, target.y, 0.62, 25);
        for (const g of ghosts) show(g, false);
        swish(at);
        setTimeout(cleanup, T_TAIL);
      }

      if (landed) {
        const k = clamp((el - T_WINDUP - T_FLIGHT) / T_DROP, 0, 1);
        place(ball, target.x, target.y, lerp(0.62, 0.2, k), 25);
        if (ball) ball.style.opacity = String(lerp(1, 0, k).toFixed(3));
      }

      stepParticles(at);
      state.rafId = raf(frame);
    };

    frame();
  }

  /** 降级（reduced motion）：不做抛物线、不做粒子，球原地 200ms 淡出 */
  function runReduced(from, variant, done) {
    ensureLayer();
    const t0 = nowMs();
    const target = rimPoint() || fallbackRim();
    state.lastRim = target;
    state.flying = true;
    if (ball) {
      ball.setAttribute("data-variant", variant);
      show(ball, true);
      ball.style.opacity = "1";
    }
    setHoop("swish", 300);
    flashRim("ok", 300);
    if (onSwish) onSwish({ x: target.x, y: target.y });
    let reducedWd = 0;
    const frame = () => {
      const k = clamp((nowMs() - t0) / T_REDUCED, 0, 1);
      place(ball, from.x, from.y, lerp(1, 0.5, k), 0);
      if (ball) ball.style.opacity = String((1 - k).toFixed(3));
      if (k >= 1) {
        if (reducedWd) clearTimeout(reducedWd);
        state.flying = false;
        show(ball, false);
        if (done) done();
        return;
      }
      state.rafId = raf(frame);
    };
    reducedWd = setTimeout(() => {
      if (!state.flying) return;
      state.flying = false;
      show(ball, false);
      if (done) done();
    }, T_REDUCED + 600);
    frame();
  }

  /* ================================================================== */
  /* 对外 API                                                            */
  /* ================================================================== */

  const api = {
    /** 当前是否有一颗球在飞（用于"球还在空中"的防重复） */
    isFlying() { return state.flying; },
    isReduced() { return state.reduced; },

    /** energy | classic —— 篮筐配色（默认 energy，跟站点能量色一致） */
    setVariant(next) {
      view.variant = next === "classic" ? "classic" : "energy";
      if (hoopEl) hoopEl.dataset.variant = view.variant;
    },
    getVariant() { return view.variant; },

    /** 入网音效开关（默认关闭，打开后才懒加载 AudioContext） */
    setSound(on) { view.sound = Boolean(on); },
    getSound() { return view.sound; },

    /** 生成中：筐内旋转能量环 */
    setLoading(on) {
      view.loading = Boolean(on);
      if (!hoopEl || state.flying) return;
      if (view.loading) {
        if (state.hoopTimer) { clearTimeout(state.hoopTimer); state.hoopTimer = 0; }
        hoopEl.dataset.state = "loading";
      } else if (hoopEl.dataset.state === "loading") {
        hoopEl.dataset.state = "idle";
      }
    },

    /**
     * 投篮：从 fromEl 的位置沿抛物线飞向篮筐。
     * @returns {Promise<string>} 入网（含收尾）后 resolve；"busy" 表示已有球在空中
     */
    throwBall({ fromEl = null, variant = "cyan", text = "" } = {}) {
      void text;
      if (state.flying) return Promise.resolve("busy");
      state.reduced = prefersReduced();
      const from = centerOf(fromEl) || fallbackRim();
      return new Promise((resolve) => {
        const done = () => resolve("swish");
        if (state.reduced) runReduced(from, variant, done);
        else runThrow(from, variant, done);
      });
    },

    /** 「这轮跳过」：不投篮，球就地滚回去（小幅度回弹 + 淡出） */
    rollBack({ fromEl = null, variant = "violet" } = {}) {
      if (state.flying) return Promise.resolve("busy");
      ensureLayer();
      const from = centerOf(fromEl) || fallbackRim();
      state.flying = true;
      if (ball) {
        ball.setAttribute("data-variant", variant);
        show(ball, true);
        ball.style.opacity = "1";
      }
      const t0 = nowMs();
      return new Promise((resolve) => {
        let wd = 0;
        const stop = () => {
          if (wd) clearTimeout(wd);
          state.flying = false;
          show(ball, false);
          resolve("rolled");
        };
        const frame = () => {
          const k = clamp((nowMs() - t0) / T_ROLLBACK, 0, 1);
          // 往回滚：先向右下滚开，再减速淡出（只用 transform/opacity）
          const back = Math.sin(k * Math.PI) * 26;
          place(ball, from.x + back, from.y + Math.sin(k * Math.PI) * 8, lerp(1, 0.7, k), lerp(0, -220, k));
          if (ball) ball.style.opacity = String((1 - Math.pow(k, 2)).toFixed(3));
          if (k >= 1) {
            stop();
            return;
          }
          state.rafId = raf(frame);
        };
        wd = setTimeout(stop, T_ROLLBACK + 600);
        frame();
      });
    },

    /** 空输入：球原地左右轻晃 180ms（不发请求） */
    shake({ fromEl = null, variant = "cyan" } = {}) {
      ensureLayer();
      const from = centerOf(fromEl) || fallbackRim();
      state.flying = true;
      if (ball) {
        ball.setAttribute("data-variant", variant);
        show(ball, true);
        ball.style.opacity = "1";
      }
      const t0 = nowMs();
      return new Promise((resolve) => {
        let wd = 0;
        const stop = () => {
          if (wd) clearTimeout(wd);
          state.flying = false;
          show(ball, false);
          resolve("shaken");
        };
        const frame = () => {
          const k = clamp((nowMs() - t0) / T_SHAKE, 0, 1);
          place(ball, from.x + Math.sin(k * Math.PI * 4) * 9, from.y, 1, 0);
          if (ball) ball.style.opacity = String((1 - k).toFixed(3));
          if (k >= 1) {
            stop();
            return;
          }
          state.rafId = raf(frame);
        };
        wd = setTimeout(stop, T_SHAKE + 600);
        frame();
      });
    },

    /** 失败：篮筐短暂变红 + 抖动 220ms，粒子转红散落（消息流里照常出错误气泡） */
    fail() {
      if (!hoopEl) return;
      if (state.flying) { state.pendingFail = true; return; }   // 球还在空中：落地后再报红
      showError();
    },
  };

  /** 失败的视觉：红篮圈 + 抖动 + 红色火花 */
  function showError() {
    if (!hoopEl) return;
    state.pendingFail = false;
    setHoop("error", 900);
    flashRim("bad", 900);
    const at = nowMs();
    const p = (state.lastRim && (state.lastRim.x || state.lastRim.y)) ? state.lastRim : (rimPoint() || fallbackRim());
    ensureLayer();
    spawnSpark(p.x, p.y, at, state.reduced ? 0 : 10, "spark-bad");
    const t0 = at;
    const step = () => {
      const at2 = nowMs();
      stepParticles(at2);
      if (at2 - t0 < 520) state.sparkId = raf(step);
      else state.sparkId = 0;
    };
    step();
  }

  if (hoopEl) hoopEl.dataset.variant = view.variant;
  return api;
}

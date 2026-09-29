/*
 * Gameplay: judging, scoring, effects and the two renderers.
 *
 *   VerticalGame   - portrait, 4 falling lanes (Piano Tiles / SuperStar).
 *   HorizontalGame - landscape, 3D track (Arcaea-style): floor lanes, arcs traced in the air,
 *                    sky notes; flicks are Phigros-style swipes.
 *
 * Everything on screen is a pure function of the song clock, and taps are judged at the song time
 * of the input event itself, so frame drops never shift a judgment.
 *
 * Scoring units: tap / flick / sky = 1, hold = 2 (press + release), arc = 1 per half-beat tick.
 * Score = 900,000 x accuracy + 100,000 x (max combo / units).
 */
(function (global) {
  'use strict';

  // Timing windows (seconds from the note's exact time): Perfect ±150 ms, Great ±190 ms,
  // Good ±240 ms. A tap 240–300 ms early on a note counts as its miss; earlier taps are ignored.
  const W_PERFECT = 0.15, W_GREAT = 0.19, W_GOOD = 0.24, W_EARLY_MISS = 0.3;
  // Hit zone: a tile already counts once it is in the last 40% of its path to the line (the lit
  // band above the line), not only near the line. Earlier than W_GOOD it scores GOOD; a tap
  // before the tile reaches the zone does nothing.
  const HIT_ZONE = 0.4;
  const HOLD_RELEASE_GRACE = 0.25;
  const FLICK_DIST = 24;      // px of travel that turns a touch into a flick
  const FLICK_WINDOW = 0.3;   // s after the touch to complete the swipe
  const ARC_GRACE = 0.2;      // s: an arc tick passes if a finger was on the arc this recently

  const JUDGE = {
    perfect: { label: 'PERFECT', color: '#5ef0ff', acc: 1 },
    great: { label: 'GREAT', color: '#b69bff', acc: 0.7 },
    good: { label: 'GOOD', color: '#ffd166', acc: 0.4 },
    miss: { label: 'MISS', color: '#ff5c7a', acc: 0 }
  };
  // One plain colour per note type (a skin can change them). Doubles are taps with a white outline.
  const NOTE_COLORS = { tap: '#35b6ff', hold: '#9b6bff', flick: '#ff8a3d', sky: '#ffd166', miss: '#ff5c7a' };
  const ARC_COLORS = ['#4de1ff', '#ff6fb5'];
  // Computer controls. "keys": D F J K lanes, Space + lane key for sky notes and arcs (3D).
  // "mouse": S D F G lanes for the left hand, the mouse is the sky hand (3D).
  const KEYMAPS = {
    keys: { KeyD: 0, KeyF: 1, KeyJ: 2, KeyK: 3 },
    mouse: { KeyS: 0, KeyD: 1, KeyF: 2, KeyG: 3 }
  };
  const KEY_LABELS = { keys: ['D', 'F', 'J', 'K'], mouse: ['S', 'D', 'F', 'G'] };
  const COMMON_KEYS = { ArrowLeft: 0, ArrowDown: 1, ArrowUp: 2, ArrowRight: 3, Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3 };
  let insetProbe = null; // measures the notch / rounded-corner insets
  const FONT = 'Outfit, system-ui, -apple-system, sans-serif';

  // ---------- drawing helpers ----------
  function rgba(hex, a) {
    const v = parseInt(hex.slice(1), 16);
    return 'rgba(' + (v >> 16) + ',' + ((v >> 8) & 255) + ',' + (v & 255) + ',' + a + ')';
  }
  const sprites = new Map();
  function glow(hex) {
    let c = sprites.get(hex);
    if (!c) {
      c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d');
      const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, rgba(hex, 1));
      gr.addColorStop(0.3, rgba(hex, 0.45));
      gr.addColorStop(1, rgba(hex, 0));
      g.fillStyle = gr;
      g.fillRect(0, 0, 64, 64);
      sprites.set(hex, c);
    }
    return c;
  }
  // Draw an image to fill W x H (like CSS background-size: cover), anchored at a focus point in %.
  function drawCover(g, img, W, H, focal) {
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;
    const k = Math.max(W / iw, H / ih), w = iw * k, h = ih * k;
    const fx = (focal ? focal[0] : 50) / 100, fy = (focal ? focal[1] : 50) / 100;
    g.drawImage(img, (W - w) * fx, (H - h) * fy, w, h);
  }
  function hexRgb(hex) {
    const v = parseInt(String(hex).slice(1), 16);
    return (v >> 16) + ',' + ((v >> 8) & 255) + ',' + (v & 255);
  }
  function roundRect(g, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }
  function chevron(g, x, y, size, color) {
    g.strokeStyle = color;
    g.lineWidth = Math.max(2, size * 0.28);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(x - size, y + size * 0.45);
    g.lineTo(x, y - size * 0.45);
    g.lineTo(x + size, y + size * 0.45);
    g.stroke();
  }

  // ---------- particles & effects (visual only, so Math.random is fine) ----------
  class FX {
    constructor() { this.parts = []; this.rings = []; this.flashes = []; }
    burst(x, y, color, n, speed, size) {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + Math.random() * 0.6;
        const v = speed * (0.35 + Math.random() * 0.65);
        this.parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - speed * 0.35, life: 0.35 + Math.random() * 0.35, age: 0, size: size * (0.5 + Math.random() * 0.7), color });
      }
      if (this.parts.length > 160) this.parts.splice(0, this.parts.length - 160);
    }
    spark(x, y, color, size, spread) {
      this.parts.push({ x: x + (Math.random() - 0.5) * spread, y, vx: (Math.random() - 0.5) * 80, vy: -120 - Math.random() * 160, life: 0.3 + Math.random() * 0.25, age: 0, size, color });
    }
    ring(x, y, color, r0, r1, life, width) { this.rings.push({ x, y, color, r0, r1, life, width, age: 0 }); }
    flash(x, y, color, size, life) { this.flashes.push({ x, y, color, size, life, age: 0 }); }
    update(dt) {
      for (const list of [this.parts, this.rings, this.flashes]) {
        for (let i = list.length - 1; i >= 0; i--) {
          const p = list[i];
          p.age += dt;
          if (p.age >= p.life) { list.splice(i, 1); continue; }
          if (p.vx !== undefined) {
            p.vx *= 0.96; p.vy = p.vy * 0.96 + 520 * dt;
            p.x += p.vx * dt; p.y += p.vy * dt;
          }
        }
      }
    }
    draw(g) {
      g.globalCompositeOperation = 'lighter';
      for (const f of this.flashes) {
        const k = f.age / f.life;
        g.globalAlpha = (1 - k) * 0.9;
        const s = f.size * (0.7 + 0.5 * k);
        g.drawImage(glow(f.color), f.x - s, f.y - s, s * 2, s * 2);
      }
      for (const r of this.rings) {
        const k = r.age / r.life;
        g.globalAlpha = (1 - k) * 0.9;
        g.strokeStyle = r.color;
        g.lineWidth = r.width * (1 - k) + 0.5;
        g.beginPath();
        g.arc(r.x, r.y, r.r0 + (r.r1 - r.r0) * (1 - (1 - k) * (1 - k)), 0, Math.PI * 2);
        g.stroke();
      }
      for (const p of this.parts) {
        const k = p.age / p.life;
        g.globalAlpha = 1 - k;
        const s = Math.max(1.5, p.size * 0.45 * (1 - k * 0.5));
        g.fillStyle = p.color;
        g.fillRect(p.x - s, p.y - s, s * 2, s * 2);
      }
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
    }
  }

  // =====================================================================================
  class BaseGame {
    constructor(opts) {
      this.canvas = opts.canvas;
      this.g = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
      this.maxDpr = 2;          // lowered automatically if the device cannot keep up
      this.slowFrames = 0;
      this.frameCount = 0;
      this.chart = opts.chart;
      this.analysis = opts.analysis;
      this.player = opts.player;
      this.onEnd = opts.onEnd;
      this.onPauseChange = opts.onPauseChange || function () {};
      this.onResize = opts.onResize || function () {};
      this.hue = opts.hue == null ? 250 : opts.hue;
      this.sat = opts.sat == null ? 1 : opts.sat;       // stage theme saturation
      this.skin = opts.skin || null;                    // tile skin: { lanes: [[light, dark] x4], flick? }
      this.popups = [];                                 // judgment pop-ups at the hit position
      this.tapOffset = opts.tapOffset || 0;             // s; positive = you usually tap late
      this.controls = opts.controls === 'mouse' ? 'mouse' : 'keys';
      this.showKeys = !!opts.showKeys;                  // faint key letters under the lanes
      // Picture theme: { image, focal, game: { veil, field, line, accent, notes } } or null.
      this.theme = opts.theme && opts.theme.game ? opts.theme : null;
      this.font = opts.font || FONT;
      this.accent = this.theme ? this.theme.game.accent : '#4de1ff';
      this.accentRgb = hexRgb(this.accent);
      this.spaceHeld = false;
      this.S = this.chart.speed;
      const A = this.analysis;
      this.beats = A.beats;
      this.bars = [];
      for (let i = A.downbeatPhase; i < A.beats.length; i += 4) this.bars.push(A.beats[i]);
      this.fx = new FX();
      this.stars = [];
      for (let i = 0; i < 70; i++) this.stars.push({ x: Math.random(), y: Math.random(), r: 0.4 + Math.random() * 1.3, tw: Math.random() * 6.28, sp: 0.2 + Math.random() * 0.8 });

      this.handlers = {
        resize: () => { this.resize(); this.onResize(this); },
        down: (e) => this.onPointerDown(e),
        move: (e) => this.onPointerMove(e),
        up: (e) => this.onPointerUp(e),
        keydown: (e) => this.onKeyDown(e),
        keyup: (e) => this.onKeyUp(e),
        visibility: () => { if (document.hidden) this.pause(); },
        blockTouch: (e) => e.preventDefault()
      };
      window.addEventListener('resize', this.handlers.resize);
      this.canvas.addEventListener('pointerdown', this.handlers.down);
      window.addEventListener('pointermove', this.handlers.move);
      window.addEventListener('pointerup', this.handlers.up);
      window.addEventListener('pointercancel', this.handlers.up);
      window.addEventListener('keydown', this.handlers.keydown);
      window.addEventListener('keyup', this.handlers.keyup);
      document.addEventListener('visibilitychange', this.handlers.visibility);
      this.canvas.addEventListener('touchstart', this.handlers.blockTouch, { passive: false });
      this.resize();
      this.reset();
    }

    reset() {
      this.notes = this.chart.notes.map(n => Object.assign({}, n, {
        state: 0, judge: null, hitAt: 0, missAt: 0, hold: 0, holder: null, flickBy: null, flickDt: 0, flickAt: 0,
        nextSameT: Infinity
      }));
      this.arcs = (this.chart.arcs || []).map(a => Object.assign({}, a, { tickIdx: 0, lastOnAt: -99, tracked: false, missFlash: -9 }));
      this.laneQ = [[], [], [], []];
      this.skyQ = [];
      this.notes.forEach((n, i) => { if (n.type === 'sky') this.skyQ.push(i); else this.laneQ[n.lane].push(i); });
      for (const q of this.laneQ) for (let k = 0; k + 1 < q.length; k++) this.notes[q[k]].nextSameT = this.notes[q[k + 1]].t;
      this.laneIdx = [0, 0, 0, 0];
      this.skyIdx = 0;
      this.drawStart = 0;
      this.pendingFlicks = [];
      let units = 0, holds = 0;
      for (const n of this.notes) { units += n.type === 'hold' ? 2 : 1; if (n.type === 'hold') holds++; }
      for (const a of this.arcs) units += a.ticks.length;
      this.stats = { perfect: 0, great: 0, good: 0, miss: 0, combo: 0, maxCombo: 0, accSum: 0, judged: 0, units, offSum: 0, offN: 0, holds, holdsDone: 0, gauge: 0, flicksSwiped: 0, arcTicksHit: 0 };
      this.ptrs = new Map();
      this.laneFlash = [-10, -10, -10, -10];
      this.lastJudge = null; this.lastJudgeAt = -10; this.lastJudgeDt = 0;
      this.comboBumpAt = -10; this.milestone = 0; this.milestoneAt = -10;
      this.displayScore = 0;
      this.finished = false; this.paused = false; this.resumeTarget = null;
      let endT = 0;
      for (const n of this.notes) endT = Math.max(endT, n.t + n.dur);
      for (const a of this.arcs) endT = Math.max(endT, a.t1);
      this.endTime = this.notes.length ? endT + 1.4 : this.analysis.duration;
      const first = Math.min(this.notes.length ? this.notes[0].t : 0, this.arcs.length ? this.arcs[0].t0 : Infinity);
      // Playback range: the whole song, or one part of it (chart.range). Music starts a little
      // before the range so the first notes have time to arrive.
      this.rangeStart = this.chart.range ? this.chart.range.start : 0;
      this.playFrom = Math.min(this.rangeStart - 1.5, first - this.chart.travel - 1.2);
      this.lastPerf = performance.now();
    }

    start() { this.player.play(this.playFrom); this.running = true; this.loop(); }

    restart() {
      this.player.stop();
      this.reset();
      this.onPauseChange(false);
      this.player.play(this.playFrom);
      if (!this.running) { this.running = true; this.loop(); }
    }

    pause() {
      if (this.paused || this.finished || !this.running) return;
      const t = this.player.pause();
      this.paused = true;
      this.pausedAt = t;
      for (const n of this.notes) if (n.hold === 1) this.releaseHold(n, t);
      for (const n of this.pendingFlicks.slice()) this.resolveFlick(n, false);
      this.ptrs.clear();
      this.onPauseChange(true);
    }

    resume() {
      if (!this.paused) return;
      this.paused = false;
      this.resumeTarget = this.pausedAt;
      this.player.play(Math.max(this.playFrom, this.pausedAt - 2.5));
      this.onPauseChange(false);
    }

    destroy() {
      this.running = false;
      if (this.raf) cancelAnimationFrame(this.raf);
      this.player.stop();
      window.removeEventListener('resize', this.handlers.resize);
      this.canvas.removeEventListener('pointerdown', this.handlers.down);
      window.removeEventListener('pointermove', this.handlers.move);
      window.removeEventListener('pointerup', this.handlers.up);
      window.removeEventListener('pointercancel', this.handlers.up);
      window.removeEventListener('keydown', this.handlers.keydown);
      window.removeEventListener('keyup', this.handlers.keyup);
      document.removeEventListener('visibilitychange', this.handlers.visibility);
      this.canvas.removeEventListener('touchstart', this.handlers.blockTouch);
    }

    resize() {
      const dpr = Math.min(global.devicePixelRatio || 1, this.maxDpr || 2);
      this.dpr = dpr;
      const r = this.canvas.getBoundingClientRect();
      this.W = Math.max(1, r.width);
      this.H = Math.max(1, r.height);
      this.canvas.width = Math.round(this.W * dpr);
      this.canvas.height = Math.round(this.H * dpr);
      this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.unit = Math.min(this.W, this.H) / 400; // scale for effects and text
      // Keep HUD text clear of the notch / rounded corners (installed app in landscape).
      if (!insetProbe) {
        insetProbe = document.createElement('div');
        insetProbe.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;padding-left:env(safe-area-inset-left,0px);padding-right:env(safe-area-inset-right,0px)';
        document.body.appendChild(insetProbe);
      }
      const cs = getComputedStyle(insetProbe);
      this.insetL = parseFloat(cs.paddingLeft) || 0;
      this.insetR = parseFloat(cs.paddingRight) || 0;
      this.layout();
    }

    // ---------- input ----------
    localXY(e) {
      const r = this.canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    onPointerDown(e) {
      e.preventDefault();
      if (this.paused || this.finished) return;
      const { x, y } = this.localXY(e);
      const t = this.tapTime(e);
      const id = 'p' + e.pointerId;
      this.inputDown(id, x, y, t, e.pointerType === 'mouse');
    }
    onPointerMove(e) {
      const p = this.ptrs.get('p' + e.pointerId);
      if (!p) return;
      const { x, y } = this.localXY(e);
      this.inputMove('p' + e.pointerId, x, y, this.tapTime(e));
    }
    onPointerUp(e) { this.inputUp('p' + e.pointerId, this.tapTime(e)); }
    tapTime(e) { return this.player.timeAtEvent(e) - this.tapOffset; }
    onKeyDown(e) {
      const pauseKey = e.code === 'Escape' || e.code === 'KeyP' || (e.code === 'Space' && !this.spaceIsSky());
      if (pauseKey) {
        e.preventDefault();
        if (e.repeat) return;
        if (this.paused) this.resume(); else this.pause();
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        if (!e.repeat && !this.paused && !this.finished) this.setSpace(true, this.tapTime(e));
        return;
      }
      const lane = this.keyLane(e.code);
      if (lane == null || e.repeat || this.paused || this.finished) return;
      e.preventDefault();
      this.keyDown('k' + e.code, lane, this.tapTime(e));
    }
    onKeyUp(e) {
      if (e.code === 'Space') { if (this.spaceIsSky()) this.setSpace(false); return; }
      if (this.keyLane(e.code) == null) return;
      this.inputUp('k' + e.code, this.tapTime(e));
    }
    keyLane(code) {
      const m = KEYMAPS[this.controls];
      return code in m ? m[code] : COMMON_KEYS[code];
    }
    // Public so tests can press keys without real events.
    keyDown(id, lane, t) {
      const p = { key: true, lane, keyLane: lane, x: -1, y: -1, x0: -1, y0: -1, at: t, sky: false, hitFloor: false };
      this.ptrs.set(id, p);
      if (this.spaceHeld && this.keySky(id, p, lane, t)) return;
      const before = this.laneIdx[lane];
      this.pressLane(id, lane, t, true);
      p.hitFloor = this.laneIdx[lane] !== before;
    }
    spaceIsSky() { return false; }
    setSpace(on) { this.spaceHeld = on; }
    keySky() { return false; }

    // Public so tests / bots can drive the game without real events.
    inputDown(id, x, y, t, isMouse) {
      if (this.paused || this.finished) return;
      const p = { x, y, x0: x, y0: y, t0: t, lane: -1, mouse: !!isMouse };
      this.ptrs.set(id, p);
      this.handleDown(id, p, t);
    }
    inputMove(id, x, y, t) {
      const p = this.ptrs.get(id);
      if (!p) return;
      p.x = x; p.y = y;
      for (const n of this.pendingFlicks.slice()) {
        if (n.flickBy === id && Math.hypot(x - p.x0, y - p.y0) >= FLICK_DIST * Math.max(0.8, this.unit)) this.resolveFlick(n, true);
      }
      // Sliding a finger from one lane into the next (without lifting it) plays the new lane,
      // unless that finger is holding a hold note.
      const lane = this.slideLane(p);
      if (lane >= 0 && p.lane >= 0 && lane !== p.lane && !this.isHolding(id)) this.pressLane(id, lane, t, false, true);
    }
    slideLane() { return -1; }
    isHolding(id) {
      for (let i = this.drawStart; i < this.notes.length; i++) {
        const n = this.notes[i];
        if (n.hold === 1 && n.holder === id) return true;
      }
      return false;
    }
    inputUp(id, t) {
      if (!this.ptrs.has(id)) return;
      this.ptrs.delete(id);
      for (const n of this.pendingFlicks.slice()) if (n.flickBy === id) this.resolveFlick(n, false);
      for (let i = this.drawStart; i < this.notes.length; i++) {
        const n = this.notes[i];
        if (n.t > t + 1) break;
        if (n.hold === 1 && n.holder === id) this.releaseHold(n, t);
      }
    }

    inZone(n, t) { return t - n.t >= -W_EARLY_MISS || this.S.at(n.t) - this.S.at(t) <= HIT_ZONE; }

    judgeOf(dt) {
      const a = Math.abs(dt);
      return a <= W_PERFECT ? 'perfect' : a <= W_GREAT ? 'great' : 'good';
    }

    pressLane(id, lane, t, viaKey, slide) {
      this.laneFlash[lane] = t;
      const p = this.ptrs.get(id);
      if (p) p.lane = lane;
      const q = this.laneQ[lane];
      if (this.laneIdx[lane] >= q.length) return;
      // The tap goes to the earliest note still waiting in this lane (a late tap stays with the
      // note it was meant for instead of jumping ahead to the next one).
      const n = this.notes[q[this.laneIdx[lane]]];
      const dt = t - n.t;
      if (dt < -W_GOOD && (slide || !this.inZone(n, t))) return; // not in the zone yet: harmless tap
      this.laneIdx[lane]++;
      if (dt > W_GOOD) { this.missNote(n, t); return; }
      if (n.type === 'flick' && !viaKey) {
        n.flickBy = id; n.flickDt = dt; n.flickAt = t;
        this.pendingFlicks.push(n);
        return;
      }
      this.hitNote(n, this.judgeOf(dt), t, dt);
      if (n.type === 'hold') { n.hold = 1; n.holder = id; }
    }

    // A flick touched in time scores by its timing once swiped; a plain tap only gets GOOD.
    resolveFlick(n, swiped) {
      const i = this.pendingFlicks.indexOf(n);
      if (i < 0) return;
      this.pendingFlicks.splice(i, 1);
      this.hitNote(n, swiped ? this.judgeOf(n.flickDt) : 'good', n.flickAt, n.flickDt);
      if (swiped) {
        this.stats.flicksSwiped++;
        const pos = this.notePos(n);
        this.fx.burst(pos.x, pos.y - 20 * this.unit, this.colorOf('flick'), 6, 520 * this.unit, 9 * this.unit);
      }
    }

    judgeUnit(j, dt, t) {
      const s = this.stats;
      s[j]++;
      s.judged++;
      s.accSum += JUDGE[j].acc;
      // Clear gauge (Arcaea-style): every hit fills it, a miss drains as much as a hit adds.
      // End at 70%+ to clear, which takes roughly 85% of notes hit.
      const step = 100 / Math.max(1, s.units);
      s.gauge = Math.max(0, Math.min(100, s.gauge + step * (j === 'miss' ? -1 : j === 'perfect' ? 1 : j === 'great' ? 0.85 : 0.6)));
      if (j === 'miss') s.combo = 0;
      else {
        s.combo++;
        if (s.combo > s.maxCombo) s.maxCombo = s.combo;
        if (s.combo % 50 === 0) { this.milestone = s.combo; this.milestoneAt = t; }
      }
      if (dt != null && Math.abs(dt) <= W_GOOD) { s.offSum += dt; s.offN++; }
      this.lastJudge = j; this.lastJudgeAt = t; this.lastJudgeDt = dt == null ? 0 : dt;
      if (j !== 'miss') this.comboBumpAt = t;
    }

    hitNote(n, j, t, dt) {
      n.state = 1; n.judge = j; n.hitAt = t;
      this.judgeUnit(j, dt, t);
      const pos = this.notePos(n);
      this.hitEffect(pos, j, n);
      if (this.usePopups) this.popups.push({ x: pos.x, y: pos.y, j, at: performance.now() });
    }

    missNote(n, t) {
      n.state = 2; n.judge = 'miss'; n.missAt = t;
      this.judgeUnit('miss', null, t);
      if (n.type === 'hold') this.judgeUnit('miss', null, t);
      const pos = this.notePos(n);
      this.fx.flash(pos.x, pos.y, JUDGE.miss.color, 40 * this.unit, 0.25);
      if (this.usePopups) this.popups.push({ x: pos.x, y: pos.y, j: 'miss', at: performance.now() });
    }

    completeHold(n, t) {
      n.hold = 2;
      this.stats.holdsDone++;
      this.judgeUnit('perfect', null, t);
      const pos = this.notePos(n);
      this.fx.ring(pos.x, pos.y, this.colorOf('hold'), 10 * this.unit, 70 * this.unit, 0.45, 5 * this.unit);
      this.fx.burst(pos.x, pos.y, this.colorOf('hold'), 8, 460 * this.unit, 10 * this.unit);
    }

    releaseHold(n, t) {
      if (n.hold !== 1) return;
      if (t >= n.t + n.dur - HOLD_RELEASE_GRACE) this.completeHold(n, t);
      else { n.hold = 3; n.releasedAt = t; this.judgeUnit('miss', null, t); }
    }

    hitEffect(pos, j, n) {
      const u = this.unit;
      const c = this.colorOf(n.type);
      const jc = JUDGE[j].color;
      this.fx.flash(pos.x, pos.y, c, (j === 'perfect' ? 60 : 44) * u, 0.2);
      this.fx.ring(pos.x, pos.y, jc, 12 * u, (j === 'perfect' ? 64 : 48) * u, 0.38, 5 * u);
      this.fx.burst(pos.x, pos.y, c, j === 'perfect' ? 8 : 5, 420 * u, 9 * u);
    }

    // The single colour of a note type, from the equipped skin when it sets one.
    colorOf(type) {
      const sk = this.skin || {}, tn = (this.theme && this.theme.game.notes) || {};
      if (type === 'hold') return sk.hold || tn.hold || NOTE_COLORS.hold;
      if (type === 'flick') return sk.flick || tn.flick || NOTE_COLORS.flick;
      if (type === 'sky') return NOTE_COLORS.sky;
      return sk.tap || tn.tap || NOTE_COLORS.tap;
    }

    satp(v) { return Math.round(Math.min(100, v * this.sat)); }

    drawKeyLabels(xs, y) {
      if (!this.showKeys) return;
      const g = this.g;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = '700 ' + Math.round(12 + 2 * this.unit) + 'px ' + this.font;
      g.fillStyle = 'rgba(232,235,245,0.32)';
      KEY_LABELS[this.controls].forEach((k, i) => g.fillText(k, xs[i], y));
    }

    drawPopups() {
      const g = this.g, u = this.unit, perf = performance.now();
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (let i = this.popups.length - 1; i >= 0; i--) {
        const p = this.popups[i];
        const k = (perf - p.at) / 480;
        if (k >= 1) { this.popups.splice(i, 1); continue; }
        g.globalAlpha = 1 - k * k;
        g.font = '900 ' + Math.round(11 + 3 * u) + 'px ' + this.font;
        g.lineWidth = 3;
        g.strokeStyle = 'rgba(6,7,12,0.7)';
        const y = p.y - (22 + 18 * k) * u;
        g.strokeText(JUDGE[p.j].label, p.x, y);
        g.fillStyle = JUDGE[p.j].color;
        g.fillText(JUDGE[p.j].label, p.x, y);
      }
      g.globalAlpha = 1;
      if (this.popups.length > 24) this.popups.splice(0, this.popups.length - 24);
    }

    score() {
      const s = this.stats;
      if (!s.units) return 0;
      return Math.round(900000 * s.accSum / s.units + 100000 * s.maxCombo / s.units);
    }

    // ---------- loop ----------
    loop() {
      if (!this.running) return;
      this.raf = requestAnimationFrame(() => this.loop());
      const perf = performance.now();
      const dt = Math.min(0.05, (perf - this.lastPerf) / 1000);
      this.lastPerf = perf;
      const now = this.player.now();
      if (!this.paused && !this.finished) this.update(now);
      this.fx.update(this.paused ? 0 : dt);
      const target = this.score();
      this.displayScore += (target - this.displayScore) * Math.min(1, dt * 12);
      if (Math.abs(target - this.displayScore) < 1) this.displayScore = target;
      this.draw(this.paused ? this.pausedAt : now, dt);
      // Keep motion smooth on slower phones: if many frames take longer than ~22 ms, render at a
      // lower resolution (2x -> 1.5x -> 1x). Only ever steps down, so it cannot flicker.
      if (!this.paused && dt > 0) {
        this.frameCount++;
        if (dt > 0.022) this.slowFrames++;
        if (this.frameCount >= 90) {
          if (this.slowFrames > 30 && this.maxDpr > 1) {
            this.maxDpr = this.maxDpr > 1.5 ? 1.5 : 1;
            this.resize();
          }
          this.frameCount = 0;
          this.slowFrames = 0;
        }
      }
    }

    update(now) {
      for (let l = 0; l < 4; l++) {
        const q = this.laneQ[l];
        while (this.laneIdx[l] < q.length) {
          const n = this.notes[q[this.laneIdx[l]]];
          if (n.t >= now - W_GOOD) break;
          this.laneIdx[l]++;
          this.missNote(n, now);
        }
      }
      for (const n of this.pendingFlicks.slice()) if (now - n.flickAt > FLICK_WINDOW) this.resolveFlick(n, false);
      for (let i = this.drawStart; i < this.notes.length; i++) {
        const n = this.notes[i];
        if (n.t > now) break;
        if (n.hold === 1) {
          if (now >= n.t + n.dur) this.completeHold(n, now);
          else if (Math.random() < 0.3) {
            const pos = this.notePos(n);
            this.fx.spark(pos.x, pos.y, this.colorOf('hold'), 7 * this.unit, 24 * this.unit);
          }
        }
      }
      this.updateMode(now);
      while (this.drawStart < this.notes.length) {
        const n = this.notes[this.drawStart];
        if (n.state === 0 || n.hold === 1 || n.t + n.dur > now - 1) break;
        this.drawStart++;
      }
      if (now >= this.endTime || now >= this.analysis.duration + 0.3) this.finish();
    }

    updateMode() {}

    finish() {
      if (this.finished) return;
      this.finished = true;
      this.player.fadeOut(1.2);
      const s = this.stats;
      const acc = s.units ? s.accSum / s.units * 100 : 0;
      const result = {
        score: this.score(), accuracy: acc, maxCombo: s.maxCombo, total: s.units,
        perfect: s.perfect, great: s.great, good: s.good, miss: s.miss,
        holds: s.holds, holdsDone: s.holdsDone, notes: this.notes.length, arcs: this.arcs.length,
        fullCombo: s.miss === 0 && s.units > 0,
        meanOffsetMs: s.offN >= 10 ? (s.offSum / s.offN) * 1000 : null,
        gauge: s.gauge, flicksSwiped: s.flicksSwiped, arcTicksHit: s.arcTicksHit
      };
      setTimeout(() => { this.running = false; this.onEnd(result); }, 900);
    }

    // ---------- shared drawing ----------
    beatPulse(now) {
      const bi = PTUtil.lowerBound(this.beats, now + 0.0001) - 1;
      const since = bi >= 0 ? now - this.beats[bi] : 10;
      return Math.exp(-Math.max(0, since) * 6);
    }
    energyAt(now) {
      for (const s of this.analysis.sections) if (now >= s.start && now < s.end) return s.energy;
      return 0.3;
    }

    drawHud(now, comboY, judgeY, comboScale) {
      const g = this.g, W = this.W, H = this.H, s = this.stats, u = this.unit;
      const cx = this.hudCx != null ? this.hudCx : W / 2;
      // Progress bar with section ticks.
      const span = Math.max(1, this.endTime - this.rangeStart);
      const prog = Math.max(0, Math.min(1, (now - this.rangeStart) / span));
      g.fillStyle = 'rgba(255,255,255,0.08)';
      g.fillRect(0, 0, W, 4);
      g.fillStyle = this.accent;
      g.fillRect(0, 0, W * prog, 4);
      g.fillStyle = 'rgba(255,255,255,0.35)';
      for (const sec of this.analysis.sections) {
        if (sec.start > this.rangeStart && sec.start < this.endTime) g.fillRect(Math.round(W * (sec.start - this.rangeStart) / span), 0, 1, 4);
      }

      // Score + accuracy.
      const pad = 16 + (this.insetR || 0);
      g.textAlign = 'right';
      g.textBaseline = 'top';
      g.fillStyle = 'rgba(232,235,245,0.5)';
      g.font = '600 ' + Math.round(10 + 1.5 * u) + 'px ' + this.font;
      g.fillText('SCORE', W - pad, 14);
      // Dark outlines keep the score readable over light tiles.
      g.lineJoin = 'round';
      g.lineWidth = 4;
      g.strokeStyle = 'rgba(6,7,12,0.75)';
      g.font = '800 ' + Math.round(20 + 4 * u) + 'px ' + this.font;
      const scoreText = String(Math.round(this.displayScore)).padStart(7, '0');
      g.strokeText(scoreText, W - pad, 28);
      g.fillStyle = '#f3f5ff';
      g.fillText(scoreText, W - pad, 28);
      const acc = s.judged ? s.accSum / s.judged * 100 : 100;
      g.font = '600 ' + Math.round(11 + 1.5 * u) + 'px ' + this.font;
      g.lineWidth = 3;
      g.strokeText(acc.toFixed(2) + '%', W - pad, 30 + 24 + 4 * u);
      g.fillStyle = 'rgba(232,235,245,0.75)';
      g.fillText(acc.toFixed(2) + '%', W - pad, 30 + 24 + 4 * u);

      // Clear gauge next to the pause button; the notch marks the 70% needed to clear.
      const gx = 68 + (this.insetL || 0), gy = 24, gw = Math.min(190, W * 0.3), gh = 7;
      roundRect(g, gx, gy, gw, gh, 3.5);
      g.fillStyle = 'rgba(255,255,255,0.1)';
      g.fill();
      const cleared = s.gauge >= 70;
      if (s.gauge > 0) {
        roundRect(g, gx, gy, Math.max(gh, gw * s.gauge / 100), gh, 3.5);
        g.fillStyle = cleared ? '#5ef0ff' : '#ff6fb5';
        g.fill();
      }
      g.fillStyle = '#ffffff';
      g.fillRect(gx + gw * 0.7 - 1, gy - 3, 2, gh + 6);
      g.textAlign = 'left';
      g.textBaseline = 'top';
      g.font = '700 ' + Math.round(9 + 1.5 * u) + 'px ' + this.font;
      g.fillStyle = cleared ? 'rgba(94,240,255,0.9)' : 'rgba(232,235,245,0.55)';
      g.fillText('CLEAR ' + Math.floor(s.gauge) + '%', gx, gy + gh + 5);

      g.textAlign = 'center';
      g.textBaseline = 'middle';
      // Combo.
      if (s.combo >= 3) {
        const bump = Math.max(0, 1 - (now - this.comboBumpAt) / 0.14);
        const size = Math.round((28 + 16 * u) * (comboScale || 1) * (1 + 0.14 * bump));
        g.font = '800 ' + size + 'px ' + this.font;
        g.lineWidth = 4;
        g.strokeStyle = 'rgba(6,7,12,0.55)';
        g.strokeText(String(s.combo), cx, comboY);
        g.fillStyle = '#ffffff';
        g.fillText(String(s.combo), cx, comboY);
        g.fillStyle = 'rgba(232,235,245,0.5)';
        g.font = '700 ' + Math.round(10 + 1.5 * u) + 'px ' + this.font;
        g.fillText('COMBO', cx, comboY + size * 0.62);
      }
      // Judgment: centred in portrait; in landscape it pops up where the note was hit.
      const since = now - this.lastJudgeAt;
      if (judgeY != null && this.lastJudge && since < 0.55 && since >= -0.05) {
        const J = JUDGE[this.lastJudge];
        const k = Math.max(0, since) / 0.55;
        const pop = 1 + 0.3 * Math.max(0, 1 - Math.max(0, since) / 0.09);
        const size = Math.round((18 + 6 * u) * pop);
        g.globalAlpha = 1 - k * k;
        g.font = '900 ' + size + 'px ' + this.font;
        g.lineWidth = 5;
        g.strokeStyle = 'rgba(6,7,12,0.6)';
        g.strokeText(J.label, cx, judgeY - k * 8);
        g.fillStyle = J.color;
        g.fillText(J.label, cx, judgeY - k * 8);
        if ((this.lastJudge === 'great' || this.lastJudge === 'good') && this.lastJudgeDt) {
          g.font = '700 ' + Math.round(10 + u) + 'px ' + this.font;
          g.fillStyle = 'rgba(232,235,245,0.75)';
          g.fillText(this.lastJudgeDt < 0 ? 'EARLY' : 'LATE', cx, judgeY + size * 0.75 - k * 8);
        }
        g.globalAlpha = 1;
      }
      // Combo milestone.
      const ms = now - this.milestoneAt;
      if (ms >= 0 && ms < 1.1) {
        const k = ms / 1.1;
        g.globalAlpha = (1 - k) * 0.9;
        g.font = '900 ' + Math.round((24 + 10 * u) * (1 + 0.2 * k)) + 'px ' + this.font;
        g.fillStyle = '#ffd166';
        let my = comboY - (40 + 20 * u);
        if (my < 40) my = comboY + 56 * u;
        g.fillText(this.milestone + ' COMBO!', cx, my - k * 20);
        g.globalAlpha = 1;
      }
      // Speed-up cue.
      for (const c of this.S.cues) {
        const d = now - c;
        if (d >= 0 && d < 1.4) {
          g.globalAlpha = Math.min(1, (1.4 - d) * 2) * 0.9;
          g.fillStyle = '#c3a6ff';
          g.font = '800 ' + Math.round(13 + 2 * u) + 'px ' + this.font;
          g.fillText('SPEED UP  ▲', cx, (judgeY != null ? judgeY : comboY + 40 * u) + (40 + 18 * u));
          g.globalAlpha = 1;
        }
      }
      // Lead-in / resume countdown.
      let countdown = null;
      if (now < this.rangeStart) countdown = Math.ceil(this.rangeStart - now);
      else if (this.resumeTarget != null) {
        if (now < this.resumeTarget) countdown = Math.ceil(this.resumeTarget - now);
        else this.resumeTarget = null;
      }
      if (countdown != null && !this.paused) {
        g.fillStyle = 'rgba(243,245,255,0.9)';
        g.font = '900 ' + Math.round(H * 0.09) + 'px ' + this.font;
        g.fillText(String(Math.min(countdown, 9)), cx, H * 0.46);
        g.fillStyle = 'rgba(232,235,245,0.5)';
        g.font = '700 ' + Math.round(11 + 1.5 * u) + 'px ' + this.font;
        g.fillText(now < this.rangeStart ? 'GET READY' : 'RESUMING', cx, H * 0.46 + H * 0.065);
      }
    }
  }

  // =====================================================================================
  // Portrait: four falling lanes.
  class VerticalGame extends BaseGame {
    layout() {
      this.fieldW = Math.min(this.W, this.H * 0.62, 560);
      this.fieldX = (this.W - this.fieldW) / 2;
      this.laneW = this.fieldW / 4;
      this.hitY = Math.round(this.H * 0.8);
      this.maxTileH = Math.max(46, Math.min(this.hitY * 0.14, 130));
      this.hudCx = this.fieldX + this.fieldW / 2;
      this.buildBackdrop();
    }

    // The static backdrop (colour wash, soft glows, stars, lane field) is drawn once per resize
    // into an offscreen canvas; each frame then copies it in a single call.
    buildBackdrop() {
      const W = this.W, H = this.H, dpr = this.dpr || 1;
      const c = document.createElement('canvas');
      c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
      const g = c.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const th = this.theme;
      if (th && th.image) {
        // Picture theme: the picture, a veil for contrast, then the lane field.
        drawCover(g, th.image, W, H, th.focal);
        g.fillStyle = th.game.veil;
        g.fillRect(0, 0, W, H);
      } else {
        const bg = g.createLinearGradient(0, 0, 0, H);
        bg.addColorStop(0, 'hsl(' + this.hue + ',' + this.satp(48) + '%,12%)');
        bg.addColorStop(0.6, 'hsl(' + (this.hue + 25) + ',' + this.satp(52) + '%,7%)');
        bg.addColorStop(1, 'hsl(' + (this.hue + 40) + ',' + this.satp(55) + '%,4%)');
        g.fillStyle = bg;
        g.fillRect(0, 0, W, H);
        g.globalCompositeOperation = 'lighter';
        g.globalAlpha = 0.22;
        [[0.2, 0.25, this.hue], [0.85, 0.45, this.hue + 60], [0.45, 0.85, this.hue - 40]].forEach(([bx, by, h]) => {
          const r = Math.max(W, H) * 0.6;
          g.drawImage(glow(hslHex(h, this.satp(80), 55)), W * bx - r, H * by - r, r * 2, r * 2);
        });
        g.globalAlpha = 0.5;
        g.fillStyle = '#dfe8ff';
        for (const st of this.stars) g.fillRect(st.x * W, st.y * H, st.r, st.r);
        g.globalAlpha = 1;
        g.globalCompositeOperation = 'source-over';
      }
      const fx = this.fieldX, fw = this.fieldW, lw = this.laneW, hitY = this.hitY;
      g.fillStyle = th ? th.game.field : 'rgba(8,10,22,0.55)';
      g.fillRect(fx, 0, fw, H);
      g.fillStyle = th ? th.game.line : 'rgba(160,190,255,0.12)';
      for (let l = 0; l <= 4; l++) g.fillRect(Math.round(fx + l * lw) - 0.5, 0, 1, hitY);
      const zoneTop = hitY * (1 - HIT_ZONE);
      const zg = g.createLinearGradient(0, zoneTop, 0, hitY);
      zg.addColorStop(0, 'rgba(' + this.accentRgb + ',0)');
      zg.addColorStop(1, 'rgba(' + this.accentRgb + ',0.13)');
      g.fillStyle = zg;
      g.fillRect(fx, zoneTop, fw, hitY - zoneTop);
      for (let l = 0; l < 4; l++) {
        const x = fx + l * lw + 5, w = lw - 10, y = hitY + 10, h = H - hitY - 22;
        if (h < 20) break;
        roundRect(g, x, y, w, h, 14);
        g.fillStyle = 'rgba(255,255,255,0.035)';
        g.fill();
        g.strokeStyle = th ? th.game.line : 'rgba(170,190,255,0.14)';
        g.lineWidth = 1.5;
        g.stroke();
      }
      this.backdrop = c;
    }

    laneAt(x) {
      const rel = x - this.fieldX;
      if (rel < -this.laneW * 0.5 || rel > this.fieldW + this.laneW * 0.5) return -1;
      return Math.max(0, Math.min(3, Math.floor(rel / this.laneW)));
    }

    handleDown(id, p, t) {
      const lane = this.laneAt(p.x);
      if (lane < 0) return;
      this.pressLane(id, lane, t, false);
    }
    slideLane(p) { return this.laneAt(p.x); }

    notePos(n) { return { x: this.fieldX + (n.lane + 0.5) * this.laneW, y: this.hitY }; }
    yAt(t, dNow) { return this.hitY - (this.S.at(t) - dNow) * this.hitY; }

    draw(now) {
      const g = this.g, W = this.W, H = this.H, fx = this.fieldX, fw = this.fieldW, lw = this.laneW, hitY = this.hitY;
      const dNow = this.S.at(now);
      const pulse = this.beatPulse(now);

      g.drawImage(this.backdrop, 0, 0, W, H);

      // Bar lines.
      g.fillStyle = 'rgba(255,255,255,0.06)';
      for (let b = Math.max(0, PTUtil.lowerBound(this.bars, now - 1)); b < this.bars.length; b++) {
        const y = this.yAt(this.bars[b], dNow);
        if (y < 0) break;
        if (y <= hitY) g.fillRect(fx, Math.round(y), fw, 1);
      }

      // Lane light when pressed or just tapped.
      const pressed = new Set();
      for (const p of this.ptrs.values()) if (p.lane >= 0) pressed.add(p.lane);
      for (let l = 0; l < 4; l++) {
        const flash = Math.max(0, 1 - (now - this.laneFlash[l]) / 0.22);
        const a = Math.max(pressed.has(l) ? 0.14 : 0, flash * 0.22);
        if (a > 0.01) {
          g.fillStyle = 'rgba(' + this.accentRgb + ',' + a + ')';
          g.fillRect(fx + l * lw + 1, hitY * (1 - HIT_ZONE), lw - 2, hitY * HIT_ZONE);
          g.fillRect(fx + l * lw + 5, hitY + 10, lw - 10, H - hitY - 22);
        }
      }

      this.drawNotes(now, dNow);

      // Hit line, brighter on the beat.
      g.fillStyle = 'rgba(' + this.accentRgb + ',' + (0.1 + 0.2 * pulse) + ')';
      g.fillRect(fx, hitY - 6, fw, 12);
      g.fillStyle = '#e8f7ff';
      g.fillRect(fx, hitY - 1.5, fw, 3);

      this.drawKeyLabels([0, 1, 2, 3].map(l => fx + (l + 0.5) * lw), hitY + 36);
      this.fx.draw(g);
      this.drawHud(now, H * 0.3, H * 0.2);
    }

    drawNotes(now, dNow) {
      const g = this.g, fx = this.fieldX, lw = this.laneW, hitY = this.hitY, H = this.H;
      const pad = Math.max(4, lw * 0.06);
      const pairs = new Map(); // time -> [x centres] for double connectors
      for (let i = this.drawStart; i < this.notes.length; i++) {
        const n = this.notes[i];
        const yHead = this.yAt(n.t, dNow);
        if (yHead < -4) break;
        const x = fx + n.lane * lw + pad, w = lw - pad * 2;
        let tileH = this.maxTileH;
        if (n.nextSameT !== Infinity) tileH = Math.max(16, Math.min(tileH, yHead - this.yAt(n.nextSameT, dNow) - 5));

        if (n.type === 'hold') {
          if (n.hold === 2) continue;
          const yTail = this.yAt(n.t + n.dur, dNow);
          const holding = n.hold === 1;
          let bottom = holding ? Math.min(hitY, yHead) : yHead;
          const dim = n.hold === 3 || n.state === 2;
          if (bottom > H + 10 && yTail > H) continue;
          const top = Math.min(yTail, bottom - 10);
          g.globalAlpha = dim ? 0.3 : 1;
          // Hold body: the hold colour, see-through, brighter while held.
          const bw = w * 0.62, bx = x + (w - bw) / 2;
          const a0 = g.globalAlpha;
          g.globalAlpha = a0 * (holding ? 0.75 : 0.45);
          g.fillStyle = this.colorOf('hold');
          roundRect(g, bx, top, bw, bottom - top, 10);
          g.fill();
          g.globalAlpha = a0;
          g.fillStyle = holding ? '#ffffff' : 'rgba(255,255,255,0.45)';
          g.fillRect(x + w / 2 - 1.5, top + 6, 3, Math.max(0, bottom - top - 12));
          if (n.state !== 1) this.drawTile(g, x, yHead - tileH, w, tileH, n, now);
          g.globalAlpha = 1;
          continue;
        }
        if (n.state === 1) continue;
        if (yHead - tileH > H) continue;
        this.drawTile(g, x, yHead - tileH, w, tileH, n, now);
        if (n.pair && n.state === 0) {
          const arr = pairs.get(n.t) || [];
          arr.push({ x: x + w / 2, y: yHead });
          pairs.set(n.t, arr);
        }
      }
      // Doubles are joined by a white bar so they read as one gesture.
      g.fillStyle = 'rgba(255,255,255,0.8)';
      for (const arr of pairs.values()) {
        if (arr.length < 2) continue;
        g.fillRect(Math.min(arr[0].x, arr[1].x), arr[0].y - 8, Math.abs(arr[1].x - arr[0].x), 3);
      }
    }

    // A tile is one flat colour for its type, with a white timing edge at the bottom.
    drawTile(g, x, y, w, h, n, now) {
      const missed = n.state === 2;
      const r = Math.min(12, h / 3);
      if (missed) {
        const a0 = g.globalAlpha;
        g.globalAlpha = a0 * Math.max(0.12, 1 - (now - n.missAt) * 2.2);
        g.fillStyle = NOTE_COLORS.miss;
        roundRect(g, x, y, w, h, r);
        g.fill();
        g.globalAlpha = a0;
        return;
      }
      g.fillStyle = this.colorOf(n.type);
      roundRect(g, x, y, w, h, r);
      g.fill();
      g.fillStyle = '#ffffff';
      g.fillRect(x + 5, y + h - 5, w - 10, 3);
      if (n.pair) {
        g.strokeStyle = '#ffffff';
        g.lineWidth = 2.5;
        roundRect(g, x + 1.5, y + 1.5, w - 3, h - 3, r - 1);
        g.stroke();
      }
      if (n.type === 'flick') {
        const sz = Math.min(w, h) * 0.22;
        chevron(g, x + w / 2, y + h * 0.42, sz, '#ffffff');
        chevron(g, x + w / 2, y + h * 0.42 + sz * 0.9, sz * 0.8, 'rgba(255,255,255,0.6)');
      }
    }
  }

  // =====================================================================================
  // Landscape: Arcaea-style 3D track.
  class HorizontalGame extends BaseGame {
    layout() {
      const W = this.W, H = this.H;
      this.cx = W / 2;
      this.y1 = H * 0.87;            // judgment line on the floor
      this.y0 = H * 0.08;            // horizon (vanishing point)
      this.K = 3;                    // perspective strength (lower = flatter, easier to read)
      this.usePopups = true;
      this.floorW = Math.min(W * 0.74, H * 1.55);
      this.skyH = (this.y1 - this.y0) * 0.47;
      this.skyW = this.floorW * 1.08;
      this.skyBound = this.y1 - this.skyH * 0.42; // touches above this are sky / arc touches
      this.hudCx = W / 2;
      // Static sky (colour wash, horizon glow, stars) drawn once per resize.
      const dpr = this.dpr || 1;
      const c = document.createElement('canvas');
      c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
      const g = c.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const th = this.theme;
      if (th && th.image) {
        drawCover(g, th.image, W, H, th.focal);
        g.fillStyle = th.game.veil;
        g.fillRect(0, 0, W, H);
      } else {
        const bg = g.createLinearGradient(0, 0, 0, H);
        bg.addColorStop(0, 'hsl(' + this.hue + ',' + this.satp(55) + '%,5%)');
        bg.addColorStop(0.28, 'hsl(' + (this.hue + 15) + ',' + this.satp(60) + '%,16%)');
        bg.addColorStop(0.36, 'hsl(' + (this.hue + 30) + ',' + this.satp(55) + '%,9%)');
        bg.addColorStop(1, 'hsl(' + (this.hue + 40) + ',' + this.satp(55) + '%,4%)');
        g.fillStyle = bg;
        g.fillRect(0, 0, W, H);
        g.globalCompositeOperation = 'lighter';
        g.globalAlpha = 0.5;
        g.fillStyle = '#e6ecff';
        for (const st of this.stars) g.fillRect(st.x * W, st.y * H * 0.34, st.r, st.r);
        g.globalAlpha = 0.45;
        g.drawImage(glow(hslHex(this.hue + 20, this.satp(90), 60)), this.cx - W * 0.7, this.y0 - H * 0.2, W * 1.4, H * 0.55);
        g.globalAlpha = 0.3;
        g.drawImage(glow('#ff6fb5'), this.cx - W * 0.1, this.y0 - H * 0.08, W * 0.55, H * 0.3);
        g.drawImage(glow('#4de1ff'), this.cx - W * 0.45, this.y0 - H * 0.08, W * 0.55, H * 0.3);
        g.globalAlpha = 1;
        g.globalCompositeOperation = 'source-over';
      }
      const zFar = 1.05, zNear = -0.18;
      const fX = (u, z) => this.cx + (u - 0.5) * this.floorW * this.s(z), fY = (z) => this.floorY(z);
      g.beginPath();
      g.moveTo(fX(0, zFar), fY(zFar));
      g.lineTo(fX(1, zFar), fY(zFar));
      g.lineTo(fX(1, zNear), fY(zNear));
      g.lineTo(fX(0, zNear), fY(zNear));
      g.closePath();
      if (th) {
        g.fillStyle = th.game.field;
      } else {
        const tg = g.createLinearGradient(0, fY(zFar), 0, H);
        tg.addColorStop(0, 'rgba(20,24,48,0.35)');
        tg.addColorStop(1, 'rgba(12,14,30,0.92)');
        g.fillStyle = tg;
      }
      g.fill();
      for (let l = 0; l <= 4; l++) {
        const edge = l === 0 || l === 4;
        g.strokeStyle = edge ? (th ? 'rgba(' + this.accentRgb + ',0.7)' : 'rgba(210,222,255,0.55)') : (th ? th.game.line : 'rgba(170,190,255,0.12)');
        g.lineWidth = edge ? 2 : 1;
        g.beginPath();
        g.moveTo(fX(l / 4, zFar), fY(zFar));
        g.lineTo(fX(l / 4, zNear), fY(zNear));
        g.stroke();
      }
      this.backdrop = c;
    }

    s(z) { return 1 / (1 + this.K * Math.max(z, -0.18)); }
    floorY(z) { return this.y0 + (this.y1 - this.y0) * this.s(z); }
    floorX(u, z) { return this.cx + (u - 0.5) * this.floorW * this.s(z); }
    skyY(z) { return this.floorY(z) - this.skyH * this.s(z); }
    skyX(u, z) { return this.cx + (u - 0.5) * this.skyW * this.s(z); }

    laneAt(x) {
      const u = (x - this.cx) / this.floorW + 0.5;
      if (u < -0.2 || u > 1.2) return -1;
      return Math.max(0, Math.min(3, Math.floor(u * 4)));
    }

    arcX(a, t) {
      const f = Math.max(0, Math.min(a.xs.length - 1, (t - a.t0) / this.chart.arcStep));
      const i = Math.floor(f), k = f - i;
      return i + 1 < a.xs.length ? a.xs[i] * (1 - k) + a.xs[i + 1] * k : a.xs[i];
    }

    notePos(n) {
      if (n.type === 'sky') return { x: this.skyX(n.x, 0), y: this.skyY(0) };
      return { x: this.floorX((n.lane + 0.5) / 4, 0), y: this.y1 };
    }

    // Earliest pending sky note in the timing window that `fits` the input; true if one was taken.
    trySky(t, fits) {
      for (let k = this.skyIdx; k < this.skyQ.length; k++) {
        const n = this.notes[this.skyQ[k]];
        const dt = t - n.t;
        if (dt < -W_GOOD && !this.inZone(n, t)) break;
        if (n.state !== 0 || dt > W_GOOD) continue;
        if (!fits(n)) continue;
        this.hitNote(n, this.judgeOf(dt), t, dt);
        return true;
      }
      return false;
    }
    skyLane(n) { return Math.max(0, Math.min(3, Math.floor(n.x * 4))); }
    arcNear(x, t) {
      const tol = this.skyW * 0.28;
      return this.arcs.some(a => t >= a.t0 - 0.3 && t <= a.t1 && Math.abs(this.skyX(this.arcX(a, Math.max(t, a.t0)), 0) - x) <= tol);
    }

    // Keyboard mode: Space works like reaching up. Space + a lane key hits the sky note above that
    // lane (or the next lane), or holds the arc passing over it. With nothing in the sky there,
    // the key stays a floor tap, so the other hand can keep playing the floor during an arc.
    spaceIsSky() { return this.controls === 'keys'; }
    keySky(id, p, lane, t) {
      p.x = this.skyX((lane + 0.5) / 4, 0);
      p.y = this.skyY(0);
      p.sky = true;
      if (this.trySky(t, n => Math.abs(this.skyLane(n) - lane) <= 1)) { p.lane = -1; return true; }
      // A floor note due in this lane right now wins: that key is the other hand playing the floor.
      const q = this.laneQ[lane], fn = this.laneIdx[lane] < q.length ? this.notes[q[this.laneIdx[lane]]] : null;
      const floorDue = fn && Math.abs(t - fn.t) <= W_GOOD;
      if (!floorDue && this.arcNear(p.x, t)) { p.lane = -1; return true; }
      p.sky = false;
      return false;
    }
    setSpace(on, t) {
      this.spaceHeld = on;
      for (const [id, p] of this.ptrs) {
        if (!p.key) continue;
        if (!on) { p.sky = false; continue; }
        // Lane key pressed a moment before Space: treat the pair as one sky press.
        const kx = this.skyX((p.keyLane + 0.5) / 4, 0);
        if (!p.hitFloor && t - p.at < 0.12) this.keySky(id, p, p.keyLane, p.at);
        else if (this.arcNear(kx, t)) { p.x = kx; p.y = this.skyY(0); p.sky = true; }
      }
    }

    handleDown(id, p, t) {
      // Mouse + keys mode: the mouse is the sky hand, so a click anywhere hits the sky note
      // nearest the cursor (or starts tracing an arc).
      if (p.mouse && this.controls === 'mouse') {
        const tol = this.skyW * 0.2;
        this.trySky(t, n => Math.abs(p.x - this.skyX(n.x, 0)) <= tol);
        return;
      }
      if (p.y < this.skyBound) {
        // Sky tap: nearest pending sky note in time and position. Otherwise it is an arc touch.
        const tol = this.skyW * 0.16;
        this.trySky(t, n => Math.abs(p.x - this.skyX(n.x, 0)) <= tol);
        return;
      }
      const lane = this.laneAt(p.x);
      if (lane >= 0) this.pressLane(id, lane, t, false);
    }
    slideLane(p) { return p.y >= this.skyBound && !(p.mouse && this.controls === 'mouse') ? this.laneAt(p.x) : -1; }

    updateMode(now) {
      while (this.skyIdx < this.skyQ.length) {
        const n = this.notes[this.skyQ[this.skyIdx]];
        if (n.state !== 0) { this.skyIdx++; continue; }
        if (n.t >= now - W_GOOD) break;
        this.missNote(n, now);
        this.skyIdx++;
      }
      // Arcs: any finger near the arc's point on the judgment plane keeps it alive.
      const tol = Math.max(60 * this.unit, this.skyW * 0.14);
      for (const a of this.arcs) {
        if (a.t0 - 0.4 > now) break;
        if (a.tickIdx >= a.ticks.length) continue;
        const sx = this.skyX(this.arcX(a, Math.max(now, a.t0)), 0);
        let on = false;
        const keyTol = this.skyW * 0.28; // a held Space + lane key covers its lane and a bit more
        for (const p of this.ptrs.values()) {
          if (p.key ? p.sky && Math.abs(p.x - sx) <= keyTol : Math.abs(p.x - sx) <= tol) { on = true; break; }
        }
        a.tracked = on;
        if (on) a.lastOnAt = now;
        while (a.tickIdx < a.ticks.length && a.ticks[a.tickIdx] + 0.08 <= now) {
          const tt = a.ticks[a.tickIdx++];
          if (a.lastOnAt >= tt - ARC_GRACE) {
            this.judgeUnit('perfect', null, now);
            this.stats.arcTicksHit++;
            this.fx.burst(sx, this.skyY(0), ARC_COLORS[a.color], 5, 300 * this.unit, 8 * this.unit);
          } else {
            this.judgeUnit('miss', null, now);
            a.missFlash = now;
          }
        }
        if (on && Math.random() < 0.35) this.fx.spark(sx, this.skyY(0), ARC_COLORS[a.color], 7 * this.unit, 18 * this.unit);
      }
    }

    draw(now) {
      const g = this.g, W = this.W, H = this.H;
      const dNow = this.S.at(now);
      const pulse = this.beatPulse(now);
      const energy = this.energyAt(now);

      // Sky and horizon (cached), plus a light beat pulse on the horizon.
      g.drawImage(this.backdrop, 0, 0, W, H);
      if (pulse > 0.05) {
        g.fillStyle = 'rgba(160,200,255,' + (0.08 * pulse) + ')';
        g.fillRect(0, this.y0, W, H * 0.12);
      }
      void energy;

      this.drawFloor(now, dNow, pulse);
      this.drawFloorNotes(now, dNow);
      this.drawArcs(now, dNow);
      this.drawSkyNotes(now, dNow);

      // Sky plane marker: where arcs and sky notes are hit.
      const sy = this.skyY(0);
      g.strokeStyle = 'rgba(210,225,255,' + (0.08 + 0.08 * pulse) + ')';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(this.skyX(0, 0), sy);
      g.lineTo(this.skyX(1, 0), sy);
      g.stroke();

      this.fx.draw(g);
      this.drawHud(now, H * 0.075, null, 0.5);
      this.drawPopups();
    }

    drawFloor(now, dNow, pulse) {
      const g = this.g, H = this.H;
      const zFar = 1.05;
      void H;
      // Track surface and lane lines come from the cached backdrop.
      // Bar lines flowing toward the player.
      for (let b = Math.max(0, PTUtil.lowerBound(this.bars, now - 0.5)); b < this.bars.length; b++) {
        const z = this.S.at(this.bars[b]) - dNow;
        if (z > zFar) break;
        if (z < 0) continue;
        g.strokeStyle = 'rgba(200,215,255,' + (0.12 * (1 - z)) + ')';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(this.floorX(0, z), this.floorY(z));
        g.lineTo(this.floorX(1, z), this.floorY(z));
        g.stroke();
      }
      // Hit zone band on the floor.
      if (!this.zoneFill || this.zoneFillY !== this.y1) {
        const zg = g.createLinearGradient(0, this.floorY(HIT_ZONE), 0, this.y1);
        zg.addColorStop(0, 'rgba(' + this.accentRgb + ',0)');
        zg.addColorStop(1, 'rgba(' + this.accentRgb + ',0.14)');
        this.zoneFill = zg; this.zoneFillY = this.y1;
      }
      this.quad(0, 1, 0, HIT_ZONE);
      g.fillStyle = this.zoneFill;
      g.fill();
      // Pressed lanes light up.
      const pressed = new Set();
      for (const p of this.ptrs.values()) if (p.lane >= 0) pressed.add(p.lane);
      for (let l = 0; l < 4; l++) {
        const flash = Math.max(0, 1 - (now - this.laneFlash[l]) / 0.22);
        const a = Math.max(pressed.has(l) ? 0.25 : 0, flash * 0.4);
        if (a < 0.01) continue;
        const z1 = HIT_ZONE;
        g.beginPath();
        g.moveTo(this.floorX(l / 4, 0), this.y1);
        g.lineTo(this.floorX((l + 1) / 4, 0), this.y1);
        g.lineTo(this.floorX((l + 1) / 4, z1), this.floorY(z1));
        g.lineTo(this.floorX(l / 4, z1), this.floorY(z1));
        g.closePath();
        g.fillStyle = 'rgba(' + this.accentRgb + ',' + (a * 0.6) + ')';
        g.fill();
      }
      // Judgment line.
      const x0 = this.floorX(0, 0), x1 = this.floorX(1, 0);
      g.fillStyle = 'rgba(' + this.accentRgb + ',' + (0.12 + 0.2 * pulse) + ')';
      g.fillRect(x0, this.y1 - 7, x1 - x0, 14);
      g.fillStyle = '#e8f7ff';
      g.fillRect(x0, this.y1 - 2, x1 - x0, 4);
      this.drawKeyLabels([0, 1, 2, 3].map(l => this.floorX((l + 0.5) / 4, 0)), Math.min(this.H - 12, this.y1 + 22));
    }

    // Floor slab between depths z and z + dz across lane-relative u range.
    quad(uL, uR, zA, zB) {
      const g = this.g;
      g.beginPath();
      g.moveTo(this.floorX(uL, zA), this.floorY(zA));
      g.lineTo(this.floorX(uR, zA), this.floorY(zA));
      g.lineTo(this.floorX(uR, zB), this.floorY(zB));
      g.lineTo(this.floorX(uL, zB), this.floorY(zB));
      g.closePath();
    }

    drawFloorNotes(now, dNow) {
      const g = this.g;
      const vis = [];
      for (let i = this.drawStart; i < this.notes.length; i++) {
        const n = this.notes[i];
        const z = this.S.at(n.t) - dNow;
        if (z > 1.05) break;
        if (n.type === 'sky') continue;
        if (n.state === 1 && n.type !== 'hold') continue;
        if (n.type === 'hold' && n.hold === 2) continue;
        if (z < -0.2 && n.type !== 'hold') continue;
        vis.push({ n, z });
      }
      for (let k = vis.length - 1; k >= 0; k--) {
        const { n, z } = vis[k];
        const uL = n.lane / 4 + 0.015, uR = (n.lane + 1) / 4 - 0.015;
        const fade = Math.min(1, (1.05 - z) / 0.2);
        const missed = n.state === 2;
        if (n.type === 'hold') {
          const holding = n.hold === 1;
          const zHead = holding ? Math.max(0, z) : z;
          const zTail = Math.min(1.05, this.S.at(n.t + n.dur) - dNow);
          if (zTail < -0.2) continue;
          g.globalAlpha = fade * (n.hold === 3 || missed ? 0.3 : 1);
          const inset = (uR - uL) * 0.18;
          this.quad(uL + inset, uR - inset, Math.max(-0.18, zHead), zTail);
          const a0 = g.globalAlpha;
          g.globalAlpha = a0 * (holding ? 0.75 : 0.45);
          g.fillStyle = this.colorOf('hold');
          g.fill();
          g.globalAlpha = a0;
          if (n.state !== 1) this.drawSlab(n, z, uL, uR, missed, now);
          g.globalAlpha = 1;
          continue;
        }
        g.globalAlpha = fade;
        this.drawSlab(n, z, uL, uR, missed, now);
        g.globalAlpha = 1;
      }
    }

    // A floor note: one flat colour for its type, with a white timing edge.
    drawSlab(n, z, uL, uR, missed, now) {
      const g = this.g;
      const dz = 0.05;
      const s = this.s(z);
      this.quad(uL, uR, z, z + dz);
      const top = this.floorY(z + dz), bot = this.floorY(z);
      if (missed) {
        const a0 = g.globalAlpha;
        g.globalAlpha = a0 * Math.max(0.12, 1 - (now - n.missAt) * 2.2);
        g.fillStyle = NOTE_COLORS.miss;
        g.fill();
        g.globalAlpha = a0;
        return;
      }
      g.fillStyle = this.colorOf(n.type);
      g.fill();
      if (n.pair) {
        g.strokeStyle = '#ffffff';
        g.lineWidth = Math.max(1, 2 * s);
        g.stroke();
      }
      g.fillStyle = '#ffffff';
      g.fillRect(this.floorX(uL, z) + 2, bot - Math.max(1.5, 3 * s), this.floorX(uR, z) - this.floorX(uL, z) - 4, Math.max(1.5, 3 * s));
      if (n.type === 'flick') {
        const cx = this.floorX((uL + uR) / 2, z);
        const size = (uR - uL) * this.floorW * s * 0.2;
        chevron(g, cx, top - size * 1.1, size, '#ffffff');
      }
    }

    drawArcs(now, dNow) {
      const g = this.g, u = this.unit;
      const step = this.chart.arcStep;
      for (const a of this.arcs) {
        if (a.t1 < now - 0.05) continue;
        const zStart = this.S.at(a.t0) - dNow;
        if (zStart > 1.05) break;
        const color = ARC_COLORS[a.color];
        const ts = Math.max(now, a.t0);
        // Sample the visible stretch of the arc.
        const times = [ts];
        for (let k = Math.ceil((ts - a.t0) / step + 1e-6); ; k++) {
          const tt = a.t0 + k * step;
          if (tt >= a.t1) { times.push(a.t1); break; }
          times.push(tt);
          if (this.S.at(tt) - dNow > 1.05) break;
        }
        const pts = [];
        for (const tt of times) {
          const z = this.S.at(tt) - dNow;
          if (z > 1.05) break;
          const x = this.arcX(a, tt);
          pts.push({ x: this.skyX(x, z), y: this.skyY(z), fx: this.floorX(0.5 + (x - 0.5) * this.skyW / this.floorW, z), fy: this.floorY(z), w: Math.max(5 * u, 30 * u * this.s(z)), z });
        }
        if (pts.length < 2) continue;
        // Ribbon.
        const left = [], right = [];
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i], q = pts[Math.min(pts.length - 1, i + 1)], o = pts[Math.max(0, i - 1)];
          let dx = q.x - o.x, dy = q.y - o.y;
          const len = Math.hypot(dx, dy) || 1;
          dx /= len; dy /= len;
          left.push([p.x - dy * p.w / 2, p.y + dx * p.w / 2]);
          right.push([p.x + dy * p.w / 2, p.y - dx * p.w / 2]);
        }
        const active = now >= a.t0 - 0.3 && now <= a.t1;
        const missed = now - a.missFlash < 0.25;
        g.beginPath();
        left.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
        for (let i = right.length - 1; i >= 0; i--) g.lineTo(right[i][0], right[i][1]);
        g.closePath();
        g.fillStyle = rgba(missed ? NOTE_COLORS.miss : color, a.tracked ? 0.8 : 0.55);
        g.fill();
        g.strokeStyle = 'rgba(255,255,255,' + (a.tracked ? 0.9 : 0.55) + ')';
        g.lineWidth = 1.5;
        g.beginPath();
        pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
        g.stroke();
        // Target at the judgment plane: where the finger goes.
        if (active) {
          const p = pts[0];
          const r = (a.tracked ? 24 : 18) * u;
          g.globalCompositeOperation = 'lighter';
          g.globalAlpha = a.tracked ? 1 : 0.75;
          g.drawImage(glow(color), p.x - r * 2, p.y - r * 2, r * 4, r * 4);
          g.globalAlpha = 1;
          g.globalCompositeOperation = 'source-over';
          g.strokeStyle = '#ffffff';
          g.lineWidth = 2.5;
          g.beginPath();
          g.arc(p.x, p.y, r * 0.55, 0, Math.PI * 2);
          g.stroke();
        }
      }
    }

    drawSkyNotes(now, dNow) {
      const g = this.g;
      const list = [];
      for (let k = this.skyIdx; k < this.skyQ.length; k++) {
        const n = this.notes[this.skyQ[k]];
        const z = this.S.at(n.t) - dNow;
        if (z > 1.05) break;
        if (n.state === 1 || z < -0.15) continue;
        list.push({ n, z });
      }
      for (let k = list.length - 1; k >= 0; k--) {
        const { n, z } = list[k];
        const s = this.s(z);
        const x = this.skyX(n.x, z), y = this.skyY(z);
        const w = this.skyW * 0.11 * s, h = Math.max(4, 16 * this.unit * s);
        const missed = n.state === 2;
        const fade = Math.min(1, (1.05 - z) / 0.2);
        g.globalAlpha = fade * (missed ? Math.max(0.1, 1 - (now - n.missAt) * 2.2) : 1);
        // Shadow on the floor for depth.
        const fxp = this.floorX(0.5 + (n.x - 0.5) * this.skyW / this.floorW, z);
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.beginPath();
        g.ellipse(fxp, this.floorY(z), w * 0.5, Math.max(1.5, h * 0.3), 0, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = missed ? NOTE_COLORS.miss : NOTE_COLORS.sky;
        roundRect(g, x - w / 2, y - h / 2, w, h, h / 2);
        g.fill();
        g.globalAlpha = 1;
      }
    }
  }

  function hslHex(h, s, l) {
    h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
    return '#' + [f(0), f(8), f(4)].map(v => v.toString(16).padStart(2, '0')).join('');
  }

  global.PTGame = { VerticalGame, HorizontalGame, JUDGE };
})(typeof self !== 'undefined' ? self : this);

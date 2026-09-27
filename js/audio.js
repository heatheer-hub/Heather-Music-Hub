/*
 * Audio playback + the song clock.
 *
 * The clock answers "what song time is reaching the speakers right now?". It is derived from
 * AudioContext.getOutputTimestamp() (falls back to currentTime - outputLatency), then locked to
 * performance.now() with a slow correction loop so frame-to-frame motion stays smooth while never
 * drifting from the audio. Input events are converted with their own timestamps, so judgments
 * do not depend on the frame rate.
 */
(function (global) {
  'use strict';

  let ctx = null;

  function getContext() {
    if (!ctx) {
      const AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) throw new Error('Web Audio is not supported in this browser.');
      ctx = new AC({ latencyHint: 'interactive' });
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* optional */ }
    }
    return ctx;
  }

  function decode(arrayBuffer) {
    const c = getContext();
    return new Promise((resolve, reject) => {
      const p = c.decodeAudioData(arrayBuffer, resolve, (err) => reject(err || new Error('Could not decode this audio file.')));
      if (p && p.then) p.then(resolve, reject);
    });
  }

  function toMono(buffer) {
    const n = buffer.length, ch = buffer.numberOfChannels;
    const out = new Float32Array(n);
    for (let c = 0; c < ch; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < n; i++) out[i] += d[i];
    }
    if (ch > 1) for (let i = 0; i < n; i++) out[i] /= ch;
    return out;
  }

  class SongPlayer {
    constructor(buffer) {
      this.ctx = getContext();
      this.buffer = buffer;
      this.src = null;
      this.gain = null;
      this.anchorCtx = 0;   // context time at which song time == anchorSong
      this.anchorSong = 0;
      this.playing = false;
      this.offsetEst = null; // songTime - perfNow/1000
      this.userOffset = 0;   // seconds; positive = audio is heard later than reported
    }

    // Raw audio-derived song time at a performance.now() timestamp (ms).
    rawSongTimeAt(perfMs) {
      const c = this.ctx;
      let heardCtx;
      const ts = c.getOutputTimestamp ? c.getOutputTimestamp() : null;
      if (ts && ts.contextTime > 0 && ts.performanceTime > 0) {
        heardCtx = ts.contextTime + (perfMs - ts.performanceTime) / 1000;
      } else {
        const lat = (c.outputLatency || 0) + (c.baseLatency || 0);
        heardCtx = c.currentTime - lat + (perfMs - performance.now()) / 1000;
      }
      return this.anchorSong + (heardCtx - this.anchorCtx);
    }

    async resumeContext() {
      if (this.ctx.state !== 'running') {
        try { await this.ctx.resume(); } catch (e) { /* ignore */ }
      }
    }

    // Start playback so that song time `from` is heard shortly; negative `from` gives a lead-in.
    play(from) {
      this.stopSource();
      const c = this.ctx;
      const when = c.currentTime + 0.06;
      this.gain = c.createGain();
      this.gain.connect(c.destination);
      const src = c.createBufferSource();
      src.buffer = this.buffer;
      src.connect(this.gain);
      if (from >= 0) src.start(when, Math.min(from, this.buffer.duration));
      else src.start(when - from, 0);
      this.src = src;
      this.anchorCtx = when;
      this.anchorSong = from;
      this.playing = true;
      this.offsetEst = null;
    }

    // Smoothed song time "now" (call once per frame).
    now() {
      const perf = performance.now();
      if (!this.playing) return this.pausedAt != null ? this.pausedAt : 0;
      const raw = this.rawSongTimeAt(perf);
      const pred = perf / 1000 + (this.offsetEst == null ? 0 : this.offsetEst);
      const err = raw - pred;
      if (this.offsetEst == null || Math.abs(err) > 0.05) this.offsetEst = raw - perf / 1000;
      else this.offsetEst += err * 0.08;
      return perf / 1000 + this.offsetEst - this.userOffset;
    }

    // Song time corresponding to an input event timestamp.
    timeAtEvent(ev) {
      let ts = ev && ev.timeStamp;
      const perf = performance.now();
      if (!(ts > 0) || ts > perf + 1000 || ts < perf - 2000) ts = perf;
      if (this.offsetEst == null) return this.rawSongTimeAt(ts) - this.userOffset;
      return ts / 1000 + this.offsetEst - this.userOffset;
    }

    pause() {
      const t = this.now();
      this.stopSource();
      this.playing = false;
      this.pausedAt = t;
      return t;
    }

    fadeOut(sec) {
      if (!this.gain) return;
      const c = this.ctx;
      try {
        this.gain.gain.setValueAtTime(this.gain.gain.value, c.currentTime);
        this.gain.gain.linearRampToValueAtTime(0, c.currentTime + sec);
      } catch (e) { /* ignore */ }
      const src = this.src;
      setTimeout(() => { if (this.src === src) this.stopSource(); }, sec * 1000 + 50);
    }

    stopSource() {
      if (this.src) {
        try { this.src.stop(); } catch (e) { /* already stopped */ }
        try { this.src.disconnect(); } catch (e) { /* ignore */ }
        this.src = null;
      }
      if (this.gain) {
        try { this.gain.disconnect(); } catch (e) { /* ignore */ }
        this.gain = null;
      }
    }

    stop() {
      this.stopSource();
      this.playing = false;
      this.pausedAt = null;
    }
  }

  // A short generated song so the full pipeline can be tried without an MP3 at hand.
  function makeDemoBuffer() {
    const c = getContext();
    const sr = c.sampleRate;
    const bpm = 116, beat = 60 / bpm;
    const bars = 36;
    const dur = 1.0 + bars * 4 * beat + 2;
    const n = Math.floor(dur * sr);
    const L = new Float32Array(n), R = new Float32Array(n);
    let seed = 7;
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296) * 2 - 1;
    const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
    const add = (t0, len, fn, pan) => {
      const s0 = Math.floor(t0 * sr), s1 = Math.min(n, s0 + Math.floor(len * sr));
      const gl = pan == null ? 1 : Math.min(1, 1 - pan), gr = pan == null ? 1 : Math.min(1, 1 + pan);
      for (let i = s0; i < s1; i++) { const v = fn((i - s0) / sr); L[i] += v * gl; R[i] += v * gr; }
    };
    const prog = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]; // Am F C G
    const melA = [76, 74, 72, 74, 76, 76, 76, -1, 74, 74, 74, -1, 76, 79, 79, -1];
    const melB = [72, 74, 76, 79, 81, 79, 76, 74, 72, 71, 72, 74, 76, -1, 72, -1];
    const start = 1.0;
    for (let bar = 0; bar < bars; bar++) {
      const t = start + bar * 4 * beat;
      const sec = bar < 4 ? 0 : bar < 12 ? 1 : bar < 20 ? 2 : bar < 28 ? 1 : 2; // intro, verse, chorus...
      const chord = prog[bar % 4];
      const vol = sec === 2 ? 1 : sec === 1 ? 0.75 : 0.5;
      // pad
      add(t, 4 * beat, (x) => {
        let v = 0;
        for (const m of chord) v += Math.sin(2 * Math.PI * mtof(m) * x) * 0.05;
        return v * Math.min(1, x * 8) * Math.min(1, (4 * beat - x) * 8) * vol;
      });
      for (let b = 0; b < 4; b++) {
        const tb = t + b * beat;
        if (sec > 0 || b === 0) {
          add(tb, 0.25, (x) => 0.7 * vol * Math.sin(2 * Math.PI * (45 + 90 * Math.exp(-x * 35)) * x) * Math.exp(-x * 14));
        }
        if (sec > 0 && (b === 1 || b === 3)) add(tb, 0.18, (x) => 0.28 * vol * rnd() * Math.exp(-x * 22), 0.1);
        if (sec > 0) {
          for (let h = 0; h < (sec === 2 ? 4 : 2); h++) {
            const th = tb + h * beat / (sec === 2 ? 4 : 2);
            add(th, 0.05, (x) => 0.06 * rnd() * Math.exp(-x * 90), -0.3);
          }
        }
        // bass
        const bm = chord[0] - 24;
        add(tb, beat * 0.9, (x) => 0.22 * vol * Math.sin(2 * Math.PI * mtof(bm) * x) * Math.min(1, x * 60) * Math.exp(-x * 2.5));
      }
      if (sec > 0) {
        const mel = sec === 2 ? melB : melA;
        for (let k = 0; k < 8; k++) {
          const m = mel[(bar % 2) * 8 + k];
          if (m < 0) continue;
          const tn = t + k * beat / 2;
          const f = mtof(m);
          add(tn, beat * 0.5, (x) => {
            const env = Math.min(1, x * 150) * Math.exp(-x * 5);
            return 0.16 * env * (Math.sin(2 * Math.PI * f * x) + 0.4 * Math.sin(4 * Math.PI * f * x) + 0.15 * Math.sin(6 * Math.PI * f * x));
          }, 0.15);
        }
      }
    }
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    const g = peak > 0 ? 0.9 / peak : 1;
    const buf = c.createBuffer(2, n, sr);
    const dl = buf.getChannelData(0), dr = buf.getChannelData(1);
    for (let i = 0; i < n; i++) { dl[i] = L[i] * g; dr[i] = R[i] * g; }
    return buf;
  }

  global.PTAudio = { getContext, decode, toMono, SongPlayer, makeDemoBuffer };
})(typeof self !== 'undefined' ? self : this);

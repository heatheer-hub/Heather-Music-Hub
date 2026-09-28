/*
 * Chart generation: analysis + difficulty (+ variation) -> deterministic chart.
 *
 * Two play modes share one pipeline:
 *   vertical   - 4 falling lanes (Piano Tiles / SuperStar): tap, hold, flick, doubles.
 *   horizontal - 3D track (Arcaea-style): floor tap/hold/flick on 4 lanes, arcs traced in the air
 *                whose sideways path follows the melody, and sky notes on snare/clap hits.
 *
 * 1. Build a 16th-note grid from the tracked beats; snap detected onsets onto it.
 * 2. Per section, pick the most salient grid points up to a density budget scaled by energy,
 *    never closer than the difficulty's minimum gap.
 * 3. (horizontal) Pick melodic phrases for arcs.
 * 4. Sustained notes and phrase endings become holds; other lanes keep playing meanwhile.
 * 5. Lanes follow the melody contour; fix jacks, keep off a held lane / the arc hand's side.
 * 6. Accents become flicks (and sky notes on the horizontal track); doubles on strong beats.
 */
(function (global) {
  'use strict';

  const LANES = 4;
  const ARC_STEP = 0.05; // seconds between stored arc points

  const DIFFICULTIES = {
    vnormal: {
      name: 'Normal', mode: 'vertical', index: 0, maxLevel: 2, notesPerBeat: 1.3, maxNps: 4.6,
      minGap: 0.19, jack: 0.3, chordRate: 0.05, holdRate: 0.85, holdMinBeats: 1, holdDuringLevel: 1, holdShare: 0.13,
      flickRate: 0.06, travel: 1.4, ramp: 0.18, fillBeats: 2, minSal: 0.22,
      blurb: 'Melody taps, long holds, flicks on the big hits.'
    },
    vhard: {
      name: 'Hard', mode: 'vertical', index: 1, maxLevel: 3, notesPerBeat: 2.2, maxNps: 7.5,
      minGap: 0.115, jack: 0.19, chordRate: 0.11, holdRate: 0.75, holdMinBeats: 1, holdDuringLevel: 3, holdShare: 0.1,
      flickRate: 0.08, travel: 1.05, ramp: 0.25, fillBeats: 1.5, minSal: 0.15,
      blurb: '16th-note runs, doubles, taps while you hold.'
    },
    hnormal: {
      name: 'Normal', mode: 'horizontal', index: 2, maxLevel: 2, notesPerBeat: 1.15, maxNps: 4.2,
      minGap: 0.2, jack: 0.32, chordRate: 0.03, holdRate: 0.7, holdMinBeats: 1, holdDuringLevel: 1, holdShare: 0.1,
      flickRate: 0.05, skyRate: 0.13, arcCover: 0.3, arcMinBeats: 2, arcMaxBeats: 4, arcSlew: 1.0,
      travel: 1.7, ramp: 0.15, fillBeats: 2, minSal: 0.22,
      blurb: 'Trace melody arcs with one hand, tap the floor with the other.'
    },
    hhard: {
      name: 'Hard', mode: 'horizontal', index: 3, maxLevel: 3, notesPerBeat: 1.95, maxNps: 6.8,
      minGap: 0.125, jack: 0.2, chordRate: 0.08, holdRate: 0.6, holdMinBeats: 1, holdDuringLevel: 3, holdShare: 0.07,
      flickRate: 0.07, skyRate: 0.2, arcCover: 0.45, arcMinBeats: 2, arcMaxBeats: 8, arcSlew: 1.5,
      travel: 1.3, ramp: 0.22, fillBeats: 1.5, minSal: 0.15,
      blurb: 'Long winding arcs, sky taps, busy floor.'
    }
  };

  const LEVEL_BONUS = [0.5, 0.32, 0.12, 0];

  function generate(A, diffKey, opts) {
    const D = DIFFICULTIES[diffKey];
    const horizontal = D.mode === 'horizontal';
    const variation = Math.max(1, (opts && opts.variation) | 0 || 1);
    const seed = ((opts && opts.seed) >>> 0) ^ Math.imul(D.index + 1, 0x9e3779b9) ^ Math.imul(variation, 0x85ebca6b);
    const rng = PTUtil.makeRng(seed);

    const n = A.nFrames;
    const frameAt = (t) => Math.max(0, Math.min(n - 1, Math.round((t - A.frameOffset) / A.hopTime)));
    const peakOf = (arr, t, r) => {
      const c = frameAt(t);
      let m = 0;
      for (let k = Math.max(0, c - r); k <= Math.min(n - 1, c + r); k++) if (arr[k] > m) m = arr[k];
      return m;
    };
    const rmsMean = (t0, t1) => {
      const f0 = frameAt(t0), f1 = Math.max(f0 + 1, frameAt(t1));
      let s = 0;
      for (let k = f0; k < f1; k++) s += A.rms[k];
      return s / (f1 - f0);
    };
    const audible = (t) => rmsMean(t, t + 0.1) > A.silenceThr * 1.5;
    const energyAt = (t) => {
      for (const s of A.sections) if (t >= s.start && t < s.end) return s.energy;
      return 0.5;
    };

    // ---- 1. grid + onsets ----
    const beats = A.beats;
    const beatLen = 60 / A.bpm;
    const grid = [];
    for (let i = 0; i < beats.length; i++) {
      const isDown = ((i - A.downbeatPhase) % 4 + 4) % 4 === 0;
      grid.push({ t: beats[i], level: isDown ? 0 : 1, beat: i });
      if (i + 1 < beats.length) {
        const d = beats[i + 1] - beats[i];
        grid.push({ t: beats[i] + d * 0.25, level: 3, beat: i });
        grid.push({ t: beats[i] + d * 0.5, level: 2, beat: i });
        grid.push({ t: beats[i] + d * 0.75, level: 3, beat: i });
      }
    }
    const allowed = grid.filter(g => g.level <= D.maxLevel);
    const gTimes = allowed.map(g => g.t);
    const spacing = beatLen / (D.maxLevel >= 3 ? 4 : 2);
    const tol = Math.min(0.06, spacing * 0.42);
    const onsetAt = new Float32Array(allowed.length);
    for (const o of A.onsets) {
      const i = PTUtil.lowerBound(gTimes, o.t);
      let best = -1, bd = Infinity;
      for (const j of [i - 1, i]) {
        if (j >= 0 && j < gTimes.length && Math.abs(gTimes[j] - o.t) < bd) { bd = Math.abs(gTimes[j] - o.t); best = j; }
      }
      if (best >= 0 && bd <= tol) onsetAt[best] = Math.max(onsetAt[best], o.s);
    }
    const cands = [];
    allowed.forEach((g, i) => {
      if (g.t < 0.05 || g.t > A.duration - 0.05 || !audible(g.t)) return;
      const onsetS = onsetAt[i];
      if (g.level >= 2 && onsetS <= 0) return; // off-beats need a real attack
      let sal = Math.max(onsetS, 0.6 * peakOf(A.onset, g.t, 2)) + LEVEL_BONUS[g.level];
      if (variation > 1) sal += rng() * 0.08;
      if (sal < D.minSal) return;
      cands.push({ t: g.t, level: g.level, sal, beat: g.beat });
    });

    // ---- 2. density-budgeted selection per section ----
    const picked = [];
    const pickedObj = [];
    const fits = (t) => {
      const i = PTUtil.lowerBound(picked, t);
      if (i < picked.length && picked[i] - t < D.minGap) return false;
      if (i > 0 && t - picked[i - 1] < D.minGap) return false;
      return true;
    };
    const add = (c) => {
      const i = PTUtil.lowerBound(picked, c.t);
      picked.splice(i, 0, c.t);
      pickedObj.splice(i, 0, c);
    };
    const removeWhere = (pred) => {
      for (let i = picked.length - 1; i >= 0; i--) {
        if (pred(pickedObj[i])) { pickedObj[i].removed = true; picked.splice(i, 1); pickedObj.splice(i, 1); }
      }
    };
    const bySal = (a, b) => b.sal - a.sal || a.t - b.t;
    for (const s of A.sections) {
      const inSec = cands.filter(c => c.t >= s.start && c.t < s.end).sort(bySal);
      if (!inSec.length) continue;
      const beatsIn = (s.end - s.start) / beatLen;
      const budget = Math.min(D.notesPerBeat * beatsIn * (0.65 + 0.6 * s.energy), D.maxNps * (s.end - s.start));
      let count = 0;
      for (const c of inSec) {
        if (count >= budget) break;
        if (fits(c.t)) { add(c); count++; }
      }
    }

    // ---- melody helpers ----
    const pitchAt = (t, span, minConf) => {
      const f0 = frameAt(t), f1 = frameAt(t + span);
      const vals = [];
      for (let k = f0; k <= f1; k++) if (A.pitchConf[k] > (minConf || 2.2) && A.pitch[k] > 0) vals.push(A.pitch[k]);
      if (vals.length < 2) return -1;
      vals.sort((a, b) => a - b);
      return vals[vals.length >> 1];
    };
    const sustainFrom = (t) => {
      const p0 = pitchAt(t + 0.01, 0.1);
      if (p0 < 0) return 0;
      const r0 = rmsMean(t, t + 0.1);
      const fStart = frameAt(t);
      const fEnd = frameAt(Math.min(A.duration, t + 8));
      let lastGood = fStart, miss = 0;
      for (let f = frameAt(t + 0.03); f < fEnd; f++) {
        const ok = A.pitchConf[f] > 1.8 && Math.abs(A.pitch[f] - p0) <= 1 && A.rms[f] > r0 * 0.35;
        if (ok) { lastGood = f; miss = 0; } else if (++miss > 6) break;
      }
      return (lastGood - fStart) * A.hopTime;
    };
    const snapDown = (t) => {
      const j = PTUtil.lowerBound(beats, t) - 1;
      if (j < 0 || j + 1 >= beats.length) return t;
      const half = (beats[j] + beats[j + 1]) / 2;
      return t >= half ? half : beats[j];
    };

    // ---- 3. arcs (horizontal) ----
    const arcs = horizontal ? buildArcs() : [];
    const arcAt = (t, pad) => arcs.find(a => t >= a.t0 - (pad || 0) && t <= a.t1 + (pad || 0)) || null;
    if (arcs.length) {
      // The arc hand is busy: lighten the floor under arcs.
      removeWhere(c => c.level > D.holdDuringLevel && arcAt(c.t, 0.05));
    }

    function buildArcs() {
      const scores = [];
      for (let i = 0; i + 1 < beats.length; i++) {
        const f0 = frameAt(beats[i]), f1 = Math.max(f0 + 1, frameAt(beats[i + 1]));
        let good = 0;
        for (let f = f0; f < f1; f++) if (A.pitchConf[f] > 2.0 && A.rms[f] > A.silenceThr * 2) good++;
        scores.push(good / (f1 - f0));
      }
      const chunks = [];
      let i = 0;
      while (i < scores.length) {
        if (scores[i] < 0.55) { i++; continue; }
        let j = i;
        while (j < scores.length && scores[j] >= 0.55) j++;
        // Split the melodic run into arcs with a one-beat breath between them.
        for (let k = i; k + D.arcMinBeats <= j; ) {
          const len = Math.min(D.arcMaxBeats, j - k);
          if (len < D.arcMinBeats) break;
          let m = 0;
          for (let q = k; q < k + len; q++) m += scores[q];
          const t0 = beats[k], t1 = beats[k + len];
          chunks.push({ t0, t1, value: (m / len) * (0.5 + energyAt(t0)) + len * 0.02 });
          k += len + 1;
        }
        i = j;
      }
      chunks.sort((a, b) => b.value - a.value || a.t0 - b.t0);
      const target = D.arcCover * Math.max(1, A.soundEnd - A.soundStart);
      const chosen = [];
      let covered = 0;
      for (const c of chunks) {
        if (covered >= target) break;
        if (chosen.some(o => c.t0 < o.t1 + beatLen * 0.5 && c.t1 > o.t0 - beatLen * 0.5)) continue;
        chosen.push(c);
        covered += c.t1 - c.t0;
      }
      chosen.sort((a, b) => a.t0 - b.t0);
      return chosen.map((c, idx) => shapeArc(c.t0, c.t1, idx));
    }

    // Sideways path follows the melody, Arcaea-style: one keyframe per beat at a clean position
    // (low pitch = left), eased curves between keyframes, small wobbles ignored.
    function shapeArc(t0, t1, idx) {
      const k0 = PTUtil.lowerBound(beats, t0 - 1e-6), k1 = PTUtil.lowerBound(beats, t1 - 1e-6);
      const keyT = [];
      for (let k = k0; k <= k1 && k < beats.length; k++) keyT.push(beats[k]);
      if (keyT.length < 2) keyT.splice(0, keyT.length, t0, t1);
      const pit = keyT.map(t => pitchAt(t, beatLen * 0.9, 1.8));
      const known = pit.filter(p => p > 0);
      const fallback = known.length ? known[0] : 60;
      for (let i = 0; i < pit.length; i++) if (pit[i] <= 0) pit[i] = i > 0 ? pit[i - 1] : fallback;
      const pmin = Math.min(...pit), pmax = Math.max(...pit);
      const mid = (pmin + pmax) / 2, span = Math.max(pmax - pmin, 7);
      // Alternate the starting side between arcs so both hands get a turn.
      const bias = (idx % 2 === 0 ? -0.15 : 0.15) * (variation % 2 === 0 ? -1 : 1);
      // Sine easing peaks at pi/2 x the average speed, so limit each key step to keep the peak under arcSlew.
      const maxStep = (i) => D.arcSlew * (keyT[i] - keyT[i - 1]) * 0.62;
      const keys = [];
      for (let i = 0; i < pit.length; i++) {
        let x = 0.5 + bias + ((pit[i] - mid) / span) * 0.7;
        x = Math.round(x * 8) / 8; // snap to eighths of the track width
        if (i > 0) {
          const prev = keys[i - 1];
          if (Math.abs(x - prev) < 0.2) x = prev; // ignore small wobbles: straight is readable
          x = prev + Math.max(-maxStep(i), Math.min(maxStep(i), x - prev));
        }
        keys.push(Math.max(0.125, Math.min(0.875, x)));
      }
      if (Math.max(...keys) - Math.min(...keys) < 0.2) {
        // Flat melody: one smooth glide across instead of a straight line.
        const dir = keys[0] < 0.5 ? 1 : -1;
        let perKey = Infinity;
        for (let i = 1; i < keys.length; i++) perKey = Math.min(perKey, maxStep(i));
        const target = Math.max(0.125, Math.min(0.875, keys[0] + dir * Math.min(0.375, perKey * (keys.length - 1))));
        for (let i = 0; i < keys.length; i++) keys[i] = keys[0] + (target - keys[0]) * (i / (keys.length - 1));
      }
      const steps = Math.max(2, Math.round((t1 - t0) / ARC_STEP));
      const xs = [];
      for (let s = 0; s <= steps; s++) {
        const t = Math.min(t1, t0 + s * ARC_STEP);
        let i = PTUtil.lowerBound(keyT, t) - 1;
        i = Math.max(0, Math.min(keyT.length - 2, i));
        const f = Math.max(0, Math.min(1, (t - keyT[i]) / Math.max(1e-6, keyT[i + 1] - keyT[i])));
        const e = 0.5 - 0.5 * Math.cos(Math.PI * f); // sine in-out
        xs.push(keys[i] + (keys[i + 1] - keys[i]) * e);
      }
      const ticks = [];
      const half = beatLen / 2;
      for (let t = t0; t < t1 - 0.03; t += half) ticks.push(t);
      return { t0, t1, color: xs[0] < 0.5 ? 0 : 1, xs, ticks };
    }
    const arcX = (arc, t) => {
      const f = Math.max(0, Math.min(arc.xs.length - 1, (t - arc.t0) / ARC_STEP));
      const i = Math.floor(f), k = f - i;
      return i + 1 < arc.xs.length ? arc.xs[i] * (1 - k) + arc.xs[i + 1] * k : arc.xs[i];
    };

    // ---- 4. holds ----
    const after = Math.max(D.minGap * 1.5, 0.3 * beatLen, 0.18);
    const holds = [];
    let holdEnd = -Infinity;
    for (const c of pickedObj.slice()) {
      if (c.removed || c.t < holdEnd + after) continue;
      if (arcAt(c.t, 0.2)) continue;
      let sus = sustainFrom(c.t);
      const k = PTUtil.lowerBound(picked, c.t + 1e-6);
      const nextT = k < picked.length ? picked[k] : Math.min(A.duration, A.soundEnd);
      if (nextT - c.t >= Math.max(D.holdMinBeats * beatLen, 0.55)) {
        // A beat or more of continuing sound before the next note (pads, chords, vocals, a
        // phrase ending) also makes a good hold, even when the pitch itself wobbles.
        const head = rmsMean(c.t, c.t + 0.12);
        const body = rmsMean(c.t + 0.12, c.t + (nextT - c.t) * 0.7);
        if (body >= head * 0.5) sus = Math.max(sus, nextT - c.t - after);
      }
      if (sus < D.holdMinBeats * beatLen || sus < 0.4) continue;
      if (rng() > D.holdRate) continue;
      let end = snapDown(c.t + Math.min(sus, 6 * beatLen));
      const arcNext = arcs.find(a => a.t0 > c.t);
      if (arcNext && end > arcNext.t0 - 0.3) end = snapDown(arcNext.t0 - 0.3);
      if (end - c.t < 0.4) continue;
      removeWhere(o => o !== c && o.t > c.t && o.t < end + 0.02 && (o.level > D.holdDuringLevel || o.t - c.t < D.minGap * 1.5));
      c.dur = end - c.t;
      holdEnd = end;
      holds.push([c.t, end]);
    }
    // Rhythm holds: songs without long sung notes (rap, EDM) still get a healthy share of holds,
    // placed on strong beats where the sound carries on (downbeats hold for two beats).
    const holdTarget = Math.round(pickedObj.length * D.holdShare);
    if (holds.length < holdTarget) {
      const pool = pickedObj.filter(c => !c.dur && c.level <= 1).sort(bySal);
      for (const c of pool) {
        if (holds.length >= holdTarget) break;
        if (c.removed || c.dur) continue;
        const end = snapDown(c.t + (c.level === 0 ? 2 : 1) * beatLen + 0.01);
        if (end - c.t < Math.max(0.4, beatLen * 0.9)) continue;
        if (holds.some(h => c.t < h[1] + after && end + after > h[0])) continue;
        if (arcs.some(a => c.t < a.t1 + 0.3 && end > a.t0 - 0.3)) continue;
        if (rmsMean(c.t + 0.1, end) < rmsMean(c.t, c.t + 0.1) * 0.45) continue;
        removeWhere(o => o !== c && o.t > c.t && o.t < end + 0.02 && (o.level > D.holdDuringLevel || o.t - c.t < D.minGap * 1.5));
        c.dur = end - c.t;
        holds.push([c.t, end]);
      }
      holds.sort((a, b) => a[0] - b[0]);
    }
    // Same release buffer as the two-hand rule in lane assignment.
    const inHold = (t) => holds.some(h => t > h[0] - 0.01 && t < h[1] + Math.max(D.jack, 0.2));

    // Fill long empty stretches with the best on-beat candidate so the flow never stalls.
    const beatCands = cands.filter(c => c.level <= 1).sort((a, b) => a.t - b.t);
    for (let pass = 0; pass < 3; pass++) {
      let added = false;
      for (let i = 0; i + 1 < picked.length; i++) {
        const gap = picked[i + 1] - picked[i];
        if (gap <= D.fillBeats * beatLen) continue;
        const mid = (picked[i] + picked[i + 1]) / 2;
        let best = null;
        for (const c of beatCands) {
          if (c.removed || c.t <= picked[i] + beatLen * 0.9 || c.t >= picked[i + 1] - beatLen * 0.9) continue;
          if (holds.some(h => c.t > h[0] && c.t < h[1] + after)) continue;
          if (!best || c.sal - Math.abs(c.t - mid) * 0.05 > best.sal - Math.abs(best.t - mid) * 0.05) best = c;
        }
        if (best && fits(best.t)) { add(best); added = true; i++; }
      }
      if (!added) break;
    }

    const notes = pickedObj.map(c => ({ t: c.t, lane: 0, dur: c.dur || 0, level: c.level, sal: c.sal, type: c.dur ? 'hold' : 'tap' }));

    // ---- 5. lanes from melody contour ----
    const pitches = notes.map((nt, i) => {
      const next = i + 1 < notes.length ? notes[i + 1].t : nt.t + 0.3;
      return pitchAt(nt.t + 0.01, Math.min(0.12, Math.max(0.03, next - nt.t - 0.01)));
    });
    for (let i = 0; i < pitches.length; i++) if (pitches[i] < 0) pitches[i] = i > 0 ? pitches[i - 1] : 60;
    const mirror = variation % 2 === 0;
    let prevLane = -1, run = 0;
    let active = null; // the hold being held: its lane is off limits
    for (let i = 0; i < notes.length; i++) {
      const p = pitches[i];
      let below = 0, equal = 0, total = 0;
      for (let j = Math.max(0, i - 4); j <= Math.min(notes.length - 1, i + 4); j++) {
        total++;
        if (pitches[j] < p) below++; else if (pitches[j] === p) equal++;
      }
      let lane = Math.min(LANES - 1, Math.floor(((below + equal * 0.5) / total) * LANES));
      const dir = i > 0 ? Math.sign(p - pitches[i - 1]) : 0;
      const gap = i > 0 ? notes[i].t - notes[i - 1].t : Infinity;
      if (i > 0 && lane === prevLane) {
        if (dir !== 0) {
          lane = lane + dir;
          if (lane < 0 || lane >= LANES) lane = prevLane - dir;
        } else if (gap < D.jack || run >= 2) {
          const step = rng() < 0.5 ? -1 : 1;
          lane = prevLane + step;
          if (lane < 0 || lane >= LANES) lane = prevLane - step;
        }
      }
      if (i > 0 && gap < D.jack && Math.abs(lane - prevLane) === 3) lane = prevLane + Math.sign(lane - prevLane) * 2;
      // Two hands: while one hand holds, every other note belongs to the other hand, so it goes
      // on the other half of the field (lanes 1-2 = left hand, 3-4 = right hand). The holding
      // hand also stays busy for a moment after it lets go.
      const post = Math.max(D.jack, 0.2);
      if (active && notes[i].t >= active.end + post) active = null;
      if (active) {
        const heldLeft = active.lane < 2;
        if (heldLeft && lane < 2) lane += 2;
        if (!heldLeft && lane >= 2) lane -= 2;
        if (i > 0 && lane === prevLane && gap < D.jack) lane = lane % 2 === 0 ? lane + 1 : lane - 1;
      }
      // Horizontal: while an arc is traced, the floor belongs to the other hand's side.
      const arc = arcAt(notes[i].t, 0.15);
      if (arc) {
        const armLeft = arcX(arc, notes[i].t) < 0.5;
        if (armLeft && lane < 2) lane += 2;
        if (!armLeft && lane >= 2) lane -= 2;
        if (i > 0 && lane === prevLane && gap < D.jack) lane = lane % 2 === 0 ? lane + 1 : lane - 1;
      }
      run = lane === prevLane ? run + 1 : 0;
      notes[i].lane = lane;
      prevLane = lane;
      if (notes[i].dur > 0) active = { lane, end: notes[i].t + notes[i].dur };
    }
    if (mirror) notes.forEach(nt => { nt.lane = LANES - 1 - nt.lane; });

    // ---- 6. accents: flicks, sky notes, doubles ----
    const isFree = (i, minSpace) => {
      const nt = notes[i];
      if (nt.dur > 0 || inHold(nt.t)) return false;
      const prevGap = i > 0 ? nt.t - notes[i - 1].t : Infinity;
      const nextGap = i + 1 < notes.length ? notes[i + 1].t - nt.t : Infinity;
      return prevGap >= minSpace && nextGap >= minSpace;
    };
    const secStarts = A.sections.map(s => s.start);
    const accent = (nt) => nt.sal + 0.6 * peakOf(A.onsetHigh, nt.t, 2) + 0.4 * peakOf(A.onsetLow, nt.t, 2) +
      (secStarts.some(s => Math.abs(s - nt.t) < beatLen * 0.6) ? 0.8 : 0);

    // Flicks: the biggest hits (crashes, section starts), with room around them for the swipe.
    const flickSpace = Math.max(D.minGap * 1.8, 0.22);
    const flickCands = notes.map((nt, i) => ({ i, a: accent(nt) }))
      .filter(o => notes[o.i].level <= 1 && !arcAt(notes[o.i].t, 0.2) && isFree(o.i, flickSpace))
      .sort((a, b) => b.a - a.a || a.i - b.i);
    const nFlick = Math.round(notes.length * D.flickRate);
    for (const o of flickCands.slice(0, nFlick)) notes[o.i].type = 'flick';

    // Sky notes (horizontal): snare / clap / hat accents move up into the air.
    if (horizontal) {
      const skyGap = D.index === 3 ? 0.28 : 0.42;
      const skyCands = notes.map((nt, i) => ({ i, a: peakOf(A.onsetHigh, nt.t, 2) + (nt.level === 1 ? 0.25 : 0) }))
        .filter(o => notes[o.i].type === 'tap' && !arcAt(notes[o.i].t, 0.25) && isFree(o.i, D.minGap))
        .sort((a, b) => b.a - a.a || a.i - b.i);
      const want = Math.round(notes.length * D.skyRate);
      const skyTimes = [];
      for (const o of skyCands) {
        if (skyTimes.length >= want) break;
        const t = notes[o.i].t;
        if (skyTimes.some(s => Math.abs(s - t) < skyGap)) continue;
        notes[o.i].type = 'sky';
        notes[o.i].x = 0.14 + 0.72 * (notes[o.i].lane / (LANES - 1));
        skyTimes.push(t);
      }
    }

    const out = [];
    let chordThr = Infinity;
    if (D.chordRate > 0 && notes.length) {
      const sals = notes.filter(nt => nt.level <= 1 && nt.type === 'tap').map(nt => nt.sal).sort((a, b) => b - a);
      chordThr = sals[Math.floor(sals.length * D.chordRate)] || Infinity;
    }
    for (let i = 0; i < notes.length; i++) {
      const nt = notes[i];
      const o = { t: nt.t, type: nt.type, lane: nt.lane, dur: nt.dur };
      if (nt.type === 'sky') { o.x = nt.x; delete o.lane; }
      out.push(o);
      if (nt.type !== 'tap' || nt.level > 1 || nt.sal < chordThr || inHold(nt.t) || arcAt(nt.t, 0.2)) continue;
      if (!isFree(i, Math.max(D.minGap * 1.4, 0.18))) continue;
      let other = (nt.lane + 2) % LANES;
      const nextGap = i + 1 < notes.length ? notes[i + 1].t - nt.t : Infinity;
      const prevGap = i > 0 ? nt.t - notes[i - 1].t : Infinity;
      if (i + 1 < notes.length && notes[i + 1].lane === other && nextGap < D.jack) other = (nt.lane + 1) % LANES === other ? (nt.lane + 3) % LANES : (nt.lane + 1) % LANES;
      if (i > 0 && notes[i - 1].lane === other && prevGap < D.jack) continue;
      o.pair = true;
      out.push({ t: nt.t, type: 'tap', lane: other, dur: 0, pair: true });
    }

    // Hard horizontal: finish some arcs with a sky tap where the arc ends ("arc -> sky").
    if (horizontal && D.index === 3) {
      for (const a of arcs) {
        const tEnd = a.t1;
        if (out.some(nt => Math.abs(nt.t - tEnd) < 0.22)) continue;
        if (arcs.some(b => b !== a && b.t0 >= tEnd && b.t0 - tEnd < 0.35)) continue;
        out.push({ t: tEnd, type: 'sky', x: a.xs[a.xs.length - 1], dur: 0 });
      }
    }

    out.sort((a, b) => a.t - b.t || (a.lane == null ? 9 : a.lane) - (b.lane == null ? 9 : b.lane));
    out.forEach((nt, i) => { nt.id = i; });
    arcs.forEach((a, i) => { a.id = i; });

    const speed = buildSpeedCurve(A, D, (opts && opts.speedMod) || 1);
    return {
      difficulty: diffKey, mode: D.mode, variation, notes: out, arcs, arcStep: ARC_STEP,
      speed, stats: stats(out, arcs), travel: D.travel
    };
  }

  // Scroll speed ramps up section by section. Positions come from the integral of speed, so
  // notes never jump when the speed changes.
  function buildSpeedCurve(A, D, speedMod) {
    const dt = 0.01;
    const t0 = -12;
    const t1 = A.duration + 12;
    const len = Math.ceil((t1 - t0) / dt) + 1;
    const dist = new Float64Array(len);
    const secMult = A.sections.map(s => 1 + D.ramp * (s.start / Math.max(1, A.duration)));
    const cues = [];
    for (let i = 1; i < A.sections.length; i++) {
      if (secMult[i] - secMult[i - 1] >= 0.025) cues.push(A.sections[i].start);
    }
    const base = speedMod / D.travel;
    const multAt = (t) => {
      let m = secMult[0];
      for (let i = 0; i < A.sections.length; i++) {
        const s = A.sections[i];
        if (t >= s.start) {
          const prev = i > 0 ? secMult[i - 1] : secMult[0];
          const k = Math.min(1, (t - s.start) / 1.5);
          m = prev + (secMult[i] - prev) * k;
        }
      }
      return m;
    };
    let acc = 0;
    for (let i = 0; i < len; i++) {
      dist[i] = acc;
      acc += base * multAt(t0 + i * dt) * dt;
    }
    return {
      // Distance (in hit-line heights / track lengths) travelled by the scroll at song time t.
      at(t) {
        const x = (t - t0) / dt;
        if (x <= 0) return dist[0] + (t - t0) * base;
        if (x >= len - 1) return dist[len - 1] + (t - (t0 + (len - 1) * dt)) * base * secMult[secMult.length - 1];
        const i = x | 0, f = x - i;
        return dist[i] + (dist[i + 1] - dist[i]) * f;
      },
      multAt,
      cues
    };
  }

  function stats(notes, arcs) {
    const s = { count: notes.length, holds: 0, flicks: 0, sky: 0, chords: 0, arcs: arcs.length, avgNps: 0, peakNps: 0, stars: 0 };
    if (!notes.length) return s;
    for (const nt of notes) {
      if (nt.type === 'hold') s.holds++;
      else if (nt.type === 'flick') s.flicks++;
      else if (nt.type === 'sky') s.sky++;
      if (nt.pair) s.chords++;
    }
    s.chords = Math.round(s.chords / 2);
    const span = Math.max(1, notes[notes.length - 1].t - notes[0].t);
    const arcTime = arcs.reduce((a, b) => a + (b.t1 - b.t0), 0);
    s.avgNps = notes.length / span;
    for (let i = 0, j = 0; i < notes.length; i++) {
      while (notes[i].t - notes[j].t > 2) j++;
      s.peakNps = Math.max(s.peakNps, (i - j + 1) / 2);
    }
    // Chart level (like a difficulty constant): density, bursts, arcs and air notes.
    s.level = Math.round(Math.max(1, Math.min(15, 1 + s.avgNps * 1.25 + s.peakNps * 0.3 + (arcTime / span) * 2.5 + (s.sky / notes.length) * 3)) * 10) / 10;
    s.stars = Math.max(1, Math.min(10, Math.round(s.level * 0.8)));
    return s;
  }

  // Where the first chorus ends. The chorus is taken to be the loudest section type that repeats;
  // the split is the end of its first appearance, snapped to a bar line. Falls back to the
  // section boundary nearest the middle when that lands too close to either end.
  function splitPoint(A) {
    const secs = A.sections, dur = A.duration;
    const bars = [];
    for (let i = A.downbeatPhase; i < A.beats.length; i += 4) bars.push(A.beats[i]);
    const snap = (t) => {
      let best = t, bd = Infinity;
      for (const b of bars) if (Math.abs(b - t) < bd) { bd = Math.abs(b - t); best = b; }
      return bd < 2.5 ? best : t;
    };
    const ok = (t) => t >= dur * 0.2 && t <= dur * 0.8;
    const byLabel = {};
    secs.forEach((s, i) => {
      const o = byLabel[s.label] || (byLabel[s.label] = { count: 0, energy: 0, length: 0, first: i });
      o.count++; o.energy += s.energy; o.length += s.end - s.start;
    });
    let chorus = null, bestScore = -Infinity;
    for (const [label, o] of Object.entries(byLabel)) {
      if (o.count < 2) continue;
      // Loud, repeated and long: choruses usually win on all three.
      const score = o.energy / o.count + 0.08 * o.count + 0.002 * o.length;
      if (score > bestScore) { bestScore = score; chorus = label; }
    }
    if (!chorus) {
      let top = -1;
      secs.forEach(s => { if (s.energy > top) { top = s.energy; chorus = s.label; } });
    }
    // End of the first run of chorus sections; if that is too early, try later appearances.
    for (let i = 0; i < secs.length; i++) {
      if (secs[i].label !== chorus) continue;
      let j = i;
      while (j + 1 < secs.length && secs[j + 1].label === chorus) j++;
      const t = snap(secs[j].end);
      if (ok(t)) return t;
      if (t > dur * 0.8) break;
      i = j;
    }
    let best = dur / 2, bd = Infinity;
    for (let i = 1; i < secs.length; i++) {
      const d = Math.abs(secs[i].start - dur * 0.45);
      if (d < bd && ok(secs[i].start)) { bd = d; best = secs[i].start; }
    }
    return snap(best);
  }

  // A chart limited to [start, end): notes and arcs fully inside the range, stats recomputed.
  function slice(chart, start, end) {
    const notes = chart.notes.filter(n => n.t >= start && n.t + n.dur <= end - 0.05).map((n, i) => Object.assign({}, n, { id: i }));
    const arcs = chart.arcs.filter(a => a.t0 >= start && a.t1 <= end).map((a, i) => Object.assign({}, a, { id: i }));
    return Object.assign({}, chart, { notes, arcs, stats: stats(notes, arcs), range: { start, end } });
  }

  global.PTChart = { generate, slice, splitPoint, DIFFICULTIES, LANES };
})(typeof self !== 'undefined' ? self : this);

/*
 * Audio analysis. Everything lives inside PTAnalyzerFactory so the function source can be
 * stringified into a Blob Web Worker (works even when index.html is opened from file://).
 * It must not reference anything outside its own body.
 *
 * Input: mono Float32Array + sample rate. Output: onset envelope, onsets, tempo, beat grid,
 * downbeat phase, melody pitch track, chroma, sections and key — all deterministic.
 */
function PTAnalyzerFactory() {
  'use strict';

  const TARGET_SR = 22050;
  const N = 1024;          // FFT size
  const HOP = 256;         // ~11.6 ms at 22.05 kHz
  const PITCH_MIN = 45;    // MIDI A2
  const PITCH_MAX = 84;    // MIDI C6

  // ---------- FFT (radix-2, in place) ----------
  function makeFFT(n) {
    const levels = Math.log2(n) | 0;
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
      rev[i] = r;
    }
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos(2 * Math.PI * i / n);
      sin[i] = Math.sin(2 * Math.PI * i / n);
    }
    return function fft(re, im) {
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) {
          let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
        }
      }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let start = 0; start < n; start += size) {
          for (let k = 0, tw = 0; k < half; k++, tw += step) {
            const a = start + k, b = a + half;
            const c = cos[tw], s = sin[tw];
            const tr = re[b] * c + im[b] * s;
            const ti = im[b] * c - re[b] * s;
            re[b] = re[a] - tr; im[b] = im[a] - ti;
            re[a] += tr; im[a] += ti;
          }
        }
      }
    };
  }

  function percentile(arr, p) {
    const copy = Array.from(arr).sort((a, b) => a - b);
    if (!copy.length) return 0;
    return copy[Math.min(copy.length - 1, Math.max(0, Math.floor(p * (copy.length - 1))))];
  }

  function movingAverage(x, radius) {
    const n = x.length, out = new Float32Array(n);
    let sum = 0, count = 0, lo = 0, hi = -1;
    for (let i = 0; i < n; i++) {
      const wantLo = Math.max(0, i - radius), wantHi = Math.min(n - 1, i + radius);
      while (hi < wantHi) { hi++; sum += x[hi]; count++; }
      while (lo < wantLo) { sum -= x[lo]; lo++; count--; }
      out[i] = sum / count;
    }
    return out;
  }

  function downsample(samples, sr) {
    const factor = Math.max(1, Math.round(sr / TARGET_SR));
    if (factor === 1) return { y: samples, sr };
    const n = Math.floor(samples.length / factor);
    const y = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++) {
      let s = 0;
      for (let k = 0; k < factor; k++) s += samples[j++];
      y[i] = s / factor;
    }
    return { y, sr: sr / factor };
  }

  // ---------- Stage 1: spectral features ----------
  async function spectralFeatures(y, sr, progress, yieldFn) {
    const nFrames = Math.max(1, Math.floor((y.length - N) / HOP) + 1);
    const nBins = N / 2;
    const binHz = sr / N;
    const fft = makeFFT(N);
    const win = new Float64Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    const magScale = 4 / N; // full-scale sine ~ 1.0

    const onset = new Float32Array(nFrames);
    const onsetLow = new Float32Array(nFrames);
    const onsetHigh = new Float32Array(nFrames);
    const rms = new Float32Array(nFrames);
    const pitch = new Float32Array(nFrames);
    const pitchConf = new Float32Array(nFrames);
    const chroma = new Float32Array(nFrames * 12);

    const lowBin = Math.max(2, Math.round(180 / binHz));
    const highBin = Math.round(3000 / binHz);
    // Chroma comes from spectral peaks whose frequency is refined by parabolic interpolation:
    // low bins are wider than a semitone, so mapping raw bins to pitch classes would be wrong.
    const chromaLo = Math.max(2, Math.floor(180 / binHz)), chromaHi = Math.min(nBins - 2, Math.ceil(4200 / binHz));
    const cand = [];
    for (let m = PITCH_MIN; m <= PITCH_MAX; m++) cand.push(440 * Math.pow(2, (m - 69) / 12) / binHz);
    const HARM = 6;
    const hw = [1, 0.8, 0.64, 0.51, 0.41, 0.33];

    const reA = new Float64Array(N), imA = new Float64Array(N);
    const magA = new Float32Array(nBins), magB = new Float32Array(nBins);
    let prevLog = new Float32Array(nBins), curLog = new Float32Array(nBins);
    const sal = new Float32Array(cand.length);

    const doFrame = (t, mag) => {
      // log magnitude + spectral flux against a 3-bin max-filtered previous frame (vibrato-robust)
      let fAll = 0, fLow = 0, fHigh = 0;
      for (let k = 1; k < nBins; k++) {
        const l = Math.log(1 + 100 * mag[k]);
        curLog[k] = l;
        if (t > 0) {
          let p = prevLog[k];
          if (prevLog[k - 1] > p) p = prevLog[k - 1];
          if (k + 1 < nBins && prevLog[k + 1] > p) p = prevLog[k + 1];
          const d = l - p;
          if (d > 0) {
            fAll += d;
            if (k < lowBin) fLow += d;
            else if (k >= highBin) fHigh += d;
          }
        }
      }
      onset[t] = fAll; onsetLow[t] = fLow; onsetHigh[t] = fHigh;
      const tmp = prevLog; prevLog = curLog; curLog = tmp;

      const cOff = t * 12;
      let frameMax = 0;
      for (let k = chromaLo; k <= chromaHi; k++) if (mag[k] > frameMax) frameMax = mag[k];
      const peakFloor = Math.max(1e-4, frameMax * 0.02);
      for (let k = chromaLo; k <= chromaHi; k++) {
        const m = mag[k];
        if (m < peakFloor || m < mag[k - 1] || m <= mag[k + 1]) continue;
        const la = Math.log(mag[k - 1] + 1e-9), lb = Math.log(m), lc = Math.log(mag[k + 1] + 1e-9);
        const den = la - 2 * lb + lc;
        const shift = den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (la - lc) / den)) : 0;
        const midi = 69 + 12 * Math.log2((k + shift) * binHz / 440);
        chroma[cOff + (((Math.round(midi) % 12) + 12) % 12)] += m * m;
      }

      // Melody pitch via weighted harmonic summation on a semitone grid.
      let best = -1, bestV = 0, sum = 0;
      for (let c = 0; c < cand.length; c++) {
        const f0 = cand[c];
        let v = 0;
        for (let h = 0; h < HARM; h++) {
          const pos = f0 * (h + 1);
          if (pos >= nBins - 1) break;
          const i0 = pos | 0, fr = pos - i0;
          v += hw[h] * (mag[i0] * (1 - fr) + mag[i0 + 1] * fr);
        }
        sal[c] = v; sum += v;
        if (v > bestV) { bestV = v; best = c; }
      }
      if (best >= 0 && sum > 0) {
        pitch[t] = PITCH_MIN + best;
        pitchConf[t] = bestV / (sum / cand.length);
      } else {
        pitch[t] = 0; pitchConf[t] = 0;
      }
    };

    const fillFrame = (t, dst) => {
      const off = t * HOP;
      let e = 0;
      for (let i = 0; i < N; i++) {
        const s = off + i < y.length ? y[off + i] : 0;
        e += s * s;
        dst[i] = s * win[i];
      }
      rms[t] = Math.sqrt(e / N);
    };

    // Two real frames per complex FFT: z = x1 + i*x2.
    const x1 = new Float64Array(N), x2 = new Float64Array(N);
    for (let t = 0; t < nFrames; t += 2) {
      const hasSecond = t + 1 < nFrames;
      fillFrame(t, x1);
      if (hasSecond) fillFrame(t + 1, x2); else x2.fill(0);
      for (let i = 0; i < N; i++) { reA[i] = x1[i]; imA[i] = x2[i]; }
      fft(reA, imA);
      for (let k = 0; k < nBins; k++) {
        const nk = (N - k) % N;
        const ar = reA[k], ai = imA[k], br = reA[nk], bi = -imA[nk];
        const r1 = (ar + br), i1 = (ai + bi);
        const r2 = (ar - br), i2 = (ai - bi);
        magA[k] = 0.5 * Math.sqrt(r1 * r1 + i1 * i1) * magScale;
        magB[k] = 0.5 * Math.sqrt(r2 * r2 + i2 * i2) * magScale;
      }
      doFrame(t, magA);
      if (hasSecond) doFrame(t + 1, magB);
      if ((t & 2047) === 0) {
        progress('spectrum', t / nFrames);
        if (yieldFn) await yieldFn();
      }
    }

    // Normalise chroma per frame.
    for (let t = 0; t < nFrames; t++) {
      let m = 0;
      for (let c = 0; c < 12; c++) m = Math.max(m, chroma[t * 12 + c]);
      if (m > 0) for (let c = 0; c < 12; c++) chroma[t * 12 + c] /= m;
    }
    return { nFrames, onset, onsetLow, onsetHigh, rms, pitch, pitchConf, chroma };
  }

  // ---------- Stage 2: onset picking ----------
  function pickOnsets(env, hopTime, frameOffset, silent) {
    const pre = 3, post = 3, avgR = 12, delta = 0.07, wait = 4;
    const avg = movingAverage(env, avgR);
    const onsets = [];
    let last = -Infinity;
    for (let t = 1; t < env.length - 1; t++) {
      const v = env[t];
      if (silent[t] || v < avg[t] + delta || v < 0.08) continue;
      let isMax = true;
      for (let k = Math.max(0, t - pre); k <= Math.min(env.length - 1, t + post); k++) {
        if (env[k] > v || (env[k] === v && k < t)) { isMax = false; break; }
      }
      if (!isMax || t - last < wait) continue;
      // Parabolic refinement of the peak position.
      const a = env[t - 1], b = v, c = env[t + 1];
      const den = a - 2 * b + c;
      const shift = den !== 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) : 0;
      onsets.push({ t: (t + shift) * hopTime + frameOffset, s: v, f: t });
      last = t;
    }
    return onsets;
  }

  // ---------- Stage 3: tempo ----------
  function estimateTempo(env, hopTime) {
    const detr = new Float32Array(env.length);
    const avg = movingAverage(env, Math.round(0.5 / hopTime));
    for (let i = 0; i < env.length; i++) detr[i] = Math.max(0, env[i] - avg[i]);
    const minLag = Math.max(2, Math.floor(60 / 220 / hopTime));
    const maxLag = Math.ceil(60 / 50 / hopTime);
    const n = detr.length;
    const ac = new Float64Array(maxLag + 2);
    for (let L = minLag - 1; L <= maxLag + 1; L++) {
      if (L >= n) break;
      let s = 0;
      for (let i = 0; i + L < n; i++) s += detr[i] * detr[i + L];
      ac[L] = s / (n - L);
    }
    let best = -1, bestScore = -Infinity;
    const score = new Float64Array(maxLag + 2);
    for (let L = minLag; L <= maxLag; L++) {
      const bpm = 60 / (L * hopTime);
      const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
      // Reward lags whose multiples also line up (metrical support).
      const L2 = 2 * L < ac.length ? ac[2 * L] : 0;
      score[L] = (ac[L] + 0.2 * L2) * prior;
      if (score[L] > bestScore) { bestScore = score[L]; best = L; }
    }
    if (best < 0) return { period: 0.5 / hopTime, bpm: 120, confidence: 0 };
    let lag = best;
    if (best > minLag && best < maxLag) {
      const a = score[best - 1], b = score[best], c = score[best + 1];
      const den = a - 2 * b + c;
      if (den !== 0) lag = best + Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den));
    }
    let mean = 0;
    for (let L = minLag; L <= maxLag; L++) mean += score[L];
    mean /= (maxLag - minLag + 1);
    return { period: lag, bpm: 60 / (lag * hopTime), confidence: mean > 0 ? bestScore / mean : 0 };
  }

  // ---------- Stage 4: beat tracking (dynamic programming, Ellis 2007) ----------
  function trackBeats(env, period, silent) {
    const n = env.length;
    let mean = 0, sq = 0;
    for (let i = 0; i < n; i++) { mean += env[i]; sq += env[i] * env[i]; }
    mean /= n;
    const std = Math.sqrt(Math.max(1e-12, sq / n - mean * mean));
    // Local score: normalised envelope smoothed with a Gaussian of width period/32.
    const half = Math.max(1, Math.round(period));
    const w = [];
    for (let k = -half; k <= half; k++) w.push(Math.exp(-0.5 * Math.pow(k * 32 / period, 2)));
    const local = new Float32Array(n);
    for (let t = 0; t < n; t++) {
      let s = 0;
      for (let k = -half; k <= half; k++) {
        const j = t + k;
        if (j >= 0 && j < n) s += w[k + half] * env[j];
      }
      local[t] = s / std;
    }
    const tightness = 100;
    const cum = new Float32Array(n);
    const back = new Int32Array(n).fill(-1);
    const lo = Math.round(period / 2), hi = Math.round(period * 2);
    let maxLocal = 0;
    for (let t = 0; t < n; t++) maxLocal = Math.max(maxLocal, local[t]);
    let first = true;
    for (let t = 0; t < n; t++) {
      let best = -Infinity, arg = -1;
      for (let p = t - hi; p <= t - lo; p++) {
        if (p < 0) continue;
        const r = Math.log((t - p) / period);
        const v = cum[p] - tightness * r * r;
        if (v > best) { best = v; arg = p; }
      }
      if (arg < 0) { cum[t] = local[t]; continue; }
      cum[t] = local[t] + best;
      if (first && local[t] < 0.01 * maxLocal) back[t] = -1;
      else { back[t] = arg; first = false; }
    }
    // Last beat: last local max of cum exceeding half the median of local maxima.
    const peaks = [];
    for (let t = 1; t < n - 1; t++) if (cum[t] > cum[t - 1] && cum[t] >= cum[t + 1]) peaks.push(t);
    if (!peaks.length) return [];
    const med = percentile(peaks.map(p => cum[p]), 0.5);
    let end = peaks[peaks.length - 1];
    for (let i = peaks.length - 1; i >= 0; i--) if (cum[peaks[i]] >= 0.5 * med) { end = peaks[i]; break; }
    const beats = [];
    for (let t = end; t >= 0; t = back[t]) {
      beats.push(t);
      if (back[t] < 0) break;
    }
    beats.reverse();
    // Trim beats that fall in silence at either end.
    let a = 0, b = beats.length - 1;
    while (a <= b && silent[beats[a]]) a++;
    while (b >= a && silent[beats[b]]) b--;
    return beats.slice(a, b + 1);
  }

  // Fill gaps in the beat list (e.g. a quiet bridge) and extend to cover all sound.
  function regularizeBeats(beatTimes, period, soundStart, soundEnd) {
    let beats = beatTimes.slice();
    if (beats.length < 4) {
      beats = [];
      for (let t = soundStart; t <= soundEnd; t += period) beats.push(t);
      return beats;
    }
    const out = [beats[0]];
    for (let i = 1; i < beats.length; i++) {
      const gap = beats[i] - out[out.length - 1];
      const k = Math.round(gap / period);
      if (k >= 2) for (let j = 1; j < k; j++) out.push(out[out.length - 1] + gap / k * 1);
      out.push(beats[i]);
    }
    // Extend backwards / forwards with the local period.
    const headP = out.length > 4 ? (out[4] - out[0]) / 4 : period;
    while (out[0] - headP >= soundStart - headP * 0.25) out.unshift(out[0] - headP);
    const tailP = out.length > 4 ? (out[out.length - 1] - out[out.length - 5]) / 4 : period;
    while (out[out.length - 1] + tailP <= soundEnd + tailP * 0.25) out.push(out[out.length - 1] + tailP);
    return out.filter(t => t >= 0);
  }

  // ---------- Stage 5: sections ----------
  function segment(barTimes, feats, duration) {
    const nb = feats.length;
    if (nb < 12) {
      return [{ start: 0, end: duration, bar0: 0, bar1: nb }];
    }
    const sim = (i, j) => {
      const a = feats[i], b = feats[j];
      let dot = 0;
      for (let c = 0; c < 12; c++) dot += a.chroma[c] * b.chroma[c];
      const e = 1 - Math.min(1, Math.abs(a.energy - b.energy) * 2);
      const o = 1 - Math.min(1, Math.abs(a.density - b.density) * 2);
      return 0.55 * dot + 0.3 * e + 0.15 * o;
    };
    const K = 4;
    const nov = new Float32Array(nb);
    for (let i = K; i <= nb - K; i++) {
      let s = 0;
      for (let a = -K; a < K; a++) {
        for (let b = -K; b < K; b++) {
          const ia = i + a, ib = i + b;
          const sign = (a < 0) === (b < 0) ? 1 : -1;
          const g = Math.exp(-0.5 * ((a + 0.5) * (a + 0.5) + (b + 0.5) * (b + 0.5)) / (K * K * 0.5));
          s += sign * g * sim(ia, ib);
        }
      }
      nov[i] = Math.max(0, s);
    }
    let m = 0, sd = 0, cnt = 0;
    for (let i = K; i <= nb - K; i++) { m += nov[i]; cnt++; }
    m /= Math.max(1, cnt);
    for (let i = K; i <= nb - K; i++) sd += (nov[i] - m) * (nov[i] - m);
    sd = Math.sqrt(sd / Math.max(1, cnt));
    const cands = [];
    for (let i = K; i <= nb - K; i++) {
      let isMax = true;
      for (let j = Math.max(0, i - 4); j <= Math.min(nb - 1, i + 4); j++) {
        if (nov[j] > nov[i] || (nov[j] === nov[i] && j < i)) { isMax = false; break; }
      }
      if (isMax && nov[i] > m + 0.4 * sd) cands.push(i);
    }
    // Prefer boundaries on 4-bar phrase lines when a phrase line is close.
    const bounds = [0];
    for (const c of cands) {
      let b = c;
      const r = Math.round(c / 4) * 4;
      if (Math.abs(r - c) <= 1 && r > 0 && r < nb) b = r;
      if (b - bounds[bounds.length - 1] >= 4 && nb - b >= 4) bounds.push(b);
    }
    bounds.push(nb);
    const secs = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      secs.push({
        start: i === 0 ? 0 : barTimes[bounds[i]],
        end: i === bounds.length - 2 ? duration : barTimes[bounds[i + 1]],
        bar0: bounds[i], bar1: bounds[i + 1]
      });
    }
    return secs;
  }

  const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  function estimateKey(total) {
    const corr = (prof, shift) => {
      let ma = 0, mb = 0;
      for (let i = 0; i < 12; i++) { ma += total[(i + shift) % 12]; mb += prof[i]; }
      ma /= 12; mb /= 12;
      let num = 0, da = 0, db = 0;
      for (let i = 0; i < 12; i++) {
        const a = total[(i + shift) % 12] - ma, b = prof[i] - mb;
        num += a * b; da += a * a; db += b * b;
      }
      return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
    };
    let best = { name: '?', r: -2 };
    for (let s = 0; s < 12; s++) {
      const rM = corr(MAJOR, s), rm = corr(MINOR, s);
      if (rM > best.r) best = { name: NAMES[s] + ' major', r: rM };
      if (rm > best.r) best = { name: NAMES[s] + ' minor', r: rm };
    }
    return best.name;
  }

  // ---------- Main entry ----------
  async function analyze(samples, sampleRate, onProgress, yieldFn) {
    const progress = onProgress || function () {};
    progress('prepare', 0);
    const { y, sr } = downsample(samples, sampleRate);
    const duration = samples.length / sampleRate;
    const hopTime = HOP / sr;
    // Frame t spans samples [t*HOP, t*HOP+N); its flux peak sits slightly after the window centre
    // relative to the true attack (calibrated on synthetic clicks).
    const frameOffset = (N / 2 + 0.4 * HOP) / sr;

    const F = await spectralFeatures(y, sr, progress, yieldFn);
    const n = F.nFrames;
    progress('onsets', 0);

    // Silence mask from RMS.
    const rmsSorted = percentile(F.rms, 0.95);
    const silenceThr = Math.max(1e-4, rmsSorted * 0.04);
    const silent = new Uint8Array(n);
    let soundStartF = -1, soundEndF = -1;
    for (let t = 0; t < n; t++) {
      silent[t] = F.rms[t] < silenceThr ? 1 : 0;
      if (!silent[t]) { if (soundStartF < 0) soundStartF = t; soundEndF = t; }
    }
    if (soundStartF < 0) throw new Error('The file appears to be silent.');

    // Normalise onset envelopes by a robust maximum.
    const norm = (arr) => {
      const p = percentile(arr, 0.99) || 1;
      for (let i = 0; i < arr.length; i++) arr[i] = Math.min(2, arr[i] / p);
      return arr;
    };
    norm(F.onset); norm(F.onsetLow); norm(F.onsetHigh);
    const onsets = pickOnsets(F.onset, hopTime, frameOffset, silent);
    progress('tempo', 0);
    const tempo = estimateTempo(F.onset, hopTime);
    progress('beats', 0);
    if (yieldFn) await yieldFn();
    const beatFrames = trackBeats(F.onset, tempo.period, silent);
    const soundStart = soundStartF * hopTime + frameOffset;
    const soundEnd = soundEndF * hopTime + frameOffset + N / sr;
    const beats = regularizeBeats(
      beatFrames.map(f => f * hopTime + frameOffset),
      tempo.period * hopTime, soundStart, Math.min(duration, soundEnd)
    );
    // Final BPM from the median inter-beat interval.
    const ibis = [];
    const span = Math.min(8, beats.length - 1);
    for (let i = span; i < beats.length; i++) ibis.push((beats[i] - beats[i - span]) / span);
    const medIbi = ibis.length ? percentile(ibis, 0.5) : tempo.period * hopTime;
    const bpm = 60 / medIbi;

    const frameAt = (t) => Math.max(0, Math.min(n - 1, Math.round((t - frameOffset) / hopTime)));
    const peakNear = (arr, t, radius) => {
      const c = frameAt(t);
      let m = 0;
      for (let k = Math.max(0, c - radius); k <= Math.min(n - 1, c + radius); k++) m = Math.max(m, arr[k]);
      return m;
    };

    // Downbeat phase (assume 4/4): phase with the most low-frequency attack energy.
    const phaseScore = [0, 0, 0, 0];
    for (let i = 0; i < beats.length; i++) {
      phaseScore[i % 4] += peakNear(F.onsetLow, beats[i], 3) + 0.25 * peakNear(F.onset, beats[i], 3);
    }
    let downbeatPhase = 0;
    for (let p = 1; p < 4; p++) if (phaseScore[p] > phaseScore[downbeatPhase]) downbeatPhase = p;

    progress('sections', 0);
    if (yieldFn) await yieldFn();
    // Bar features.
    const barTimes = [];
    for (let i = downbeatPhase; i < beats.length; i += 4) barTimes.push(beats[i]);
    const feats = [];
    for (let b = 0; b < barTimes.length; b++) {
      const t0 = barTimes[b];
      const t1 = b + 1 < barTimes.length ? barTimes[b + 1] : Math.min(duration, t0 + 4 * medIbi);
      const f0 = frameAt(t0), f1 = Math.max(f0 + 1, frameAt(t1));
      const ch = new Float32Array(12);
      let e = 0, d = 0;
      for (let t = f0; t < f1; t++) {
        for (let c = 0; c < 12; c++) ch[c] += F.chroma[t * 12 + c];
        e += F.rms[t];
        d += F.onset[t];
      }
      let len = 0;
      for (let c = 0; c < 12; c++) len += ch[c] * ch[c];
      len = Math.sqrt(len) || 1;
      for (let c = 0; c < 12; c++) ch[c] /= len;
      feats.push({ chroma: ch, energy: e / (f1 - f0), density: d / (f1 - f0) });
    }
    // Normalise bar energy / density to 0..1 for similarity.
    const eMax = Math.max(1e-9, ...feats.map(f => f.energy));
    const dMax = Math.max(1e-9, ...feats.map(f => f.density));
    feats.forEach(f => { f.energy /= eMax; f.density /= dMax; });
    const rawSecs = segment(barTimes, feats, duration);

    // Section energy (mean RMS over its span) and repetition labels.
    const secs = rawSecs.map(s => {
      const f0 = frameAt(s.start), f1 = Math.max(f0 + 1, frameAt(s.end));
      let e = 0, d = 0;
      for (let t = f0; t < f1; t++) { e += F.rms[t]; d += F.onset[t]; }
      const ch = new Float32Array(12);
      for (let b = s.bar0; b < s.bar1 && b < feats.length; b++) for (let c = 0; c < 12; c++) ch[c] += feats[b].chroma[c];
      let len = 0;
      for (let c = 0; c < 12; c++) len += ch[c] * ch[c];
      len = Math.sqrt(len) || 1;
      for (let c = 0; c < 12; c++) ch[c] /= len;
      return { start: s.start, end: s.end, rms: e / (f1 - f0), density: d / (f1 - f0), chroma: ch };
    });
    const rMin = Math.min(...secs.map(s => s.rms)), rMax = Math.max(...secs.map(s => s.rms));
    const dMaxS = Math.max(1e-9, ...secs.map(s => s.density));
    const labels = [];
    secs.forEach((s, i) => {
      const eNorm = rMax > rMin ? (s.rms - rMin) / (rMax - rMin) : 0.5;
      s.energy = Math.max(0, Math.min(1, 0.7 * eNorm + 0.3 * s.density / dMaxS));
      let label = null;
      for (let j = 0; j < i; j++) {
        const o = secs[j];
        let dot = 0;
        for (let c = 0; c < 12; c++) dot += s.chroma[c] * o.chroma[c];
        if (dot > 0.96 && Math.abs(o.energy - s.energy) < 0.2) { label = o.label; break; }
      }
      if (!label) { label = String.fromCharCode(65 + labels.length % 26); labels.push(label); }
      s.label = label;
    });
    const sections = secs.map(s => ({ start: s.start, end: s.end, energy: s.energy, label: s.label }));

    const total = new Float64Array(12);
    for (let t = 0; t < n; t++) if (!silent[t]) for (let c = 0; c < 12; c++) total[c] += F.chroma[t * 12 + c];
    const key = estimateKey(total);

    progress('done', 1);
    return {
      duration, hopTime, frameOffset, nFrames: n, silenceThr,
      soundStart, soundEnd,
      onset: F.onset, onsetLow: F.onsetLow, onsetHigh: F.onsetHigh,
      rms: F.rms, pitch: F.pitch, pitchConf: F.pitchConf, chroma: F.chroma,
      onsets, beats, bpm, tempoConfidence: tempo.confidence, downbeatPhase, sections, key
    };
  }

  return { analyze };
}

if (typeof self !== 'undefined' && typeof window !== 'undefined') self.PTAnalyzerFactory = PTAnalyzerFactory;
if (typeof module !== 'undefined') module.exports = PTAnalyzerFactory;

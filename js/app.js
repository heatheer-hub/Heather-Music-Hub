/* Screen flow: upload -> analysis -> difficulty -> gameplay -> results. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const U = PTUtil;
  const DIFF_KEYS = ['vnormal', 'vhard', 'hnormal', 'hhard'];
  const MODES = {
    vertical: { label: 'Vertical', sub: 'Portrait · falling tiles', short: 'V' },
    horizontal: { label: 'Horizontal', sub: 'Landscape · 3D track with arcs', short: 'H' }
  };
  const diffLabel = (k) => MODES[PTChart.DIFFICULTIES[k].mode].label + ' ' + PTChart.DIFFICULTIES[k].name;
  const isTouch = () => !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  const SECTION_COLORS = ['#4de1ff', '#8b5cff', '#ff6fb5', '#ffd166', '#58e6a0', '#6d8bff', '#ff9a5c'];

  const settings = Object.assign({ speedMod: 1, offsetMs: 0, difficulty: 'vnormal' }, U.store.get('bt:settings', {}));
  if (!PTChart.DIFFICULTIES[settings.difficulty]) settings.difficulty = 'vnormal';
  const state = {
    song: null,       // { title, artist, hash, buffer, fileName, size }
    analysis: null,
    analyzing: false,
    variation: 1,
    charts: {},
    player: null,
    game: null,
    lastResult: null
  };
  window.BeatTiles = { state, settings };

  function saveSettings() { U.store.set('bt:settings', settings); }

  const TAB_SCREENS = ['screen-home', 'screen-records', 'screen-rewards', 'screen-guide'];

  function show(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
    const tabbar = $('tabbar');
    tabbar.classList.toggle('hidden', !TAB_SCREENS.includes(id));
    tabbar.querySelectorAll('button').forEach(b => b.toggleAttribute('aria-current', b.dataset.screen === id));
    if (id === 'screen-home') renderHomeChip();
    if (id === 'screen-records') renderRecords();
    if (id === 'screen-rewards') renderRewards();
    if (id === 'screen-home') renderLibrary();
    window.scrollTo(0, 0);
  }

  function setStatus(msg, isError) {
    const el = $('home-status');
    el.textContent = msg || '';
    el.classList.toggle('error', !!isError);
  }

  // ---------- 1. upload ----------
  async function loadFile(file) {
    if (!file) return;
    if (state.analyzing) return;
    setStatus('Reading ' + file.name + '…');
    $('song-card').classList.add('hidden');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const song = await loadBytes(bytes, { fileName: file.name, size: file.size });
      const id = await saveToDevice(bytes, { fileName: file.name });
      if (id && state.song === song) song.libId = id;
      syncCloud();
    } catch (err) {
      showLoadError(err);
    }
  }

  // Shared by uploads and the song library: same bytes -> same hash -> same charts and bests.
  async function loadBytes(bytes, meta) {
    PTAudio.getContext();
    const hash = U.hashBytes(bytes);
    const tags = U.readId3(bytes);
    const mp3 = U.readMp3Header(bytes);
    setStatus('Decoding audio…');
    const buffer = await decodeBytes(bytes);
    const baseName = meta.fileName.replace(/\.[^.]+$/, '');
    const song = {
      title: meta.title || tags.title || baseName,
      artist: meta.artist || tags.artist || '',
      hash, buffer, fileName: meta.fileName, size: meta.size, mp3, libId: meta.libId || null
    };
    setSong(song);
    setStatus('');
    return song;
  }

  async function decodeBytes(bytes) {
    const buffer = await PTAudio.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    if (!buffer || buffer.duration < 5) throw new Error('This file is too short to make a chart (needs at least 5 seconds).');
    return buffer;
  }

  function showLoadError(err) {
    console.error(err);
    setStatus((err && err.message && !/^EncodingError|Unable to decode/i.test(err.message) ? err.message : 'Could not decode this file. Try an MP3, M4A or WAV.'), true);
  }

  function loadDemo() {
    try {
      const buffer = PTAudio.makeDemoBuffer();
      setSong({ title: 'Demo tune', artist: 'Generated in your browser · 116 BPM', hash: 0x5eed1234, buffer, fileName: 'demo', size: 0 });
      setStatus('');
    } catch (err) {
      setStatus(err.message || 'Could not create the demo.', true);
    }
  }

  function setSong(song) {
    state.song = song;
    state.analysis = null;
    state.charts = {};
    state.variation = 1;
    state.part = 'full';
    const b = song.buffer;
    $('song-title').textContent = song.title;
    $('song-artist').textContent = song.artist || song.fileName;
    const info = [
      ['Duration', U.formatTime(b.duration)],
      song.mp3 ? ['Sample rate', (song.mp3.sampleRate / 1000).toFixed(1) + ' kHz'] : ['Decoded at', (b.sampleRate / 1000).toFixed(1) + ' kHz'],
      ['Channels', (song.mp3 ? song.mp3.channels : b.numberOfChannels) === 1 ? 'Mono' : 'Stereo'],
      ['File size', song.size ? U.formatBytes(song.size) : '—'],
      ['Bitrate', song.size ? Math.round(song.size * 8 / b.duration / 1000) + ' kbps' : '—'],
      ['Format', song.size ? (song.fileName.split('.').pop() || '').toUpperCase() : 'Synth']
    ];
    $('song-info').innerHTML = info.map(([k, v]) => '<div><dt>' + k + '</dt><dd>' + esc(String(v)) + '</dd></div>').join('');
    $('song-card').classList.remove('hidden');
    if (b.duration > 20 * 60) setStatus('Long track: analysis may take a little while.');
  }

  function esc(s) {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- 2. analysis ----------
  const STAGES = ['spectrum', 'onsets', 'tempo', 'beats', 'sections'];
  const STAGE_WEIGHT = { prepare: 0, spectrum: 0, onsets: 0.84, tempo: 0.88, beats: 0.92, sections: 0.97, done: 1 };

  function setStage(stage, frac) {
    const idx = STAGES.indexOf(stage);
    document.querySelectorAll('#steps li').forEach((li, i) => {
      li.classList.toggle('done', stage === 'done' || (idx >= 0 && i < idx));
      li.classList.toggle('active', idx === i);
    });
    let p = STAGE_WEIGHT[stage] || 0;
    if (stage === 'spectrum') p = 0.02 + 0.8 * (frac || 0);
    $('analysis-progress').style.width = Math.round(p * 100) + '%';
  }

  function makeWorker() {
    const src =
      'const A = (' + PTAnalyzerFactory.toString() + ')();\n' +
      'self.onmessage = async (e) => {\n' +
      '  try {\n' +
      '    const r = await A.analyze(e.data.samples, e.data.sampleRate, (stage, f) => self.postMessage({ type: "progress", stage, f }));\n' +
      '    const tr = [r.onset, r.onsetLow, r.onsetHigh, r.rms, r.pitch, r.pitchConf, r.chroma].map(a => a.buffer);\n' +
      '    self.postMessage({ type: "done", result: r }, tr);\n' +
      '  } catch (err) { self.postMessage({ type: "error", message: String((err && err.message) || err) }); }\n' +
      '};';
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const w = new Worker(url);
    URL.revokeObjectURL(url);
    return w;
  }

  function runAnalysis(samples, sampleRate, onProgress) {
    return new Promise((resolve, reject) => {
      let worker = null;
      try { worker = makeWorker(); } catch (e) { worker = null; }
      if (!worker) {
        // Fallback: main thread, yielding so the UI keeps painting.
        const yieldFn = () => new Promise(r => setTimeout(r, 0));
        PTAnalyzerFactory().analyze(samples, sampleRate, onProgress, yieldFn).then(resolve, reject);
        return;
      }
      let settled = false;
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') onProgress(m.stage, m.f);
        else if (m.type === 'done') { settled = true; worker.terminate(); resolve(m.result); }
        else if (m.type === 'error') { settled = true; worker.terminate(); reject(new Error(m.message)); }
      };
      worker.onerror = (e) => {
        if (settled) return;
        settled = true;
        worker.terminate();
        // Some browsers refuse blob workers from file:// — fall back to the main thread.
        const yieldFn = () => new Promise(r => setTimeout(r, 0));
        PTAnalyzerFactory().analyze(samples, sampleRate, onProgress, yieldFn).then(resolve, reject);
        if (e && e.preventDefault) e.preventDefault();
      };
      const copy = samples; // already a fresh array; transfer it
      worker.postMessage({ samples: copy, sampleRate }, [copy.buffer]);
    });
  }

  // One analysis per song per session; a background pre-analysis and a tap share the same job.
  const analysisCache = new Map(); // hash -> analysis
  const analysisJobs = new Map();  // hash -> { promise, listeners }

  function getAnalysis(hash, buffer, onProgress) {
    if (analysisCache.has(hash)) return Promise.resolve(analysisCache.get(hash));
    let job = analysisJobs.get(hash);
    if (!job) {
      const listeners = new Set();
      const t0 = performance.now();
      const mono = PTAudio.toMono(buffer);
      const promise = runAnalysis(mono, buffer.sampleRate, (stage, f) => listeners.forEach(l => l(stage, f)))
        .then(r => { r.elapsed = (performance.now() - t0) / 1000; analysisCache.set(hash, r); return r; })
        .finally(() => analysisJobs.delete(hash));
      job = { promise, listeners };
      analysisJobs.set(hash, job);
    }
    if (onProgress) job.listeners.add(onProgress);
    return job.promise;
  }

  async function analyze() {
    const song = state.song;
    if (!song || state.analyzing) return;
    $('analysis-song').textContent = song.title;
    $('analysis-result').classList.add('hidden');
    $('btn-to-difficulty').disabled = true;
    $('analysis-heading').textContent = 'Analyzing…';
    show('screen-analysis');
    if (state.analysis) { showAnalysis(state.analysis); return; }
    state.analyzing = true;
    setStage('prepare', 0);
    try {
      await new Promise(r => setTimeout(r, 30)); // let the screen paint first
      const result = await getAnalysis(song.hash, song.buffer, setStage);
      if (song.libId) saveLibSummary(song.libId, song.hash, result);
      if (state.song !== song) return; // user picked another song meanwhile
      state.analysis = result;
      showAnalysis(result);
    } catch (err) {
      console.error(err);
      $('analysis-heading').textContent = 'Analysis failed';
      $('analysis-detail').textContent = err.message || String(err);
      $('analysis-result').classList.remove('hidden');
    } finally {
      state.analyzing = false;
    }
  }

  function showAnalysis(A) {
    setStage('done', 1);
    $('analysis-heading').textContent = 'Analysis complete';
    $('res-bpm').textContent = A.bpm.toFixed(A.bpm < 100 ? 1 : 0);
    $('res-key').textContent = A.key.replace(' major', '').replace(' minor', 'm');
    $('res-sections').textContent = A.sections.length;
    const labels = A.sections.map(s => s.label);
    const uniq = [...new Set(labels)];
    $('section-legend').innerHTML = A.sections.map(s => {
      const color = SECTION_COLORS[uniq.indexOf(s.label) % SECTION_COLORS.length];
      const lvl = s.energy > 0.66 ? 'intense' : s.energy > 0.33 ? 'medium' : 'calm';
      return '<span><b style="color:' + color + '">' + s.label + '</b>' + U.formatTime(s.start) + '–' + U.formatTime(s.end) + ' · ' + lvl + '</span>';
    }).join('');
    let melodic = 0, voiced = 0;
    for (let i = 0; i < A.nFrames; i++) {
      if (A.rms[i] > A.silenceThr) { voiced++; if (A.pitchConf[i] > 2.2) melodic++; }
    }
    const bars = Math.floor((A.beats.length - A.downbeatPhase) / 4);
    $('analysis-detail').textContent =
      A.beats.length + ' beats · ' + bars + ' bars · ' + A.onsets.length + ' note attacks · clear melody in ' +
      Math.round(100 * melodic / Math.max(1, voiced)) + '% of the song' +
      (A.elapsed ? ' · analyzed in ' + A.elapsed.toFixed(1) + ' s' : '');
    $('analysis-result').classList.remove('hidden');
    $('btn-to-difficulty').disabled = false;
    requestAnimationFrame(() => drawTimeline(A, uniq));
  }

  function drawTimeline(A, uniq) {
    const cv = $('timeline');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = cv.clientWidth, H = cv.clientHeight;
    if (!W) return;
    cv.width = W * dpr; cv.height = H * dpr;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const x = (t) => t / A.duration * W;
    A.sections.forEach(s => {
      const c = SECTION_COLORS[uniq.indexOf(s.label) % SECTION_COLORS.length];
      g.globalAlpha = 0.14 + 0.3 * s.energy;
      g.fillStyle = c;
      g.fillRect(x(s.start) + 1, 0, Math.max(1, x(s.end) - x(s.start) - 2), H);
      g.globalAlpha = 1;
      if (x(s.end) - x(s.start) > 16) {
        g.fillStyle = c;
        g.font = '700 11px Outfit, system-ui, sans-serif';
        g.fillText(s.label, x(s.start) + 5, 14);
      }
    });
    // RMS envelope.
    const cols = Math.floor(W / 2);
    const peak = Math.max(1e-6, ...Array.from(A.rms).filter((_, i) => i % 8 === 0));
    g.fillStyle = 'rgba(232,235,245,0.75)';
    for (let c = 0; c < cols; c++) {
      const f0 = Math.floor(c / cols * A.nFrames), f1 = Math.floor((c + 1) / cols * A.nFrames);
      let m = 0;
      for (let f = f0; f < f1; f++) m = Math.max(m, A.rms[f]);
      const h = Math.min(1, m / peak) * (H - 30);
      g.fillRect(c * 2, H / 2 + 8 - h / 2, 1.2, Math.max(1, h));
    }
  }

  // ---------- 3. difficulty ----------
  // Each song splits at the end of its first chorus: Part 1 = start to there, Part 2 = the rest.
  const PART_LABEL = { full: 'Full song', p1: 'Part 1', p2: 'Part 2' };
  const PART_DESC = { full: 'The whole song', p1: 'Start to the end of the first chorus', p2: 'After the first chorus to the end' };
  function partsFor(A) {
    if (A.split == null) A.split = PTChart.splitPoint(A);
    return [
      { id: 'full', start: 0, end: A.duration },
      { id: 'p1', start: 0, end: A.split },
      { id: 'p2', start: A.split, end: A.duration }
    ];
  }
  function sliceForPart(chart) {
    if (!state.part || state.part === 'full') return chart;
    const p = partsFor(state.analysis).find(x => x.id === state.part);
    return PTChart.slice(chart, p.start, p.end);
  }

  function chartFor(diff) {
    const key = diff + ':' + state.variation + ':' + (state.part || 'full');
    if (!state.charts[key]) {
      state.charts[key] = sliceForPart(PTChart.generate(state.analysis, diff, { seed: state.song.hash, variation: state.variation, speedMod: 1 }));
    }
    return state.charts[key];
  }


  function renderDifficulty() {
    $('diff-status').textContent = '';
    $('diff-song').textContent = state.song.title;
    const parts = partsFor(state.analysis);
    $('part-picker').innerHTML = parts.map(p =>
      '<button role="radio" data-part="' + p.id + '" aria-checked="' + (state.part === p.id) + '"><b>' + PART_LABEL[p.id] + '</b>' +
      '<span>' + U.formatTime(p.start) + '–' + U.formatTime(p.end) + '</span></button>').join('');
    $('part-note').textContent = PART_DESC[state.part || 'full'] + '.';
    const list = $('diff-list');
    list.innerHTML = '';
    let lastMode = null;
    DIFF_KEYS.forEach(k => {
      const D = PTChart.DIFFICULTIES[k];
      const c = chartFor(k);
      if (D.mode !== lastMode) {
        lastMode = D.mode;
        const head = document.createElement('div');
        head.className = 'diff-group';
        head.innerHTML = '<span class="mode-icon mode-' + D.mode + '" aria-hidden="true"></span>' +
          '<span><b>' + MODES[D.mode].label + '</b><span>' + MODES[D.mode].sub + '</span></span>';
        list.appendChild(head);
      }
      const best = PTProgress.getRecord(state.song.hash, k, state.variation, state.part);
      const btn = document.createElement('button');
      btn.className = 'diff';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', String(settings.difficulty === k));
      let stars = '';
      for (let i = 1; i <= 10; i++) stars += '<i class="' + (i <= c.stats.stars ? 'on' : '') + '"></i>';
      btn.innerHTML =
        '<div class="diff-name">' + D.name + ' <span class="lv">Lv ' + c.stats.level.toFixed(1) + '</span></div>' +
        '<div class="diff-stars" aria-label="' + c.stats.stars + ' of 10">' + stars + '</div>' +
        '<div class="diff-blurb">' + D.blurb + '</div>' +
        '<div class="diff-meta">' + c.stats.count + ' notes · ' + (D.mode === 'horizontal' ? c.stats.arcs + ' arcs' : c.stats.holds + ' holds') + '</div>' +
        (best ? '<div class="diff-best">Best ' + U.formatScore(best.score) + ' · ' + best.grade + ' · ' + PTProgress.CLEAR_LABEL[best.clear] + '</div>' : '');
      btn.addEventListener('click', () => {
        settings.difficulty = k;
        saveSettings();
        list.querySelectorAll('.diff').forEach(el => el.setAttribute('aria-checked', String(el === btn)));
      });
      list.appendChild(btn);
    });
    $('speed').value = settings.speedMod;
    $('speed-out').textContent = Number(settings.speedMod).toFixed(2).replace(/0$/, '') + '×';
    $('offset').value = settings.offsetMs;
    $('offset-out').textContent = (settings.offsetMs > 0 ? '+' : '') + settings.offsetMs + ' ms';
    $('var-out').textContent = state.variation;
  }

  function openDifficulty() {
    if (!state.analysis) return;
    renderDifficulty();
    show('screen-difficulty');
  }

  // ---------- 4. gameplay ----------
  async function play() {
    if (!state.analysis) return;
    const ctx = PTAudio.getContext();
    const resumeP = ctx.state !== 'running' ? ctx.resume() : null; // inside the tap gesture
    const diff = settings.difficulty;
    const D = PTChart.DIFFICULTIES[diff];
    const chart = sliceForPart(PTChart.generate(state.analysis, diff, { seed: state.song.hash, variation: state.variation, speedMod: settings.speedMod }));
    if (!chart.notes.length) {
      $('diff-status').textContent = 'No playable notes were found in this song on ' + PTChart.DIFFICULTIES[diff].name + '. Try another difficulty.';
      return;
    }
    if (state.game) { state.game.destroy(); state.game = null; }
    if (!state.player || state.player.buffer !== state.song.buffer) state.player = new PTAudio.SongPlayer(state.song.buffer);
    state.player.userOffset = settings.offsetMs / 1000;
    show('screen-game');
    $('pause-overlay').classList.add('hidden');
    $('key-hint').textContent = D.mode === 'horizontal'
      ? 'Floor: D F J K · Arcs and sky notes: mouse · Space to pause'
      : 'Keys: D F J K · Space to pause';
    if (resumeP) { try { await resumeP; } catch (e) { /* ignore */ } }
    if (D.mode === 'horizontal' && !(await ensureLandscape())) { openDifficulty(); return; }
    const Game = D.mode === 'horizontal' ? PTGame.HorizontalGame : PTGame.VerticalGame;
    const look = PTProgress.look();
    state.game = new Game({
      canvas: $('game-canvas'),
      chart,
      analysis: state.analysis,
      player: state.player,
      hue: look.theme.hue != null ? look.theme.hue : 200 + (state.song.hash % 130),
      sat: look.theme.sat,
      skin: look.skin,
      onEnd: (r) => showResults(r, chart),
      onPauseChange: (p) => $('pause-overlay').classList.toggle('hidden', !p),
      onResize: (game) => {
        // Horizontal mode needs landscape: turning the phone upright pauses until it turns back.
        if (D.mode !== 'horizontal' || !isTouch()) return;
        const portrait = window.innerHeight > window.innerWidth;
        if (portrait) game.pause();
        $('rotate-overlay').classList.toggle('hidden', !portrait);
      }
    });
    state.game.start();
  }

  // Resolves true once the screen is landscape (immediately on computers), false on Back.
  function ensureLandscape() {
    if (!isTouch() || window.innerWidth >= window.innerHeight) return Promise.resolve(true);
    try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {}); } catch (e) { /* optional */ }
    const overlay = $('rotate-overlay');
    $('rotate-tip').classList.toggle('hidden', !(isIOS() && !isStandalone()));
    overlay.classList.remove('hidden');
    return new Promise(resolve => {
      const done = (ok) => {
        window.removeEventListener('resize', check);
        $('btn-rotate-back').removeEventListener('click', back);
        overlay.classList.add('hidden');
        resolve(ok);
      };
      const check = () => { if (window.innerWidth >= window.innerHeight) setTimeout(() => done(true), 250); };
      const back = () => done(false);
      window.addEventListener('resize', check);
      $('btn-rotate-back').addEventListener('click', back);
    });
  }

  function quitGame() {
    if (state.game) { state.game.destroy(); state.game = null; }
    $('pause-overlay').classList.add('hidden');
    $('rotate-overlay').classList.add('hidden');
  }

  // ---------- 5. results ----------
  function showResults(r, chart) {
    const diff = chart.difficulty;
    const D = PTChart.DIFFICULTIES[diff];
    state.lastResult = r;
    if (state.game) { state.game.destroy(); state.game = null; }
    const rw = PTProgress.recordPlay({
      hash: state.song.hash, title: state.song.title, diff, mode: D.mode,
      variation: state.variation, part: state.part, level: chart.stats.level, result: r
    });
    state.lastRewards = rw;
    const rec = PTProgress.getRecord(state.song.hash, diff, state.variation, state.part);

    $('r-grade').textContent = rw.grade;
    $('r-grade').className = 'grade g-' + rw.grade;
    const banner = { fail: 'TRACK LOST', clear: 'TRACK COMPLETE', fc: 'FULL COMBO', ap: 'ALL PERFECT' }[rw.clear];
    $('r-clear').textContent = banner;
    $('r-clear').className = 'clear-banner ' + rw.clear;
    $('r-gauge').textContent = 'Clear gauge ' + Math.floor(r.gauge) + '%' + (rw.clear === 'fail' ? ' (70% needed to clear)' : '');
    $('r-song').textContent = state.song.title;
    $('r-diff').textContent = (state.part !== 'full' ? PART_LABEL[state.part] + ' · ' : '') + diffLabel(diff) + ' · Lv ' + chart.stats.level.toFixed(1) + (state.variation > 1 ? ' · variation ' + state.variation : '') +
      ' · ' + r.notes + ' notes' + (r.arcs ? ' · ' + r.arcs + ' arcs' : '');
    $('r-score').textContent = U.formatScore(r.score);
    $('r-acc').textContent = r.accuracy.toFixed(2) + '%';
    $('r-combo').textContent = r.maxCombo;
    $('r-best').textContent = U.formatScore(rec ? rec.score : r.score);
    $('r-badges').innerHTML = (rw.newBest && rw.prevBest != null ? '<span class="badge">NEW BEST +' + U.formatScore(r.score - rw.prevBest) + '</span>' : '');
    const rows = [['Perfect', r.perfect, 'var(--perfect)'], ['Great', r.great, 'var(--great)'], ['Good', r.good, 'var(--good)'], ['Miss', r.miss, 'var(--miss)']];
    $('r-judges').innerHTML = rows.map(([name, n, c]) =>
      '<div class="judge-row"><span style="color:' + c + '">' + name + '</span>' +
      '<div class="judge-bar"><i style="width:' + (r.total ? n / r.total * 100 : 0) + '%;background:' + c + '"></i></div>' +
      '<span class="n">' + n + '</span></div>').join('');

    // Rewards.
    const lv = rw.level;
    const dr = rw.ratingAfter - rw.ratingBefore;
    let html = '<h2>Rewards</h2><div class="reward-lines">' +
      '<div class="reward"><span>EXP</span><b>+' + rw.exp + '</b></div>' +
      '<div class="reward"><span>Coins</span><b>+' + rw.coins + '</b></div>';
    for (const b of rw.bonuses) if (!/^Achievement: /.test(b.label)) html += '<div class="reward bonus"><span>' + esc(b.label) + '</span><b>+' + b.coins + '</b></div>';
    if (rw.unlocked.length) html += '<div class="reward bonus"><span>Achievements (' + rw.unlocked.length + ')</span><b>+' + rw.unlocked.reduce((a, x) => a + x.reward, 0) + '</b></div>';
    html += '</div>';
    if (rw.clear === 'fail') html += '<p class="fine">Clear the chart (gauge 70% or more) to earn coins.</p>';
    html += '<div class="lv-row"><div class="lv-badge small"><span>LV</span>' + lv.level + '</div><div class="profile-main">' +
      '<div class="exp-bar"><i style="width:' + (lv.into / lv.need * 100).toFixed(1) + '%"></i></div>' +
      '<div class="fine">' + (rw.levelAfter > rw.levelBefore ? 'Level up! ' : '') + lv.into + ' / ' + lv.need + ' EXP</div></div></div>' +
      '<p class="fine">This play rates <b>' + rw.playRating.toFixed(2) + '</b>. Rating ' + rw.ratingBefore.toFixed(2) + ' → <b>' + rw.ratingAfter.toFixed(2) + '</b>' +
      (dr > 0.0049 ? ' <span class="up">(+' + dr.toFixed(2) + ')</span>' : '') + '.</p>';
    if (rw.unlocked.length) {
      html += '<div class="unlocks">' + rw.unlocked.map(a => '<div class="unlock"><b>Achievement unlocked: ' + a.name + ' <em>+' + a.reward + ' coins</em></b><span>' + a.desc + '</span></div>').join('') + '</div>';
    }
    $('r-rewards').innerHTML = html;

    let timing = r.holds ? 'Holds completed: ' + r.holdsDone + ' / ' + r.holds + '. ' : '';
    const applyBtn = $('btn-apply-offset');
    applyBtn.classList.add('hidden');
    if (r.meanOffsetMs != null) {
      const m = Math.round(r.meanOffsetMs);
      timing += 'Average timing: ' + (m === 0 ? 'spot on' : Math.abs(m) + ' ms ' + (m > 0 ? 'late' : 'early')) + '.';
      if (Math.abs(m) >= 20) {
        const suggested = U.clamp(Math.round((settings.offsetMs + m) / 5) * 5, -150, 400);
        timing += ' Suggested audio offset: ' + (suggested > 0 ? '+' : '') + suggested + ' ms.';
        applyBtn.dataset.value = suggested;
        applyBtn.classList.remove('hidden');
      }
    }
    $('r-timing').textContent = timing;
    show('screen-results');
  }

  // ---------- song library ----------
  // Two sources: songs packed from the Songs/ folder by tools/build_library.py, and songs saved
  // on this device (IndexedDB). Saved songs are how music gets into the phone app.
  const PACKED = window.BeatTilesLibrary && Array.isArray(window.BeatTilesLibrary.songs)
    ? window.BeatTilesLibrary.songs.map(s => Object.assign({ source: 'pack' }, s)) : [];
  const canFetch = /^https?:$/.test(location.protocol);
  const pendingBundles = new Map(); // id -> { resolve, reject }
  const bundleLoads = new Map();    // id -> Promise<Uint8Array>, shared by concurrent callers
  const libBusy = new Map();        // id -> 'loading' | 'analyzing'
  let deviceSongs = [];             // metadata of songs saved on this device
  let confirmRemove = null;         // id of a saved song whose remove button awaits a second tap

  // Minimal IndexedDB store: 'meta' (song info) and 'audio' (file bytes, keyed by song id).
  let dbPromise = null;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        if (!window.indexedDB) { reject(new Error('This browser cannot save songs.')); return; }
        const r = indexedDB.open('beattiles', 1);
        r.onupgradeneeded = () => {
          r.result.createObjectStore('meta', { keyPath: 'id' });
          r.result.createObjectStore('audio');
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      dbPromise.catch(() => { dbPromise = null; });
    }
    return dbPromise;
  }
  function idbReq(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
  function idbDone(t) { return new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); }

  async function loadDeviceSongs() {
    try {
      const d = await db();
      deviceSongs = (await idbReq(d.transaction('meta').objectStore('meta').getAll()))
        .sort((a, b) => a.added - b.added)
        .map(m => Object.assign({ source: 'device' }, m));
    } catch (e) { deviceSongs = []; }
  }

  function deviceId(hash, size) { return 'd' + hash.toString(16) + '-' + size; }

  // Keep a copy of an uploaded song on this device so it shows up under My Songs next time.
  async function saveToDevice(bytes, meta) {
    const id = deviceId(U.hashBytes(bytes), bytes.length);
    if (deviceSongs.some(s => s.id === id)) return id;
    if (PACKED.some(s => s.size === bytes.length && s.file === meta.fileName)) return null;
    const tags = U.readId3(bytes);
    const rec = {
      id, file: meta.fileName, size: bytes.length, added: Date.now(),
      title: meta.title || tags.title || meta.fileName.replace(/\.[^.]+$/, ''), artist: meta.artist || tags.artist || '',
      cloudPath: meta.cloudPath || null
    };
    try {
      const d = await db();
      const t = d.transaction(['meta', 'audio'], 'readwrite');
      t.objectStore('audio').put(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), id);
      t.objectStore('meta').put(rec);
      await idbDone(t);
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      deviceSongs.push(Object.assign({ source: 'device' }, rec));
      renderLibrary();
      return id;
    } catch (e) {
      console.warn('Could not save song on this device', e);
      return null;
    }
  }

  async function removeDeviceSong(id) {
    try {
      const d = await db();
      const t = d.transaction(['meta', 'audio'], 'readwrite');
      t.objectStore('meta').delete(id);
      t.objectStore('audio').delete(id);
      await idbDone(t);
    } catch (e) { console.warn(e); }
    deviceSongs = deviceSongs.filter(s => s.id !== id);
    renderLibrary();
  }

  // Add several files at once (no playback); used when more than one file is picked or dropped.
  async function importFiles(files) {
    let added = 0;
    for (const f of files) {
      if (!/\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|webm)$/i.test(f.name) && !/^audio\//.test(f.type)) continue;
      setStatus('Adding ' + f.name + '…');
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (await saveToDevice(bytes, { fileName: f.name })) added++;
    }
    setStatus(added ? 'Added ' + added + (added === 1 ? ' song' : ' songs') + ' to My Songs.' : 'Those songs are already in My Songs.');
    syncCloud();
  }

  // A song pack (made by tools/build_library.py) carries every song of the Songs folder in one file:
  // "HMHPACK1" + header length (uint32 LE) + JSON header + the audio files back to back.
  async function importPack(file) {
    if (!file) return;
    setStatus('Opening ' + file.name + '…');
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      if (buf.length < 12 || new TextDecoder().decode(buf.subarray(0, 8)) !== 'HMHPACK1') throw new Error('This is not a Heather Music Hub song pack.');
      const hlen = new DataView(buf.buffer, buf.byteOffset + 8, 4).getUint32(0, true);
      const header = JSON.parse(new TextDecoder().decode(buf.subarray(12, 12 + hlen)));
      const base = 12 + hlen;
      let added = 0;
      for (const s of header.songs) {
        setStatus('Adding ' + s.title + '…');
        const bytes = buf.slice(base + s.offset, base + s.offset + s.size);
        if (await saveToDevice(bytes, { fileName: s.file, title: s.title, artist: s.artist })) added++;
      }
      setStatus(added ? 'Imported ' + added + (added === 1 ? ' song' : ' songs') + ' into My Songs.' : 'Every song in this pack is already in My Songs.');
      syncCloud();
    } catch (err) {
      showLoadError(err);
    }
  }

  function allSongs() { return PACKED.concat(deviceSongs, cloudOnly()); }

  function loadBundle(entry) {
    if (bundleLoads.has(entry.id)) return bundleLoads.get(entry.id);
    const p = new Promise((resolve, reject) => {
      pendingBundles.set(entry.id, { resolve, reject });
      const el = document.createElement('script');
      el.src = entry.bundle;
      el.onload = () => el.remove();
      el.onerror = () => {
        el.remove();
        pendingBundles.delete(entry.id);
        reject(new Error('Could not load "' + entry.file + '". Run tools/build_library.py again.'));
      };
      document.head.appendChild(el);
    }).finally(() => bundleLoads.delete(entry.id));
    bundleLoads.set(entry.id, p);
    return p;
  }

  function receiveBundle(id, b64) {
    const p = pendingBundles.get(id);
    if (!p) return;
    pendingBundles.delete(id);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    p.resolve(bytes);
  }

  async function loadEntryBytes(entry) {
    if (entry.source === 'cloud') {
      const bytes = await PTCloud.download(entry.cloudPath);
      await saveToDevice(bytes, { fileName: entry.file, title: entry.title, cloudPath: entry.cloudPath });
      return bytes;
    }
    if (entry.source === 'device') {
      const d = await db();
      const buf = await idbReq(d.transaction('audio').objectStore('audio').get(entry.id));
      if (!buf) throw new Error('This saved song is missing. Remove it and add it again.');
      return new Uint8Array(buf);
    }
    if (canFetch && entry.url) {
      try {
        const r = await fetch(entry.url);
        if (r.ok) return new Uint8Array(await r.arrayBuffer());
      } catch (e) { /* fall back to the packed bundle */ }
    }
    if (!entry.bundle) throw new Error('Could not load "' + entry.file + '".');
    return loadBundle(entry);
  }

  function saveLibSummary(id, hash, A) {
    U.store.set('bt:lib:' + id, { hash, duration: A.duration, bpm: A.bpm, key: A.key, sections: A.sections.length, split: PTChart.splitPoint(A) });
    renderLibrary();
  }

  function bestFor(hash, part) {
    let best = null;
    for (const r of Object.values(PTProgress.load().records)) {
      if (r.hash === hash && (r.part || 'full') === part && (!best || r.score > best.score)) best = r;
    }
    return best;
  }

  function bestForHash(hash) {
    const best = bestFor(hash, 'full');
    return best && PTChart.DIFFICULTIES[best.diff] ? { grade: best.grade, diff: MODES[best.mode].short + ' · ' + PTChart.DIFFICULTIES[best.diff].name } : null;
  }


  function renderLibrary() {
    if (typeof renderCloud === 'function' && PTCloud.config()) renderCloud();
    const songs = allSongs();
    $('library').classList.toggle('hidden', !songs.length);
    const dz = $('dropzone');
    dz.classList.toggle('compact', songs.length > 0);
    dz.querySelector('.drop-title').textContent = songs.length ? 'Add songs' : 'Choose a song';
    if (!songs.length) return;
    $('library-count').textContent = songs.length + (songs.length === 1 ? ' song' : ' songs');
    const list = $('lib-list');
    list.innerHTML = '';
    songs.forEach(entry => {
      const sum = U.store.get('bt:lib:' + entry.id, null);
      const busy = libBusy.get(entry.id);
      const ready = sum && analysisCache.has(sum.hash);
      const item = document.createElement('div');
      item.className = 'lib-item';
      const row = document.createElement('button');
      row.className = 'lib-row';
      row.dataset.id = entry.id;
      const hue = 180 + (parseInt(entry.id.replace(/[^0-9a-f]/g, '').slice(0, 4) || '0', 16) % 150);
      const sub = [entry.artist];
      if (entry.source === 'cloud') sub.push('In the cloud', U.formatBytes(entry.size), 'tap to download');
      else if (sum) sub.push(U.formatTime(sum.duration), Math.round(sum.bpm) + ' BPM');
      else sub.push(U.formatBytes(entry.size));
      const best = sum ? bestForHash(sum.hash) : null;
      let side = '';
      if (busy) side = '<span class="lib-spin" aria-label="' + busy + '"></span>';
      else if (best) side = '<span class="lib-grade">' + best.grade + '</span><span class="lib-diff">' + best.diff + '</span>';
      else if (ready) side = '<span class="lib-ready">Ready</span>';
      row.innerHTML =
        '<span class="lib-art' + (entry.source === 'cloud' ? ' cloud' : '') + '" style="--h:' + hue + '"></span>' +
        '<span class="lib-main"><span class="lib-title">' + esc(entry.title) + '</span>' +
        '<span class="lib-sub">' + esc(sub.filter(Boolean).join(' · ')) + (busy === 'analyzing' ? ' · analyzing…' : '') + '</span></span>' +
        '<span class="lib-side">' + side + '</span>';
      row.addEventListener('click', () => openLibrarySong(entry, 'full'));
      item.appendChild(row);
      if (entry.source === 'device') {
        const rm = document.createElement('button');
        const armed = confirmRemove === entry.id;
        rm.className = 'lib-remove' + (armed ? ' armed' : '');
        rm.setAttribute('aria-label', 'Remove ' + entry.title);
        rm.textContent = armed ? 'Remove' : '×';
        rm.addEventListener('click', () => {
          if (confirmRemove === entry.id) { confirmRemove = null; removeDeviceSong(entry.id); return; }
          confirmRemove = entry.id;
          renderLibrary();
          setTimeout(() => { if (confirmRemove === entry.id) { confirmRemove = null; renderLibrary(); } }, 3000);
        });
        item.appendChild(rm);
      }
      list.appendChild(item);
      // Part 1 / Part 2 sit under their song.
      const split = sum && sum.split;
      for (const pid of ['p1', 'p2']) {
        const sub = document.createElement('button');
        sub.className = 'lib-part';
        const range = split ? (pid === 'p1' ? '0:00–' + U.formatTime(split) : U.formatTime(split) + '–' + U.formatTime(sum.duration)) : '';
        const pb = sum ? bestFor(sum.hash, pid) : null;
        sub.innerHTML = '<span class="lib-part-dot" aria-hidden="true"></span>' +
          '<span class="lib-part-main"><span class="lib-part-name">' + PART_LABEL[pid] + '</span>' +
          '<span class="lib-part-sub">' + PART_DESC[pid] + (range ? ' · ' + range : '') + '</span></span>' +
          (pb ? '<span class="lib-grade small">' + pb.grade + '</span>' : '');
        sub.addEventListener('click', () => openLibrarySong(entry, pid));
        list.appendChild(sub);
      }
    });
  }

  async function openLibrarySong(entry, part) {
    if (state.analyzing || libBusy.get(entry.id) === 'loading') return;
    // Unlock audio inside the tap so playback can start later without another gesture.
    const ctx = PTAudio.getContext();
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    libBusy.set(entry.id, 'loading');
    renderLibrary();
    setStatus('Loading ' + entry.title + '…');
    try {
      const bytes = await loadEntryBytes(entry);
      // A cloud song becomes a saved song once downloaded: keep its summary under the saved id.
      const libId = entry.source === 'cloud' ? deviceId(U.hashBytes(bytes), bytes.length) : entry.id;
      const song = await loadBytes(bytes, { fileName: entry.file, size: entry.size, title: entry.title, artist: entry.artist, libId });
      state.part = part || 'full';
      libBusy.delete(entry.id);
      renderLibrary();
      if (analysisCache.has(song.hash)) {
        state.analysis = analysisCache.get(song.hash);
        openDifficulty();
      } else {
        analyze();
      }
    } catch (err) {
      libBusy.delete(entry.id);
      renderLibrary();
      showLoadError(err);
    }
  }

  // On computers, analyze every library song in the background, one at a time, so a tap goes
  // straight to difficulty selection. Pauses while a game runs. Skipped on phones to save
  // memory and battery: there a song is analyzed when you tap it.
  async function preanalyzeLibrary() {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (const entry of allSongs()) {
      const sum = U.store.get('bt:lib:' + entry.id, null);
      if (sum && analysisCache.has(sum.hash)) continue;
      while (state.game || state.analyzing || libBusy.size) await sleep(1000);
      if (!allSongs().includes(entry)) continue;
      if (state.song && state.song.libId === entry.id && state.analysis) continue;
      libBusy.set(entry.id, 'analyzing');
      renderLibrary();
      try {
        const bytes = await loadEntryBytes(entry);
        const hash = U.hashBytes(bytes);
        if (!analysisCache.has(hash)) {
          const buffer = await decodeBytes(bytes);
          const A = await getAnalysis(hash, buffer, null);
          libBusy.delete(entry.id);
          saveLibSummary(entry.source === 'cloud' ? deviceId(hash, bytes.length) : entry.id, hash, A);
        }
      } catch (err) {
        console.warn('Background analysis failed for', entry.file, err);
      }
      libBusy.delete(entry.id);
      renderLibrary();
    }
  }

  // ---------- cloud library (private GitHub repository, see js/cloud.js) ----------
  let cloudFiles = [];                       // songs in the cloud: { name, path, size, sha }
  const cloud = { busy: false, msg: '', error: '', syncedAt: 0, confirmDisconnect: false };

  function cloudMatch(f, s) {
    return (s.cloudPath && s.cloudPath === f.path) || (s.size === f.size && PTCloud.cleanName(s.file) === f.name);
  }
  // Cloud songs this device has not downloaded yet.
  function cloudOnly() {
    if (!PTCloud.config()) return [];
    return cloudFiles
      .filter(f => !deviceSongs.some(s => cloudMatch(f, s)) && !PACKED.some(s => cloudMatch(f, s)))
      .map(f => ({
        source: 'cloud', id: 'c' + U.hashBytes(new TextEncoder().encode(f.path)).toString(16),
        file: f.name, title: f.name.replace(/\.[^.]+$/, ''), artist: '', size: f.size, cloudPath: f.path
      }));
  }

  async function setCloudPath(song, path) {
    song.cloudPath = path;
    try {
      const d = await db();
      const t = d.transaction('meta', 'readwrite');
      const rec = Object.assign({}, song);
      delete rec.source;
      t.objectStore('meta').put(rec);
      await idbDone(t);
    } catch (e) { /* the file-name match still finds it next time */ }
  }

  function setCloudMsg(msg) { cloud.msg = msg; renderCloud(); }

  // List the cloud, then upload every song on this device that is not there yet.
  async function syncCloud() {
    if (!PTCloud.config() || cloud.busy) return;
    cloud.busy = true;
    cloud.error = '';
    try {
      setCloudMsg('Checking the cloud…');
      cloudFiles = await PTCloud.list();
      renderLibrary();
      const todo = deviceSongs.concat(PACKED).filter(s => !cloudFiles.some(f => cloudMatch(f, s)));
      for (let i = 0; i < todo.length; i++) {
        const s = todo[i];
        setCloudMsg('Uploading ' + s.title + ' (' + (i + 1) + ' of ' + todo.length + ')…');
        const bytes = await loadEntryBytes(s);
        const up = await PTCloud.upload(s.file, bytes);
        if (!cloudFiles.some(f => f.path === up.path)) cloudFiles.push({ name: up.path.split('/').pop(), path: up.path, size: bytes.length, sha: up.sha });
        if (s.source === 'device') await setCloudPath(s, up.path);
      }
      cloud.syncedAt = Date.now();
      cloud.msg = '';
    } catch (e) {
      cloud.error = e.message || String(e);
      cloud.msg = '';
    } finally {
      cloud.busy = false;
      renderCloud();
      renderLibrary();
    }
  }

  async function downloadAllCloud() {
    const list = cloudOnly();
    if (!list.length || cloud.busy) return;
    cloud.busy = true;
    cloud.error = '';
    try {
      for (let i = 0; i < list.length; i++) {
        setCloudMsg('Downloading ' + list[i].title + ' (' + (i + 1) + ' of ' + list.length + ')…');
        await loadEntryBytes(list[i]);
      }
      cloud.msg = '';
    } catch (e) {
      cloud.error = e.message || String(e);
      cloud.msg = '';
    } finally {
      cloud.busy = false;
      renderCloud();
      renderLibrary();
    }
  }

  function renderCloud() {
    const card = $('cloud-card');
    const cfg = PTCloud.config();
    if (!cfg) {
      card.innerHTML =
        '<div class="cloud-head"><span class="cloud-icon" aria-hidden="true"></span><div class="cloud-text">' +
        '<b>Cloud library</b><span>Keep your songs online, so songs you add on your computer also show up on your phone.</span></div></div>' +
        '<div class="btn-row"><button class="btn small primary" data-cloud="setup">Set up</button></div>';
      return;
    }
    const pending = cloudOnly().length;
    const line = cloud.msg || (cloudFiles.length + (cloudFiles.length === 1 ? ' song' : ' songs') + ' online' +
      (pending ? ' · ' + pending + ' not on this device yet' : ' · all on this device') +
      (cloud.syncedAt ? ' · synced ' + new Date(cloud.syncedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''));
    card.innerHTML =
      '<div class="cloud-head"><span class="cloud-icon on" aria-hidden="true"></span><div class="cloud-text">' +
      '<b>Cloud library</b><span>' + esc(cfg.repo) + '</span><span class="cloud-line">' + esc(line) + '</span></div>' +
      (cloud.busy ? '<span class="lib-spin" aria-label="syncing"></span>' : '') + '</div>' +
      (cloud.error ? '<p class="status error cloud-error">' + esc(cloud.error) + '</p>' : '') +
      '<div class="btn-row">' +
      '<button class="btn small" data-cloud="sync"' + (cloud.busy ? ' disabled' : '') + '>Sync now</button>' +
      (pending ? '<button class="btn small primary" data-cloud="download"' + (cloud.busy ? ' disabled' : '') + '>Download all (' + pending + ')</button>' : '') +
      '<button class="btn small ghost" data-cloud="disconnect">' + (cloud.confirmDisconnect ? 'Tap again to disconnect' : 'Disconnect') + '</button>' +
      '</div>';
  }

  function openCloudDialog() {
    const cfg = PTCloud.config();
    $('cloud-repo').value = cfg ? cfg.repo : ($('cloud-repo').value || '');
    $('cloud-token').value = '';
    $('cloud-dialog-status').textContent = '';
    $('cloud-dialog').classList.remove('hidden');
  }

  async function connectCloud() {
    const btn = $('btn-cloud-connect');
    btn.disabled = true;
    $('cloud-dialog-status').classList.remove('error');
    $('cloud-dialog-status').textContent = 'Connecting…';
    try {
      await PTCloud.connect($('cloud-repo').value, $('cloud-token').value);
      $('cloud-token').value = '';
      $('cloud-dialog').classList.add('hidden');
      renderCloud();
      syncCloud();
    } catch (e) {
      $('cloud-dialog-status').classList.add('error');
      $('cloud-dialog-status').textContent = e.message || String(e);
    } finally {
      btn.disabled = false;
    }
  }

  function onCloudCard(e) {
    const b = e.target.closest('[data-cloud]');
    if (!b) return;
    const action = b.dataset.cloud;
    if (action === 'setup') openCloudDialog();
    else if (action === 'sync') syncCloud();
    else if (action === 'download') downloadAllCloud();
    else if (action === 'disconnect') {
      if (!cloud.confirmDisconnect) {
        cloud.confirmDisconnect = true;
        renderCloud();
        setTimeout(() => { cloud.confirmDisconnect = false; renderCloud(); }, 3000);
        return;
      }
      cloud.confirmDisconnect = false;
      PTCloud.disconnect();
      cloudFiles = [];
      cloud.error = '';
      renderCloud();
      renderLibrary();
    }
  }

  async function initLibrary() {
    if (window.BeatTilesLibrary) window.BeatTilesLibrary.receive = receiveBundle;
    renderLibrary();
    await loadDeviceSongs();
    renderLibrary();
    renderCloud();
    await syncCloud();
    const phone = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    if (!phone && allSongs().length) setTimeout(preanalyzeLibrary, 600);
  }

  function registerServiceWorker() {
    // Makes the hosted app installable and playable offline. Not available from file:// or
    // inside another page's frame (e.g. the claude.ai viewer).
    try {
      if (!('serviceWorker' in navigator) || !window.isSecureContext || !canFetch || window.top !== window) return;
      navigator.serviceWorker.register('sw.js').catch(err => console.warn('Service worker not registered', err));
    } catch (e) { /* optional */ }
  }

  // ---------- audio sync test ----------
  // Plays clicks and records when you tap along. The median delay between hearing a click and
  // tapping is exactly what the audio offset must absorb (Bluetooth headphones add 150–250 ms).
  const CALIB = { bpm: 100, clicks: 16, lead: 1.2, skip: 3 };
  let calib = null;

  function clickBuffer() {
    const ctx = PTAudio.getContext();
    const sr = ctx.sampleRate, beat = 60 / CALIB.bpm;
    const len = Math.ceil((CALIB.lead + CALIB.clicks * beat + 0.5) * sr);
    const buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    for (let k = 0; k < CALIB.clicks; k++) {
      const s0 = Math.round((CALIB.lead + k * beat) * sr);
      const f = k % 4 === 0 ? 1500 : 1000;
      for (let i = 0; i < 0.05 * sr && s0 + i < len; i++) d[s0 + i] = 0.8 * Math.sin(2 * Math.PI * f * i / sr) * Math.exp(-i / sr * 60);
    }
    return buf;
  }

  function openCalib() {
    $('calib-result').textContent = '';
    $('calib-count').textContent = 'Tap the circle on every click.';
    $('btn-calib-start').disabled = false;
    $('btn-calib-start').textContent = 'Start';
    $('calib').classList.remove('hidden');
  }

  function closeCalib() {
    if (calib) { calib.player.stop(); clearTimeout(calib.timer); calib = null; }
    $('calib').classList.add('hidden');
  }

  function startCalib() {
    const ctx = PTAudio.getContext();
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    if (calib) { calib.player.stop(); clearTimeout(calib.timer); }
    const player = new PTAudio.SongPlayer(clickBuffer());
    player.userOffset = 0;
    player.play(-0.2);
    const beat = 60 / CALIB.bpm;
    calib = { player, taps: [], timer: setTimeout(finishCalib, (0.2 + CALIB.lead + CALIB.clicks * beat + 0.7) * 1000) };
    $('btn-calib-start').disabled = true;
    $('btn-calib-start').textContent = 'Listening…';
    $('calib-result').textContent = '';
    $('calib-count').textContent = 'Taps: 0';
  }

  function calibTap(e) {
    e.preventDefault();
    if (!calib) return;
    const beat = 60 / CALIB.bpm;
    const t = calib.player.timeAtEvent(e);
    const k = Math.round((t - CALIB.lead) / beat);
    if (k < CALIB.skip || k >= CALIB.clicks) { $('calib-count').textContent = 'Taps: ' + calib.taps.length; return; }
    const dt = t - (CALIB.lead + k * beat);
    if (Math.abs(dt) < beat * 0.45) calib.taps.push(dt);
    $('calib-count').textContent = 'Taps: ' + calib.taps.length;
    const pad = $('calib-pad');
    pad.classList.remove('hit'); void pad.offsetWidth; pad.classList.add('hit');
  }

  function finishCalib() {
    if (!calib) return;
    const taps = calib.taps.slice().sort((a, b) => a - b);
    calib.player.stop();
    calib = null;
    $('btn-calib-start').disabled = false;
    $('btn-calib-start').textContent = 'Try again';
    if (taps.length < 6) {
      $('calib-result').textContent = 'Only ' + taps.length + ' taps counted. Tap once on every click after the first few, then try again.';
      return;
    }
    const med = taps[taps.length >> 1] * 1000;
    const ms = U.clamp(Math.round(med / 5) * 5, -150, 400);
    settings.offsetMs = ms;
    saveSettings();
    $('offset').value = ms;
    $('offset-out').textContent = (ms > 0 ? '+' : '') + ms + ' ms';
    $('calib-result').textContent = Math.abs(med) < 15
      ? 'Your taps land right on the clicks (' + Math.round(med) + ' ms). Audio offset set to ' + ms + ' ms.'
      : 'Your taps land ' + Math.abs(Math.round(med)) + ' ms ' + (med > 0 ? 'after' : 'before') + ' the clicks. Audio offset set to ' + (ms > 0 ? '+' : '') + ms + ' ms.';
  }

  // ---------- install hint (iPhone Safari) ----------
  function isIOS() { return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
  function isStandalone() { return navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches); }
  function renderInstallHint() {
    const show = isIOS() && !isStandalone() && window.top === window && !U.store.get('hmh:hideInstall', false);
    $('install-card').classList.toggle('hidden', !show);
  }

  // ---------- records, rewards and guide tabs ----------
  const DIFF_SHORT = { vnormal: 'V · Normal', vhard: 'V · Hard', hnormal: 'H · Normal', hhard: 'H · Hard' };
  const CLEAR_BADGE = { fc: 'FC', ap: 'AP', fail: 'LOST' };

  function timeAgo(ms) {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return Math.floor(s / 86400) + ' d ago';
  }

  function renderHomeChip() {
    const p = PTProgress.load();
    const lv = PTProgress.levelInfo(p.exp);
    $('home-chip').innerHTML = '<span>Lv <b>' + lv.level + '</b></span><span>Rating <b>' + PTProgress.rating().toFixed(2) + '</b></span><span><b>' + p.coins + '</b> coins</span>';
  }

  function levelBlock(lv, coins) {
    return '<div class="lv-badge"><span>LV</span>' + lv.level + '</div>' +
      '<div class="profile-main"><div class="profile-rating"><span>Rating</span><b>' + PTProgress.rating().toFixed(2) + '</b></div>' +
      '<div class="exp-bar"><i style="width:' + (lv.into / lv.need * 100).toFixed(1) + '%"></i></div>' +
      '<div class="fine">' + lv.into + ' / ' + lv.need + ' EXP to level ' + (lv.level + 1) + ' · ' + coins + ' coins</div></div>';
  }

  function renderRecords() {
    const p = PTProgress.load();
    $('profile-card').innerHTML = levelBlock(PTProgress.levelInfo(p.exp), p.coins);
    const t = p.totals;
    $('profile-stats').innerHTML = [['Plays', t.plays], ['Clears', t.clears], ['Full combos', t.fcs], ['All perfect', t.aps]]
      .map(([k, v]) => '<div class="stat"><div class="stat-val">' + v + '</div><div class="stat-lbl">' + k + '</div></div>').join('');

    // Best record per song and chart (across variations).
    const songs = new Map();
    for (const r of Object.values(p.records)) {
      let s = songs.get(r.hash);
      if (!s) songs.set(r.hash, s = { title: r.title, last: 0, parts: {} });
      s.last = Math.max(s.last, r.lastPlayed || 0);
      const charts = s.parts[r.part || 'full'] || (s.parts[r.part || 'full'] = {});
      const cur = charts[r.diff];
      if (!cur || r.score > cur.score || PTProgress.CLEAR_RANK[r.clear] > PTProgress.CLEAR_RANK[cur.clear]) charts[r.diff] = r;
    }
    const list = [...songs.values()].sort((a, b) => b.last - a.last);
    $('records-list').innerHTML = list.length ? list.map(s =>
      '<div class="card rec-song"><div class="rec-title">' + esc(s.title) + '</div>' +
      ['full', 'p1', 'p2'].filter(pid => s.parts[pid]).map(pid => '<div class="rec-part">' + PART_LABEL[pid] + '</div><div class="rec-grid">' +
      DIFF_KEYS.map(k => {
        const r = s.parts[pid][k];
        if (!r) return '<div class="rec-cell empty"><span class="rec-diff">' + DIFF_SHORT[k] + '</span><span class="rec-score">not played</span></div>';
        return '<div class="rec-cell"><span class="rec-diff">' + DIFF_SHORT[k] + '</span>' +
          '<span class="rec-line"><b class="g g-' + r.grade + '">' + r.grade + '</b>' +
          (CLEAR_BADGE[r.clear] ? '<span class="rec-badge ' + r.clear + '">' + CLEAR_BADGE[r.clear] + '</span>' : '') + '</span>' +
          '<span class="rec-score">' + U.formatScore(r.score) + ' · ' + r.plays + (r.plays === 1 ? ' play' : ' plays') + '</span></div>';
      }).join('') + '</div>').join('') + '</div>').join('')
      : '<div class="card empty-note">No plays yet. Finish a chart and your best scores show up here.</div>';

    $('history-list').innerHTML = p.history.length ? p.history.slice(0, 12).map(h =>
      '<div class="hist-row"><div class="hist-main"><span class="hist-title">' + esc(h.title) + '</span>' +
      '<span class="hist-sub">' + (h.part && h.part !== 'full' ? PART_LABEL[h.part] + ' · ' : '') + (DIFF_SHORT[h.diff] || h.diff) + ' · ' + timeAgo(h.at) + '</span></div>' +
      '<div class="hist-side"><b class="g g-' + h.grade + '">' + h.grade + '</b><span>' + U.formatScore(h.score) + '</span>' +
      (h.clear === 'fail' ? '<span class="rec-badge fail">LOST</span>' : '') + '</div></div>').join('')
      : '<p class="fine">Your last 12 plays appear here.</p>';
  }

  function shopButton(item) {
    const st = PTProgress.itemState(item);
    if (st.equipped) return '<button class="btn small" disabled>Equipped</button>';
    if (st.owned) return '<button class="btn small primary" data-equip="' + item.id + '">Equip</button>';
    if (st.locked) {
      const a = PTProgress.ACHIEVEMENTS.find(x => x.id === item.requires);
      return '<button class="btn small" disabled>Unlock: ' + esc(a ? a.name : 'achievement') + '</button>';
    }
    return '<button class="btn small" data-buy="' + item.id + '"' + (st.affordable ? '' : ' disabled') + '>' + item.price + ' coins</button>';
  }

  function renderRewards(msg) {
    const p = PTProgress.load();
    $('wallet').innerHTML = levelBlock(PTProgress.levelInfo(p.exp), p.coins) + (msg ? '<p class="status wallet-msg">' + esc(msg) + '</p>' : '');
    $('shop-skins').innerHTML = PTProgress.SHOP.filter(i => i.type === 'skin').map(item => {
      const skin = PTProgress.SKINS[item.key];
      const tiles = [['Tap', skin.tap], ['Hold', skin.hold], ['Flick', skin.flick]].map(([k, c]) => '<i title="' + k + '" style="background:' + c + '"></i>').join('');
      return '<div class="shop-item"><div class="skin-preview">' + tiles + '</div><div class="shop-name">' + skin.name + '</div>' + shopButton(item) + '</div>';
    }).join('');
    $('shop-themes').innerHTML = PTProgress.SHOP.filter(i => i.type === 'theme').map(item => {
      const th = PTProgress.THEMES[item.key];
      const bg = th.hue == null
        ? 'linear-gradient(135deg,hsl(200,60%,22%),hsl(280,60%,22%),hsl(330,60%,20%))'
        : 'linear-gradient(160deg,hsl(' + th.hue + ',' + Math.round(55 * th.sat) + '%,24%),hsl(' + (th.hue + 35) + ',' + Math.round(55 * th.sat) + '%,7%))';
      return '<div class="shop-item"><div class="theme-preview" style="background:' + bg + '"></div><div class="shop-name">' + th.name + '</div>' + shopButton(item) + '</div>';
    }).join('');
    $('achievements').innerHTML = PTProgress.ACHIEVEMENTS.map(a => {
      const done = p.achievements[a.id];
      const [cur, target] = a.progress(p);
      const pct = Math.max(0, Math.min(100, cur / target * 100));
      return '<div class="ach' + (done ? ' done' : '') + '"><div class="ach-icon" aria-hidden="true">' + (done ? '✓' : '') + '</div>' +
        '<div class="ach-main"><b>' + a.name + '</b><span>' + a.desc + '</span>' +
        (done ? '' : '<div class="ach-bar"><i style="width:' + pct.toFixed(0) + '%"></i></div>') + '</div>' +
        '<div class="ach-reward">' + (done ? 'Done' : '+' + a.reward) + '</div></div>';
    }).join('');
  }

  function setGuide(dev) {
    settings.guide = dev;
    saveSettings();
    document.querySelectorAll('#screen-guide [data-for]').forEach(el => { el.hidden = el.dataset.for !== dev; });
    document.querySelectorAll('.segmented [data-guide]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.guide === dev)));
  }

  function backup() {
    try {
      const blob = new Blob([PTProgress.exportData()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'heather-music-hub-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      $('backup-status').textContent = 'Backup saved.';
    } catch (e) {
      $('backup-status').textContent = 'This browser could not save the file.';
    }
  }

  async function restore(file) {
    if (!file) return;
    try {
      PTProgress.importData(await file.text());
      $('backup-status').textContent = 'Backup restored.';
      renderRecords();
    } catch (e) {
      $('backup-status').textContent = e.message || 'Could not read that backup.';
    }
  }

  // ---------- wiring ----------
  function init() {
    const input = $('file-input');
    const pick = (files) => {
      if (!files || !files.length) return;
      if (files.length > 1) importFiles(Array.from(files)).catch(showLoadError);
      else loadFile(files[0]);
    };
    input.addEventListener('change', () => pick(input.files));
    const dz = $('dropzone');
    ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
    dz.addEventListener('drop', (e) => pick(e.dataTransfer.files));
    $('btn-demo').addEventListener('click', loadDemo);
    $('btn-analyze').addEventListener('click', analyze);

    $('btn-analysis-back').addEventListener('click', () => show('screen-home'));
    $('btn-to-difficulty').addEventListener('click', openDifficulty);

    $('btn-diff-back').addEventListener('click', () => show('screen-analysis'));
    $('speed').addEventListener('input', (e) => {
      settings.speedMod = Number(e.target.value);
      $('speed-out').textContent = settings.speedMod.toFixed(2).replace(/0$/, '') + '×';
      saveSettings();
    });
    $('offset').addEventListener('input', (e) => {
      settings.offsetMs = Number(e.target.value);
      $('offset-out').textContent = (settings.offsetMs > 0 ? '+' : '') + settings.offsetMs + ' ms';
      saveSettings();
    });
    $('var-minus').addEventListener('click', () => { state.variation = Math.max(1, state.variation - 1); renderDifficulty(); });
    $('var-plus').addEventListener('click', () => { state.variation = Math.min(99, state.variation + 1); renderDifficulty(); });
    $('btn-play').addEventListener('click', play);

    $('btn-pause').addEventListener('click', () => state.game && state.game.pause());
    $('btn-resume').addEventListener('click', () => state.game && state.game.resume());
    $('btn-restart').addEventListener('click', () => state.game && state.game.restart());
    $('btn-quit').addEventListener('click', () => { quitGame(); openDifficulty(); });
    $('btn-rotate-back').addEventListener('click', () => { if (state.game) { quitGame(); openDifficulty(); } });

    $('btn-replay').addEventListener('click', play);
    $('btn-regen').addEventListener('click', openDifficulty);
    $('btn-newsong').addEventListener('click', () => { input.value = ''; show('screen-home'); });
    initLibrary();
    $('cloud-card').addEventListener('click', onCloudCard);
    $('btn-calibrate').addEventListener('click', openCalib);
    $('btn-calib-start').addEventListener('click', startCalib);
    $('btn-calib-close').addEventListener('click', closeCalib);
    $('calib-pad').addEventListener('pointerdown', calibTap);
    $('btn-install-hide').addEventListener('click', () => { U.store.set('hmh:hideInstall', true); renderInstallHint(); });
    renderInstallHint();
    $('btn-cloud-connect').addEventListener('click', connectCloud);
    $('btn-cloud-cancel').addEventListener('click', () => $('cloud-dialog').classList.add('hidden'));
    // Coming back to the app (e.g. reopening it on the phone) checks the cloud for new songs.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !state.game && Date.now() - cloud.syncedAt > 30000) syncCloud();
    });
    $('pack-input').addEventListener('change', (e) => { importPack(e.target.files && e.target.files[0]); e.target.value = ''; });
    $('part-picker').addEventListener('click', (e) => {
      const b = e.target.closest('[data-part]');
      if (!b) return;
      state.part = b.dataset.part;
      renderDifficulty();
    });
    $('tabbar').querySelectorAll('button').forEach(b => b.addEventListener('click', () => show(b.dataset.screen)));
    document.querySelectorAll('.segmented [data-guide]').forEach(b => b.addEventListener('click', () => setGuide(b.dataset.guide)));
    setGuide(settings.guide || (isTouch() ? 'phone' : 'pc'));
    $('btn-backup').addEventListener('click', backup);
    $('restore-input').addEventListener('change', (e) => { restore(e.target.files && e.target.files[0]); e.target.value = ''; });
    const shopClick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.buy) {
        const ok = PTProgress.buy(b.dataset.buy);
        if (ok) PTProgress.equip(b.dataset.buy);
        renderRewards(ok ? 'Unlocked and equipped.' : 'Not enough coins yet.');
      } else if (b.dataset.equip) {
        PTProgress.equip(b.dataset.equip);
        renderRewards('Equipped.');
      }
    };
    $('shop-skins').addEventListener('click', shopClick);
    $('shop-themes').addEventListener('click', shopClick);
    show('screen-home');
    registerServiceWorker();
    $('btn-apply-offset').addEventListener('click', (e) => {
      settings.offsetMs = Number(e.currentTarget.dataset.value) || 0;
      saveSettings();
      e.currentTarget.classList.add('hidden');
      $('r-timing').textContent += ' Applied.';
    });
  }

  init();
})();

/*
 * Player progress: records, rating, level, coins, achievements and unlockables.
 * Saved on this device (localStorage). Modeled on the reward loops of the games Heather Music Hub draws on:
 *   - clear gauge + clear types (Arcaea: Track Complete / Full Recall / Pure Memory; Phigros FC / AP)
 *   - score grades and chart levels (Arcaea / Phigros difficulty constants)
 *   - rating from your best plays (Arcaea Potential, Phigros RKS)
 *   - player level + EXP and coins spent on looks (SuperStar)
 */
(function (global) {
  'use strict';

  const KEY = 'bt:progress:v1';
  const CLEAR_RANK = { fail: 0, clear: 1, fc: 2, ap: 3 };
  const CLEAR_LABEL = { fail: 'Track Lost', clear: 'Clear', fc: 'Full Combo', ap: 'All Perfect' };
  const GRADE_MULT = { AP: 2, SS: 1.7, S: 1.5, A: 1.3, B: 1.15, C: 1, F: 0.5 };

  // ---------- looks ----------
  const SKINS = {
    aurora: { name: 'Aurora', lanes: [['#8af7ff', '#1fa8ff'], ['#a9c4ff', '#4a5dff'], ['#dcc2ff', '#8a45ff'], ['#ffb3e0', '#ff3f9a']] },
    ivory: { name: 'Ivory', lanes: [['#ffffff', '#b9c1d6'], ['#ffffff', '#b9c1d6'], ['#ffffff', '#b9c1d6'], ['#ffffff', '#b9c1d6']] },
    sakura: { name: 'Sakura', lanes: [['#ffe1ee', '#ff8fc0'], ['#ffd6ea', '#ff6fae'], ['#ffc9e2', '#f0579a'], ['#ffe9f3', '#ff9dc8']] },
    ember: { name: 'Ember', lanes: [['#ffe0a3', '#ff8a2b'], ['#ffc98a', '#ff6a2b'], ['#ffb38a', '#ff4d3d'], ['#ffd0a0', '#ff7a1f']], flick: ['#b8f3ff', '#2fb6ff'] },
    prism: { name: 'Prism', lanes: [['#ff9aa8', '#ff3d5a'], ['#ffe28a', '#ffb020'], ['#9df5b8', '#22c36b'], ['#9fd4ff', '#2f7dff']] },
    gold: { name: 'Gold', lanes: [['#fff3c4', '#e0a526'], ['#fff3c4', '#e0a526'], ['#fff3c4', '#e0a526'], ['#fff3c4', '#e0a526']], flick: ['#b8f3ff', '#2fb6ff'] }
  };
  const THEMES = {
    song: { name: 'Song colors', hue: null, sat: 1 },
    ocean: { name: 'Ocean', hue: 195, sat: 1 },
    sunset: { name: 'Sunset', hue: 330, sat: 1.1 },
    forest: { name: 'Forest', hue: 150, sat: 0.9 },
    midnight: { name: 'Midnight', hue: 230, sat: 0.25 },
    nebula: { name: 'Nebula', hue: 280, sat: 1.3 }
  };
  const SHOP = [
    { id: 'skin:aurora', type: 'skin', key: 'aurora', price: 0 },
    { id: 'skin:ivory', type: 'skin', key: 'ivory', price: 150 },
    { id: 'skin:sakura', type: 'skin', key: 'sakura', price: 200 },
    { id: 'skin:ember', type: 'skin', key: 'ember', price: 250 },
    { id: 'skin:prism', type: 'skin', key: 'prism', price: 400 },
    { id: 'skin:gold', type: 'skin', key: 'gold', price: 0, requires: 'ap-1' },
    { id: 'theme:song', type: 'theme', key: 'song', price: 0 },
    { id: 'theme:ocean', type: 'theme', key: 'ocean', price: 150 },
    { id: 'theme:sunset', type: 'theme', key: 'sunset', price: 200 },
    { id: 'theme:forest', type: 'theme', key: 'forest', price: 200 },
    { id: 'theme:midnight', type: 'theme', key: 'midnight', price: 300 },
    { id: 'theme:nebula', type: 'theme', key: 'nebula', price: 0, requires: 'rating-5' }
  ];

  // ---------- achievements ----------
  const recs = (p) => Object.values(p.records);
  const cleared = (r) => CLEAR_RANK[r.clear] >= 1;
  const ACHIEVEMENTS = [
    { id: 'first-clear', name: 'First Light', desc: 'Clear any chart.', reward: 50, progress: p => [Math.min(1, p.totals.clears), 1] },
    { id: 'fc-1', name: 'Unbroken', desc: 'Get a Full Combo.', reward: 100, progress: p => [Math.min(1, p.totals.fcs), 1] },
    { id: 'ap-1', name: 'Pure Memory', desc: 'All Perfect a chart. Unlocks the Gold skin.', reward: 300, progress: p => [Math.min(1, p.totals.aps), 1] },
    { id: 'combo-100', name: 'Hundred Streak', desc: 'Reach a 100 combo.', reward: 60, progress: p => [Math.min(100, p.totals.bestCombo), 100] },
    { id: 'combo-500', name: 'Endless Chain', desc: 'Reach a 500 combo.', reward: 200, progress: p => [Math.min(500, p.totals.bestCombo), 500] },
    { id: 'hard-clear', name: 'Step Up', desc: 'Clear a Hard chart.', reward: 100, progress: p => [recs(p).some(r => /hard$/.test(r.diff) && cleared(r)) ? 1 : 0, 1] },
    { id: 'horizontal-clear', name: 'Across the Sky', desc: 'Clear a Horizontal chart.', reward: 80, progress: p => [recs(p).some(r => r.mode === 'horizontal' && cleared(r)) ? 1 : 0, 1] },
    { id: 'all-four', name: 'Complete Set', desc: 'Clear all four charts of one song.', reward: 250, progress: p => {
      const by = {};
      for (const r of recs(p)) if (cleared(r)) (by[r.hash] = by[r.hash] || new Set()).add(r.diff);
      return [Math.max(0, ...Object.values(by).map(s => s.size)), 4];
    } },
    { id: 's-rank', name: 'Sharp', desc: 'Score an S or better.', reward: 120, progress: p => [recs(p).some(r => r.score >= 950000) ? 1 : 0, 1] },
    { id: 'songs-5', name: 'Collector', desc: 'Clear 5 different songs.', reward: 150, progress: p => [Math.min(5, new Set(recs(p).filter(cleared).map(r => r.hash)).size), 5] },
    { id: 'plays-10', name: 'Regular', desc: 'Play 10 times.', reward: 60, progress: p => [Math.min(10, p.totals.plays), 10] },
    { id: 'plays-50', name: 'Devoted', desc: 'Play 50 times.', reward: 200, progress: p => [Math.min(50, p.totals.plays), 50] },
    { id: 'arcs-500', name: 'Arc Weaver', desc: 'Stay on arcs for 500 ticks.', reward: 120, progress: p => [Math.min(500, p.totals.arcTicks), 500] },
    { id: 'flicks-100', name: 'Flick Artist', desc: 'Swipe 100 flicks.', reward: 100, progress: p => [Math.min(100, p.totals.flicks), 100] },
    { id: 'rating-5', name: 'Rising Star', desc: 'Reach a 5.00 rating. Unlocks the Nebula theme.', reward: 150, progress: p => [Math.min(5, rating(p)), 5] },
    { id: 'rating-10', name: 'Star Player', desc: 'Reach a 10.00 rating.', reward: 400, progress: p => [Math.min(10, rating(p)), 10] },
    { id: 'level-10', name: 'Seasoned', desc: 'Reach player level 10.', reward: 200, progress: p => [Math.min(10, levelInfo(p.exp).level), 10] }
  ];

  // ---------- storage ----------
  function fresh() {
    return {
      exp: 0, coins: 0,
      owned: ['skin:aurora', 'theme:song'],
      equipped: { skin: 'aurora', theme: 'song' },
      achievements: {},
      totals: { plays: 0, clears: 0, fcs: 0, aps: 0, bestCombo: 0, arcTicks: 0, flicks: 0 },
      records: {},
      history: []
    };
  }
  let data = null;
  function load(seed) {
    if (data && !seed) return data;
    const saved = seed || PTUtil.store.get(KEY, null);
    data = fresh();
    if (saved && typeof saved === 'object') {
      Object.assign(data, saved);
      data.totals = Object.assign(fresh().totals, saved.totals || {});
      data.equipped = Object.assign(fresh().equipped, saved.equipped || {});
    }
    return data;
  }
  function save() { PTUtil.store.set(KEY, data); }

  // ---------- rules ----------
  function grade(score, ap) {
    if (ap) return 'AP';
    if (score >= 980000) return 'SS';
    if (score >= 950000) return 'S';
    if (score >= 900000) return 'A';
    if (score >= 800000) return 'B';
    if (score >= 700000) return 'C';
    return 'F';
  }
  function clearType(r) {
    if (r.gauge < 70) return 'fail';
    if (r.miss === 0 && r.great === 0 && r.good === 0 && r.total > 0) return 'ap';
    if (r.miss === 0 && r.total > 0) return 'fc';
    return 'clear';
  }
  // Arcaea-style play rating: level + 2 at 1,000,000, level at 950,000, dropping below that.
  function playRating(level, score) {
    if (score >= 1000000) return level + 2;
    if (score >= 980000) return level + 1 + (score - 980000) / 20000;
    if (score >= 950000) return level + (score - 950000) / 30000;
    return Math.max(0, level + (score - 950000) / 30000);
  }
  // Player rating: average of the 10 best chart ratings (missing slots count as 0).
  function rating(p) {
    const top = Object.values((p || load()).records).map(r => r.rating || 0).sort((a, b) => b - a).slice(0, 10);
    return top.reduce((a, b) => a + b, 0) / 10;
  }
  // Level L needs 100 + 40 * (L - 1) EXP to reach L + 1.
  function levelInfo(exp) {
    let level = 1, need = 100, rest = exp;
    while (rest >= need) { rest -= need; level++; need = 100 + 40 * (level - 1); }
    return { level, into: rest, need };
  }
  // Parts of a song (part 1 / part 2) keep their own records next to the full song's.
  function recordKey(hash, diff, variation, part) { return hash + ':' + diff + ':' + (variation || 1) + (part && part !== 'full' ? ':' + part : ''); }
  function getRecord(hash, diff, variation, part) { return load().records[recordKey(hash, diff, variation, part)] || null; }

  // Store one finished play and hand out rewards. Returns everything the results screen shows.
  function recordPlay(play) {
    const p = load();
    const r = play.result;
    const clear = clearType(r);
    const ap = clear === 'ap';
    const g = grade(r.score, ap);
    const key = recordKey(play.hash, play.diff, play.variation, play.part);
    const prev = p.records[key] || null;
    const ratingBefore = rating(p);
    const levelBefore = levelInfo(p.exp).level;
    const pr = playRating(play.level, r.score);
    const newBest = !prev || r.score > prev.score;
    const firsts = [];

    const rec = prev ? Object.assign({}, prev) : { hash: play.hash, diff: play.diff, mode: play.mode, variation: play.variation || 1, part: play.part || 'full', score: 0, clear: 'fail', plays: 0 };
    rec.title = play.title;
    rec.level = play.level;
    rec.plays++;
    rec.lastPlayed = Date.now();
    if (newBest) Object.assign(rec, { score: r.score, accuracy: r.accuracy, grade: g, maxCombo: r.maxCombo, rating: pr });
    if (CLEAR_RANK[clear] > CLEAR_RANK[rec.clear]) {
      if (clear !== 'fail' && CLEAR_RANK[rec.clear] < 1) firsts.push({ label: 'First clear', coins: 50 });
      if (CLEAR_RANK[clear] >= 2 && CLEAR_RANK[rec.clear] < 2) firsts.push({ label: 'First Full Combo', coins: 80 });
      if (clear === 'ap') firsts.push({ label: 'First All Perfect', coins: 150 });
      rec.clear = clear;
    }
    p.records[key] = rec;

    const t = p.totals;
    t.plays++;
    if (clear !== 'fail') t.clears++;
    if (CLEAR_RANK[clear] >= 2) t.fcs++;
    if (ap) t.aps++;
    t.bestCombo = Math.max(t.bestCombo, r.maxCombo);
    t.arcTicks += r.arcTicksHit || 0;
    t.flicks += r.flicksSwiped || 0;

    // EXP for every play; coins only for clears.
    const mult = GRADE_MULT[g];
    const exp = Math.round((12 + play.level * 6) * (clear === 'fail' ? 0.4 : 1) * mult);
    p.exp += exp;
    let coins = clear === 'fail' ? 0 : Math.round((6 + play.level * 4) * mult);
    const bonuses = firsts.slice();
    if (newBest && prev && clear !== 'fail') bonuses.push({ label: 'New best', coins: 20 });
    const levelAfter = levelInfo(p.exp).level;
    if (levelAfter > levelBefore) bonuses.push({ label: 'Level up to ' + levelAfter, coins: 100 * (levelAfter - levelBefore) });

    p.history.unshift({ at: Date.now(), title: play.title, diff: play.diff, mode: play.mode, part: play.part || 'full', score: r.score, grade: g, clear });
    p.history = p.history.slice(0, 30);

    // Achievements unlocked by this play.
    const unlocked = [];
    for (const a of ACHIEVEMENTS) {
      if (p.achievements[a.id]) continue;
      const [cur, target] = a.progress(p);
      if (cur >= target) {
        p.achievements[a.id] = Date.now();
        unlocked.push(a);
        bonuses.push({ label: 'Achievement: ' + a.name, coins: a.reward });
      }
    }
    for (const b of bonuses) coins += b.coins;
    p.coins += coins;
    save();
    return {
      clear, clearLabel: CLEAR_LABEL[clear], grade: g, newBest, prevBest: prev ? prev.score : null,
      exp, coins, bonuses, unlocked, levelBefore, levelAfter, level: levelInfo(p.exp),
      ratingBefore, ratingAfter: rating(p), playRating: pr
    };
  }

  // ---------- shop ----------
  function itemState(item) {
    const p = load();
    const owned = p.owned.includes(item.id) || (item.price === 0 && !item.requires);
    const locked = item.requires && !p.achievements[item.requires];
    const equipped = p.equipped[item.type] === item.key;
    return { owned: owned || (item.requires && !locked), locked, equipped, affordable: p.coins >= item.price };
  }
  function buy(id) {
    const p = load();
    const item = SHOP.find(i => i.id === id);
    if (!item) return false;
    const st = itemState(item);
    if (st.owned) return true;
    if (st.locked || !st.affordable) return false;
    p.coins -= item.price;
    p.owned.push(id);
    save();
    return true;
  }
  function equip(id) {
    const item = SHOP.find(i => i.id === id);
    if (!item || !itemState(item).owned) return false;
    load().equipped[item.type] = item.key;
    save();
    return true;
  }
  function look() {
    const p = load();
    return { skin: SKINS[p.equipped.skin] || SKINS.aurora, theme: THEMES[p.equipped.theme] || THEMES.song };
  }

  // ---------- backup ----------
  function exportData() { return JSON.stringify({ app: 'HeatherMusicHub', version: 1, data: load() }); }
  function importData(text) {
    const o = JSON.parse(text);
    if (!o || (o.app !== 'HeatherMusicHub' && o.app !== 'BeatTiles') || !o.data || typeof o.data.records !== 'object') throw new Error('This is not a Heather Music Hub backup file.');
    load(o.data);
    save();
    return true;
  }

  global.PTProgress = {
    load, save, grade, clearType, playRating, rating: () => rating(), levelInfo, getRecord, recordPlay,
    ACHIEVEMENTS, SHOP, SKINS, THEMES, CLEAR_LABEL, CLEAR_RANK, itemState, buy, equip, look, exportData, importData
  };
})(typeof self !== 'undefined' ? self : this);

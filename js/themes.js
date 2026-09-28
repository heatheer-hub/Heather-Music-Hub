/*
 * App themes: a picture from the Background folder plus a palette taken from it, for the menus
 * (CSS variables), the gameplay backdrop and the three note colours. All free.
 *
 * The pictures are not part of the public website. They load from the local Background folder,
 * or from this device's storage after arriving through a song pack or the cloud library.
 */
(function (global) {
  'use strict';

  const THEMES = [
    {
      id: 'starry', name: 'Starry Night', file: '12736811443930481.jpg', mode: 'dark', focal: [82, 82],
      ui: { bg: '#0e1a3a', bg2: '#16264f', card: 'rgba(15, 28, 62, 0.74)', card2: 'rgba(33, 52, 104, 0.72)', text: '#f7f2e3', soft: '#dcdff0', muted: '#a9b5d6', c1: '#f3d27a', c2: '#b7c4ff', ink: '255 255 255', onAccent: '#18214a' },
      game: { veil: 'rgba(8, 14, 36, 0.35)', field: 'rgba(8, 14, 36, 0.55)', line: 'rgba(243, 210, 122, 0.2)', accent: '#f3d27a', notes: { tap: '#f3d27a', hold: '#a9b8ff', flick: '#ff9b72' } }
    },
    {
      id: 'lantern', name: 'Lantern Walk', file: 'Sina Visitor System.jpg', mode: 'dark', focal: [55, 62],
      ui: { bg: '#2c4478', bg2: '#35528c', card: 'rgba(33, 52, 96, 0.72)', card2: 'rgba(60, 86, 140, 0.7)', text: '#f6f3ea', soft: '#e0e5f2', muted: '#b6c3de', c1: '#f6dd9a', c2: '#f3a9c6', ink: '255 255 255', onAccent: '#27305a' },
      game: { veil: 'rgba(22, 34, 70, 0.35)', field: 'rgba(20, 32, 66, 0.55)', line: 'rgba(246, 221, 154, 0.2)', accent: '#f6dd9a', notes: { tap: '#fff1c2', hold: '#a7c0f5', flick: '#f3a9c6' } }
    },
    {
      id: 'swirl', name: 'Blue Swirl', file: '914862422528098.jpg', mode: 'dark', focal: [52, 42],
      ui: { bg: '#173a5a', bg2: '#1f4a70', card: 'rgba(18, 44, 70, 0.74)', card2: 'rgba(38, 76, 110, 0.7)', text: '#f6ebd6', soft: '#e3e2dc', muted: '#aec3d4', c1: '#eec287', c2: '#8fc4e8', ink: '255 255 255', onAccent: '#1a2f45' },
      game: { veil: 'rgba(10, 30, 50, 0.3)', field: 'rgba(10, 30, 50, 0.55)', line: 'rgba(238, 194, 135, 0.2)', accent: '#eec287', notes: { tap: '#f6d29e', hold: '#8fc4e8', flick: '#ff8a5c' } }
    },
    {
      id: 'clover', name: 'Clover Hill', file: '829225350183444610.jpg', mode: 'light', focal: [45, 58],
      ui: { bg: '#cfe3f1', bg2: '#e8f1f6', card: 'rgba(255, 255, 255, 0.8)', card2: 'rgba(236, 244, 236, 0.9)', text: '#243424', soft: '#3a4d37', muted: '#63765e', c1: '#4f8a3a', c2: '#4b87c4', ink: '36 58 42', onAccent: '#ffffff' },
      game: { veil: 'rgba(20, 44, 30, 0.3)', field: 'rgba(18, 40, 28, 0.58)', line: 'rgba(255, 255, 255, 0.22)', accent: '#b8e08a', notes: { tap: '#ffffff', hold: '#b8e08a', flick: '#ffb46b' } }
    },
    {
      id: 'meadow', name: 'Meadow Nap', file: '21392166974993285.jpg', mode: 'light', focal: [62, 45],
      ui: { bg: '#a9c86a', bg2: '#eef4dc', card: 'rgba(252, 253, 240, 0.84)', card2: 'rgba(236, 244, 214, 0.92)', text: '#223619', soft: '#34482a', muted: '#5f7452', c1: '#3f7a3b', c2: '#9a7442', ink: '34 54 25', onAccent: '#ffffff' },
      game: { veil: 'rgba(22, 48, 20, 0.32)', field: 'rgba(22, 46, 20, 0.6)', line: 'rgba(244, 197, 66, 0.22)', accent: '#f4c542', notes: { tap: '#fff6d6', hold: '#f4c542', flick: '#e8674f' } }
    },
    {
      id: 'duck', name: 'Duck Pond', file: 'duck - 太龙 Tailong.jpg', mode: 'light', focal: [55, 32],
      ui: { bg: '#8fd3e6', bg2: '#e6f7fb', card: 'rgba(242, 252, 255, 0.84)', card2: 'rgba(226, 245, 250, 0.92)', text: '#0f3a4b', soft: '#1f4d5f', muted: '#4d7383', c1: '#e7791f', c2: '#1f94c4', ink: '15 58 75', onAccent: '#ffffff' },
      game: { veil: 'rgba(6, 50, 70, 0.3)', field: 'rgba(6, 50, 70, 0.58)', line: 'rgba(233, 223, 138, 0.25)', accent: '#e9df8a', notes: { tap: '#ffffff', hold: '#e9df8a', flick: '#f08a2a' } }
    },
    {
      id: 'daisy', name: 'Daisy Stream', file: '___｡𝖙𝖍𝖗𝖊𝖊‘ﾟ･ღ.jpg', mode: 'light', focal: [58, 40],
      ui: { bg: '#9fdbe8', bg2: '#ebf8fb', card: 'rgba(255, 255, 255, 0.84)', card2: 'rgba(232, 247, 250, 0.92)', text: '#123f4c', soft: '#1f5160', muted: '#4b7a87', c1: '#d9a400', c2: '#2c9ab8', ink: '18 63 76', onAccent: '#ffffff' },
      game: { veil: 'rgba(8, 60, 78, 0.3)', field: 'rgba(8, 60, 78, 0.55)', line: 'rgba(255, 255, 255, 0.24)', accent: '#ffe27a', notes: { tap: '#ffffff', hold: '#ffe27a', flick: '#f5a623' } }
    },
    {
      id: 'classic', name: 'Classic Neon', file: null, mode: 'dark', focal: [50, 50],
      ui: { bg: '#06070c', bg2: '#0c0f19', card: '#121624', card2: '#181d2f', text: '#e8ebf5', soft: '#c9cfe0', muted: '#8a90a6', c1: '#4de1ff', c2: '#8b5cff', ink: '255 255 255', onAccent: '#07080d' },
      game: null
    }
  ];

  const FONT_CLASSIC = 'Outfit, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const FONT_STORY = 'Nunito, Outfit, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  function fontFor(theme) { return theme.id === 'classic' ? FONT_CLASSIC : FONT_STORY; }

  function byId(id) { return THEMES.find(t => t.id === id) || THEMES[0]; }
  function byFile(name) { return THEMES.find(t => t.file && t.file.normalize('NFC') === String(name).normalize('NFC')) || null; }
  function rgbOf(hex) {
    const v = parseInt(hex.slice(1), 16);
    return (v >> 16) + ' ' + ((v >> 8) & 255) + ' ' + (v & 255);
  }

  // Menus: set the CSS variables and the fixed picture layer.
  function apply(theme, imageUrl) {
    const r = document.documentElement, u = theme.ui;
    const set = (k, v) => r.style.setProperty(k, v);
    set('--bg', u.bg); set('--bg-2', u.bg2); set('--card', u.card); set('--card-2', u.card2);
    set('--text', u.text); set('--text-soft', u.soft); set('--muted', u.muted);
    set('--cyan', u.c1); set('--violet', u.c2);
    set('--c1-rgb', rgbOf(u.c1)); set('--c2-rgb', rgbOf(u.c2));
    set('--ink-rgb', u.ink); set('--bg-rgb', rgbOf(u.bg)); set('--bg2-rgb', rgbOf(u.bg2)); set('--on-accent', u.onAccent);
    set('--line', 'rgb(' + u.ink + ' / 0.12)');
    set('--font', theme.id === 'classic' ? FONT_CLASSIC : FONT_STORY);
    r.dataset.appTheme = theme.id;
    r.dataset.tone = theme.mode;
    r.classList.toggle('has-bg', !!theme.file);
    const layer = document.getElementById('bg-layer');
    if (layer) {
      layer.style.backgroundImage = imageUrl ? 'url("' + imageUrl + '")' : 'none';
      layer.style.backgroundPosition = theme.focal[0] + '% ' + theme.focal[1] + '%';
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', u.bg);
  }

  global.PTThemes = { THEMES, byId, byFile, apply, fontFor };
})(typeof self !== 'undefined' ? self : this);

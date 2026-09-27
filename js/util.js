/* Shared helpers: hashing, seeded RNG, formatting, ID3 tag parsing, storage. */
(function (global) {
  'use strict';

  // FNV-1a over the raw file bytes. Used as the song identity and chart seed.
  function hashBytes(bytes) {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  // Small deterministic PRNG (mulberry32).
  function makeRng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function formatScore(n) {
    return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // Minimal ID3v2 reader for title / artist (TIT2 / TPE1). Returns {} on anything unexpected.
  function readId3(bytes) {
    const out = {};
    try {
      if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return out;
      const ver = bytes[3];
      const flags = bytes[5];
      const size = syncsafe(bytes, 6);
      let pos = 10;
      if (flags & 0x40) pos += ver === 4 ? syncsafe(bytes, 10) : readU32(bytes, 10) + 4;
      const end = Math.min(10 + size, bytes.length);
      const idLen = ver === 2 ? 3 : 4;
      const hdrLen = ver === 2 ? 6 : 10;
      const want = ver === 2 ? { TT2: 'title', TP1: 'artist' } : { TIT2: 'title', TPE1: 'artist' };
      while (pos + hdrLen < end) {
        let id = '';
        for (let i = 0; i < idLen; i++) id += String.fromCharCode(bytes[pos + i]);
        if (!/^[A-Z0-9]+$/.test(id)) break;
        let fsize;
        if (ver === 2) fsize = (bytes[pos + 3] << 16) | (bytes[pos + 4] << 8) | bytes[pos + 5];
        else if (ver === 4) fsize = syncsafe(bytes, pos + 4);
        else fsize = readU32(bytes, pos + 4);
        const dataStart = pos + hdrLen;
        if (fsize <= 0 || dataStart + fsize > end) break;
        if (want[id]) out[want[id]] = decodeText(bytes.subarray(dataStart, dataStart + fsize));
        pos = dataStart + fsize;
      }
    } catch (e) { /* ignore malformed tags */ }
    return out;
  }

  // First MPEG audio frame header after any ID3v2 tag: source sample rate, bitrate, channels.
  function readMp3Header(bytes) {
    let pos = 0;
    if (bytes.length > 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
      pos = 10 + syncsafe(bytes, 6) + ((bytes[5] & 0x10) ? 10 : 0);
    }
    const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
    const BR_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
    const BR_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    const end = Math.min(bytes.length - 4, pos + 65536);
    for (let i = pos; i < end; i++) {
      if (bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) continue;
      const ver = (bytes[i + 1] >> 3) & 3, layer = (bytes[i + 1] >> 1) & 3;
      const brIdx = bytes[i + 2] >> 4, srIdx = (bytes[i + 2] >> 2) & 3;
      if (ver === 1 || layer !== 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) continue;
      return {
        sampleRate: RATES[ver][srIdx],
        bitrate: (ver === 3 ? BR_V1 : BR_V2)[brIdx],
        channels: (bytes[i + 3] >> 6) === 3 ? 1 : 2
      };
    }
    return null;
  }

  function syncsafe(b, i) {
    return ((b[i] & 0x7f) << 21) | ((b[i + 1] & 0x7f) << 14) | ((b[i + 2] & 0x7f) << 7) | (b[i + 3] & 0x7f);
  }
  function readU32(b, i) {
    return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  }
  function decodeText(data) {
    const enc = data[0];
    const body = data.subarray(1);
    let label = 'latin1';
    if (enc === 1) label = 'utf-16';
    else if (enc === 2) label = 'utf-16be';
    else if (enc === 3) label = 'utf-8';
    let s;
    try { s = new TextDecoder(label).decode(body); } catch (e) { s = ''; }
    return s.replace(/\u0000+$/g, '').replace(/^﻿/, '').trim();
  }

  // localStorage wrapped so private mode / blocked storage never breaks the game.
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v == null ? fallback : JSON.parse(v);
      } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
    }
  };

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // Index of the first element in sorted array `arr` with arr[i] >= x.
  function lowerBound(arr, x) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < x) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  global.PTUtil = { hashBytes, makeRng, formatTime, formatBytes, formatScore, readId3, readMp3Header, store, clamp, lowerBound };
})(typeof self !== 'undefined' ? self : this);

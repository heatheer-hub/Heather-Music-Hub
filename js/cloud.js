/*
 * Cloud library: songs kept in a PRIVATE GitHub repository (folder "songs/") so every device
 * that connects with the same repository and token sees the same songs.
 *
 * Uses the GitHub REST API directly from the browser. The token is a fine-grained personal
 * access token limited to that one repository (Contents: read and write). It is stored only in
 * this browser (localStorage) and sent only to api.github.com.
 */
(function (global) {
  'use strict';

  const KEY = 'hmh:cloud';
  // Tests point this at a local stand-in for GitHub; real use always talks to api.github.com.
  const API = PTUtil.store.get('hmh:cloudApi', null) || 'https://api.github.com';
  const DIR = 'songs';
  const AUDIO = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|webm)$/i;

  function config() {
    const c = PTUtil.store.get(KEY, null);
    return c && c.repo && c.token ? c : null;
  }

  function headers(token, extra) {
    return Object.assign({ Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, extra || {});
  }

  async function api(path, opts) {
    const c = (opts && opts.cfg) || config();
    if (!c) throw new Error('The cloud library is not connected.');
    let res;
    try {
      res = await fetch(API + path, Object.assign({}, opts, { headers: headers(c.token, opts && opts.headers) }));
    } catch (e) {
      throw new Error('Could not reach GitHub. Check your internet connection.');
    }
    if (res.status === 401) throw new Error('GitHub rejected the token. It may have expired: create a new one and connect again.');
    return res;
  }

  function encodePath(p) { return p.split('/').map(encodeURIComponent).join('/'); }

  // Connect: the repository must exist, be private, and the token must be able to write to it.
  async function connect(repo, token) {
    repo = String(repo || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
    token = String(token || '').trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Enter the repository as owner/name, for example heatheer-hub/heather-music-hub-songs.');
    if (!token) throw new Error('Paste the access token.');
    const cfg = { repo, token };
    const res = await api('/repos/' + repo, { cfg });
    if (res.status === 404) throw new Error('Repository not found. Check the name, and that the token was given access to it.');
    if (!res.ok) throw new Error('GitHub error ' + res.status + ' while opening the repository.');
    const info = await res.json();
    if (!info.private) throw new Error('That repository is public. Songs must go in a private repository so only you can get them: change it to private in its Settings, then connect again.');
    if (info.permissions && !info.permissions.push) throw new Error('This token can only read the repository. Give it "Contents: Read and write" permission.');
    PTUtil.store.set(KEY, { repo, token, connectedAt: Date.now() });
    return info;
  }

  function disconnect() { try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ } }

  // Songs in the cloud: [{ name, path, size, sha }].
  async function list() {
    const c = config();
    const res = await api('/repos/' + c.repo + '/contents/' + DIR + '?per_page=1000');
    if (res.status === 404) return []; // folder not created yet
    if (!res.ok) throw new Error('GitHub error ' + res.status + ' while listing songs.');
    const items = await res.json();
    return (Array.isArray(items) ? items : [])
      .filter(it => it.type === 'file' && AUDIO.test(it.name))
      .map(it => ({ name: it.name, path: it.path, size: it.size, sha: it.sha }));
  }

  async function download(path) {
    const c = config();
    const res = await api('/repos/' + c.repo + '/contents/' + encodePath(path), { headers: { Accept: 'application/vnd.github.raw' } });
    if (!res.ok) throw new Error('Could not download this song from the cloud (GitHub error ' + res.status + ').');
    return new Uint8Array(await res.arrayBuffer());
  }

  function toBase64(bytes) {
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(s);
  }

  // A file name GitHub and every OS accept; the original name otherwise stays as-is.
  function cleanName(name) {
    return String(name).replace(/[\\/:*?"<>|#%]+/g, ' ').replace(/\s+/g, ' ').trim() || 'song.mp3';
  }

  // Upload one song. Returns { path, sha }. If the same file is already there (uploaded from
  // another device) it is reused; a different song with the same name gets " (2)", " (3)"…
  async function upload(fileName, bytes, attempt) {
    const c = config();
    const n = attempt || 1;
    const name = cleanName(fileName);
    const path = DIR + '/' + (n > 1 ? name.replace(/(\.[^.]+)?$/, ' (' + n + ')$1') : name);
    const res = await api('/repos/' + c.repo + '/contents/' + encodePath(path), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Add ' + cleanName(fileName), content: toBase64(bytes) })
    });
    if (res.status === 422) {
      // Already there (created from another device).
      const existing = await api('/repos/' + c.repo + '/contents/' + encodePath(path));
      if (existing.ok) {
        const e = await existing.json();
        if (e.size === bytes.length) return { path: e.path, sha: e.sha, existed: true };
        if (n < 9) return upload(fileName, bytes, n + 1);
      }
    }
    if (!res.ok) {
      if (res.status === 413) throw new Error('"' + fileName + '" is too large for the cloud library.');
      throw new Error('Upload of "' + fileName + '" failed (GitHub error ' + res.status + ').');
    }
    const out = await res.json();
    return { path: out.content.path, sha: out.content.sha };
  }

  async function remove(path, sha) {
    const c = config();
    const res = await api('/repos/' + c.repo + '/contents/' + encodePath(path), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Remove ' + path.split('/').pop(), sha })
    });
    if (!res.ok && res.status !== 404) throw new Error('Could not delete it from the cloud (GitHub error ' + res.status + ').');
  }

  global.PTCloud = { config, connect, disconnect, list, download, upload, remove, cleanName };
})(typeof self !== 'undefined' ? self : this);

/* pyIPAM – frontend (vanilla JS, no external dependencies). UI language: German. */
'use strict';
(() => {
  // ================================================================== Basics
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    user: null, csrf: '', version: '', xlsx: false, statuses: {}, mapMax: 4096, scanMax: 1024,
    subnets: [], sections: [], vlans: [],
    collapsed: load('ipam.collapsed', {}),
  };
  let cur = null;      // currently open subnet
  let logState = null; // change log view state

  function load(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } }

  const ROLE_LABEL = { admin: 'Administrator', editor: 'Bearbeiter', viewer: 'Nur lesen' };
  const STATUS_COLOR = { active: 'var(--st-active)', reserved: 'var(--st-reserved)', dhcp: 'var(--st-dhcp)', offline: 'var(--st-offline)' };
  const canEdit = () => state.user && (state.user.role === 'admin' || state.user.role === 'editor');
  const isAdmin = () => state.user && state.user.role === 'admin';

  const ICONS = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    grid: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
    logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="m10 17-5-5 5-5"/><path d="M5 12h11"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
    upload: '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M5 21h14"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>',
    trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="m6 7 1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
    more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
    radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/><path d="m12 12 6-6"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    chev: '<path d="m6 9 6 6 6-6"/>',
    check: '<path d="m5 12 5 5 9-10"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18Z"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3"/>',
    network: '<rect x="9" y="3" width="6" height="5" rx="1"/><rect x="3" y="16" width="6" height="5" rx="1"/><rect x="15" y="16" width="6" height="5" rx="1"/><path d="M12 8v4M6 16v-2h12v2"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
    users: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M16 4a4 4 0 0 1 0 8M22 21a7 7 0 0 0-4-6.3"/>',
    db: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    wand: '<path d="m15 4 1 2 2 1-2 1-1 2-1-2-2-1 2-1Z"/><path d="M4 20 13 11"/>',
    file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6"/>',
    sheet: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/>',
    alert: '<path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4M12 17h.01"/>',
    split: '<path d="M4 4h16v16H4z"/><path d="M12 4v16M4 12h8"/>',
    restore: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>',
  };
  const icon = (n, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ''}</svg>`;

  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '–');
  const fmtNum = (n) => Number(n).toLocaleString('de-DE');
  function ago(iso) {
    if (!iso) return '–';
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return 'gerade eben';
    if (s < 3600) return `vor ${Math.floor(s / 60)} Min.`;
    if (s < 86400) return `vor ${Math.floor(s / 3600)} Std.`;
    if (s < 86400 * 7) return `vor ${Math.floor(s / 86400)} Tg.`;
    return fmtDate(iso);
  }
  function capLabel(sub) {
    const c = String(sub.capacity);
    return c.length > 10 ? `2^${(sub.version === 4 ? 32 : 128) - sub.prefix}` : fmtNum(c);
  }
  const barCls = (p) => (p >= 90 ? 'crit' : p >= 75 ? 'warn' : '');
  const intToIp = (n) => [Math.floor(n / 16777216) % 256, Math.floor(n / 65536) % 256, Math.floor(n / 256) % 256, n % 256].join('.');
  const ipToInt = (s) => s.split('.').reduce((a, o) => a * 256 + Number(o), 0);

  // ================================================================== API
  async function api(method, url, data) {
    const opt = { method, headers: {}, credentials: 'same-origin' };
    if (method !== 'GET') opt.headers['X-CSRF-Token'] = state.csrf;
    if (data !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(data);
    }
    let r;
    try { r = await fetch(url, opt); } catch { throw new Error('Server nicht erreichbar'); }
    let j = null;
    try { j = await r.json(); } catch { /* not a JSON response */ }
    if (r.status === 401 && !url.startsWith('api/login') && !url.startsWith('api/me')) {
      state.user = null;
      await boot();
      throw new Error('Bitte erneut anmelden');
    }
    if (!r.ok) throw new Error((j && j.error) || `Fehler ${r.status}`);
    return j;
  }

  // ================================================================== UI building blocks
  function toast(msg, type = 'ok') {
    const el = document.createElement('div');
    el.className = `toast ${type === 'err' ? 'err' : ''}`;
    el.innerHTML = `${icon(type === 'err' ? 'alert' : 'check')}<span>${esc(msg)}</span>`;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; }, type === 'err' ? 5000 : 2600);
    setTimeout(() => el.remove(), type === 'err' ? 5400 : 3000);
  }

  function openModal({ title, sub = '', size = '', body, onMount, onClose }) {
    const bd = document.createElement('div');
    bd.className = 'modal-backdrop';
    bd.innerHTML = `<div class="modal ${size}" role="dialog" aria-modal="true">
      <div class="modal-head"><div><h3>${esc(title)}</h3>${sub ? `<div class="sub">${sub}</div>` : ''}</div>
      <button type="button" class="btn ghost icon sm x" data-close title="Schließen">${icon('x')}</button></div>${body}</div>`;
    $('#modal-root').appendChild(bd);
    let downOnBackdrop = false;
    const m = { el: bd.querySelector('.modal'), backdrop: bd };
    m.close = () => { if (!bd.isConnected) return; bd.remove(); onClose && onClose(); };
    bd.addEventListener('mousedown', (e) => { downOnBackdrop = e.target === bd; });
    bd.addEventListener('click', (e) => {
      if ((e.target === bd && downOnBackdrop) || e.target.closest('[data-close]')) m.close();
    });
    onMount && onMount(m);
    return m;
  }

  function formModal({ title, sub, size, fields, submit = 'Speichern', danger = false, left = '', onSubmit, onMount, onClose }) {
    const body = `<form novalidate autocomplete="off"><div class="modal-body"><div class="err hidden"></div>${fields}</div>
      <div class="modal-foot">${left ? `<div class="left">${left}</div>` : ''}
      <button type="button" class="btn" data-close>Abbrechen</button>
      <button type="submit" class="btn ${danger ? 'solid-danger' : 'primary'}">${esc(submit)}</button></div></form>`;
    return openModal({
      title, sub, size, body, onClose,
      onMount: (m) => {
        const form = m.el.querySelector('form');
        m.form = form;
        m.error = (msg) => { const e = form.querySelector('.err'); e.textContent = msg || ''; e.classList.toggle('hidden', !msg); };
        form.addEventListener('submit', async (ev) => {
          ev.preventDefault();
          const btn = form.querySelector('[type=submit]');
          if (btn.disabled) return;
          btn.disabled = true;
          m.error('');
          try {
            const res = await onSubmit(Object.fromEntries(new FormData(form)), m);
            if (res !== false) m.close();
          } catch (e) { m.error(e.message); } finally { btn.disabled = false; }
        });
        onMount && onMount(m);
        const f = form.querySelector('[autofocus]') || form.querySelector('input:not([type=hidden]):not([type=radio]):not([type=checkbox]), select, textarea');
        if (f) setTimeout(() => { f.focus(); if (f.select && f.value) f.select(); }, 40);
      },
    });
  }

  function confirmBox({ title, text, ok = 'Löschen', danger = true }) {
    return new Promise((resolve) => {
      let done = false;
      formModal({
        title, size: 'sm', fields: `<p style="margin:0 0 6px;color:var(--text-2)">${text}</p>`, submit: ok, danger,
        onSubmit: () => { done = true; resolve(true); },
        onClose: () => { if (!done) resolve(false); },
      });
    });
  }

  function infoModal(title, html) {
    openModal({ title, size: 'sm', body: `<div class="modal-body">${html}</div><div class="modal-foot"><button class="btn primary" data-close>OK</button></div>` });
  }

  function closeMenus() { $$('.dd-menu').forEach((m) => m.remove()); }
  function openMenu(anchor, items, opts = {}) {
    const open = anchor.parentElement.querySelector('.dd-menu');
    closeMenus();
    if (open) return; // toggle
    const m = document.createElement('div');
    m.className = `dd-menu${opts.up ? ' up' : ''}`;
    m.innerHTML = items.filter(Boolean).map((it, i) => {
      if (it.sep) return '<hr>';
      if (it.lbl) return `<div class="lbl">${esc(it.lbl)}</div>`;
      const inner = `${icon(it.icon || 'file')}<span>${esc(it.label)}</span>${it.small ? `<small>${esc(it.small)}</small>` : ''}`;
      if (it.href) return `<a href="${esc(it.href)}" ${it.download ? 'download' : ''} data-i="${i}">${inner}</a>`;
      return `<button type="button" data-i="${i}" class="${it.danger ? 'danger' : ''}">${inner}</button>`;
    }).join('');
    const list = items.filter(Boolean);
    m.addEventListener('click', (e) => {
      const el = e.target.closest('[data-i]');
      if (!el) return;
      const it = list[+el.dataset.i];
      if (it.onClick) { e.preventDefault(); it.onClick(); }
      setTimeout(closeMenus, 0);
    });
    anchor.parentElement.appendChild(m);
  }
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.dd')) closeMenus();
    if (!e.target.closest('.search')) hideSearch();
  });

  async function copyText(t) {
    try {
      await navigator.clipboard.writeText(t);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = t; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
    }
    toast(`„${t}“ kopiert`);
  }

  async function readFileText(file) {
    const buf = await file.arrayBuffer();
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-1252').decode(buf); }
  }

  function setTitle(t) { document.title = t ? `${t} · IPAM` : 'IPAM'; }

  // ================================================================== Boot & login
  const appEl = $('#app');

  async function boot() {
    const s = await api('GET', 'api/session').catch((e) => {
      appEl.innerHTML = `<div class="auth"><div class="auth-card"><h1>Keine Verbindung</h1><p>${esc(e.message)}</p><button class="btn primary" onclick="location.reload()">Erneut versuchen</button></div></div>`;
      return null;
    });
    if (!s) return;
    Object.assign(state, { csrf: s.csrf, version: s.version, xlsx: s.xlsx, statuses: s.statuses, mapMax: s.map_max, scanMax: s.scan_max, user: s.user });
    if (!s.user) return renderAuth(s.setup_required);
    renderShell();
    await refreshMeta();
    route();
  }

  function renderAuth(setup) {
    setTitle(setup ? 'Einrichtung' : 'Anmelden');
    appEl.innerHTML = `<div class="auth"><form class="auth-card" id="auth-form" novalidate>
      <img class="logo" src="static/favicon.svg" alt="">
      <h1>${setup ? 'Willkommen bei IPAM' : 'Anmelden'}</h1>
      <p>${setup ? 'Lege den ersten Administrator an. Der Zugang wird lokal gespeichert und funktioniert unabhängig von SSO.' : 'Melde dich mit deinem lokalen Konto an.'}</p>
      <div class="err hidden"></div>
      <div class="field"><label>Benutzername</label><input class="input" name="username" autocomplete="username" required ${setup ? 'value="admin"' : ''}></div>
      <div class="field"><label>Passwort</label><input class="input" type="password" name="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required></div>
      ${setup ? '<div class="field"><label>Passwort wiederholen</label><input class="input" type="password" name="password2" autocomplete="new-password" required><span class="hint">Mindestens 8 Zeichen.</span></div>' : ''}
      <button class="btn primary" type="submit">${setup ? 'Admin anlegen & starten' : 'Anmelden'}</button>
      <div class="auth-foot">pyIPAM v${esc(state.version)}</div>
    </form></div>`;
    const f = $('#auth-form');
    setTimeout(() => (setup ? f.password : f.username).focus(), 30);
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('.err', f);
      const btn = $('button[type=submit]', f);
      err.classList.add('hidden');
      const d = Object.fromEntries(new FormData(f));
      try {
        if (setup && d.password !== d.password2) throw new Error('Passwörter stimmen nicht überein');
        btn.disabled = true;
        const s = await api('POST', setup ? 'api/setup' : 'api/login', { username: d.username, password: d.password });
        state.csrf = s.csrf;
        state.user = s.user;
        renderShell();
        await refreshMeta();
        route();
      } catch (ex) {
        err.textContent = ex.message;
        err.classList.remove('hidden');
        f.password.select();
      } finally { btn.disabled = false; }
    });
  }

  async function logout() {
    const r = await api('POST', 'api/logout', {});
    state.csrf = r.csrf;
    state.user = null;
    cur = null;
    location.hash = '#/';
    renderAuth(false);
  }

  // ================================================================== Shell
  function renderShell() {
    const u = state.user;
    const theme = document.documentElement.getAttribute('data-theme');
    appEl.innerHTML = `<div class="shell" id="shell">
      <aside class="sidebar">
        <div class="brand"><img class="logo" src="static/favicon.svg" alt=""> IPAM <small>v${esc(state.version)}</small></div>
        <nav class="nav" id="nav">
          <a href="#/" data-nav="dash">${icon('grid')} Übersicht</a>
          <a href="#/vlans" data-nav="vlans">${icon('layers')} VLANs</a>
          <a href="#/log" data-nav="log">${icon('clock')} Änderungsprotokoll</a>
          ${canEdit() ? `<a href="#/admin" data-nav="admin">${icon('sliders')} Verwaltung</a>` : ''}
        </nav>
        <div class="side-head"><span>Subnetze</span>${canEdit() ? `<button class="btn ghost icon sm" data-act="new-subnet" title="Subnetz anlegen">${icon('plus')}</button>` : ''}</div>
        <div class="tree" id="tree"></div>
        <div class="side-foot">
          <div class="avatar">${esc(u.username.slice(0, 1).toUpperCase())}</div>
          <div class="who"><b>${esc(u.username)}</b><span>${esc(ROLE_LABEL[u.role] || u.role)}</span></div>
          <button class="btn ghost icon sm" id="theme-btn" title="Hell / Dunkel">${icon(theme === 'dark' ? 'sun' : 'moon')}</button>
          <div class="dd"><button class="btn ghost icon sm" id="user-menu" title="Konto">${icon('more')}</button></div>
        </div>
      </aside>
      <div class="main">
        <header class="topbar">
          <button class="btn ghost icon menu-btn" id="menu-btn" title="Menü">${icon('menu')}</button>
          <div class="search">${icon('search')}<input id="q" placeholder="IP, Hostname, MAC oder Netz suchen…" autocomplete="off" spellcheck="false"><kbd>/</kbd>
            <div class="search-results hidden" id="qres"></div></div>
          <div class="spacer"></div>
          <div class="dd"><button class="btn" id="export-all">${icon('download')} Export</button></div>
        </header>
        <section class="view" id="view"></section>
      </div>
    </div>`;

    $('#theme-btn').addEventListener('click', (e) => {
      const t = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', t);
      try { localStorage.setItem('ipam.theme', t); } catch { /* ignore */ }
      e.currentTarget.innerHTML = icon(t === 'dark' ? 'sun' : 'moon');
    });
    $('#user-menu').addEventListener('click', (e) => openMenu(e.currentTarget, [
      { lbl: u.username },
      { label: 'Passwort ändern', icon: 'key', onClick: passwordModal },
      { sep: true },
      { label: 'Abmelden', icon: 'logout', onClick: logout, danger: true },
    ], { up: true }));
    $('#export-all').addEventListener('click', (e) => openMenu(e.currentTarget, [
      { lbl: 'Alle Netze exportieren' },
      state.xlsx && { label: 'Excel (.xlsx)', small: 'ein Blatt pro Netz', icon: 'sheet', href: 'api/export/all?format=xlsx', download: true },
      state.xlsx && { label: 'Excel inkl. freier IPs', small: 'Offline-Liste', icon: 'sheet', href: 'api/export/all?format=xlsx&free=1', download: true },
      { label: 'CSV (Excel, Semikolon)', icon: 'file', href: 'api/export/all', download: true },
      { label: 'CSV inkl. freier IPs', icon: 'file', href: 'api/export/all?free=1', download: true },
      isAdmin() && { sep: true },
      isAdmin() && { lbl: 'Vollständige Sicherung' },
      isAdmin() && { label: 'JSON-Backup', small: 'wiederherstellbar', icon: 'db', href: 'api/backup/json', download: true },
      isAdmin() && { label: 'SQLite-Datenbank', icon: 'db', href: 'api/backup/db', download: true },
    ]));
    $('#menu-btn').addEventListener('click', () => $('#shell').classList.toggle('nav-open'));
    $('.sidebar').addEventListener('click', (e) => { if (e.target.closest('a')) $('#shell').classList.remove('nav-open'); });
    $('#tree').addEventListener('click', (e) => {
      const h = e.target.closest('.tree-sec-head');
      if (!h) return;
      const id = h.dataset.sec;
      state.collapsed[id] = !state.collapsed[id];
      save('ipam.collapsed', state.collapsed);
      h.parentElement.classList.toggle('collapsed', state.collapsed[id]);
    });

    const view = $('#view');
    view.addEventListener('click', onViewClick);
    view.addEventListener('input', onViewInput);
    view.addEventListener('change', onViewChange);
    view.addEventListener('mouseover', onTileHover);
    view.addEventListener('mousemove', moveTooltip);
    view.addEventListener('mouseout', (e) => { if (e.target.closest('.tile')) $('#tooltip').hidden = true; });
    $('.sidebar').addEventListener('click', onViewClick);
    setupSearch();
  }

  async function refreshMeta() {
    const [subnets, sections, vlans] = await Promise.all([api('GET', 'api/subnets'), api('GET', 'api/sections'), api('GET', 'api/vlans')]);
    Object.assign(state, { subnets, sections, vlans });
    renderTree();
  }

  function renderTree() {
    const tree = $('#tree');
    if (!tree) return;
    const activeId = cur ? cur.id : null;
    const html = state.sections.map((sec) => {
      const items = state.subnets.filter((s) => s.section_id === sec.id);
      const kids = (pid) => items.filter((s) => s.parent_id === pid);
      const out = [];
      const walk = (pid, depth) => kids(pid).forEach((s) => {
        out.push(`<a class="tree-item depth-${Math.min(depth, 4)} ${s.id === activeId ? 'active' : ''}" href="#/subnet/${s.id}" title="${esc(s.cidr)} ${esc(s.name)}">
          <span class="cidr">${esc(s.cidr)}</span><span class="pct">${s.version === 4 ? `${Math.round(s.usage)}%` : `${s.used}`}</span>
          ${s.name ? `<span class="tname">${esc(s.name)}</span>` : ''}</a>`);
        walk(s.id, depth + 1);
      });
      walk(null, 0);
      return `<div class="tree-section ${state.collapsed[sec.id] ? 'collapsed' : ''}">
        <button class="tree-sec-head" data-sec="${sec.id}">${icon('chev', 'chev')}${icon('folder')} ${esc(sec.name)}<span class="count">${items.length}</span></button>
        <div class="tree-items">${out.join('') || '<div class="tree-empty">Noch keine Subnetze</div>'}</div></div>`;
    }).join('');
    tree.innerHTML = html;
  }

  function markNav(key) {
    $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === key));
    $$('.tree-item').forEach((a) => a.classList.toggle('active', key === 'subnet' && cur && a.getAttribute('href') === `#/subnet/${cur.id}`));
  }

  // ================================================================== Router
  async function route() {
    if (!state.user) return;
    const h = location.hash.replace(/^#/, '') || '/';
    const [path, qs] = h.split('?');
    const parts = path.split('/').filter(Boolean);
    const params = new URLSearchParams(qs || '');
    const view = $('#view');
    $('#tooltip').hidden = true;
    closeMenus();
    try {
      if (!parts.length) { markNav('dash'); cur = null; await viewDashboard(); }
      else if (parts[0] === 'subnet') { await viewSubnet(Number(parts[1]), params); markNav('subnet'); }
      else if (parts[0] === 'vlans') { markNav('vlans'); cur = null; await viewVlans(); }
      else if (parts[0] === 'log') { markNav('log'); cur = null; await viewLog(); }
      else if (parts[0] === 'admin') { markNav('admin'); cur = null; await viewAdmin(parts[1] || (isAdmin() ? 'users' : 'sections')); }
      else { view.innerHTML = emptyState('alert', 'Seite nicht gefunden'); }
    } catch (e) {
      view.innerHTML = `<div class="card"><div class="empty-state">${icon('alert')}<div>${esc(e.message)}</div><p><a href="#/">Zur Übersicht</a></p></div></div>`;
    }
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);

  const emptyState = (ic, text, extra = '') => `<div class="empty-state">${icon(ic)}<div>${text}</div>${extra}</div>`;

  // ================================================================== Dashboard
  async function viewDashboard() {
    setTitle('Übersicht');
    const d = await api('GET', 'api/dashboard');
    const view = $('#view');
    if (!d.subnet_count) {
      view.innerHTML = `<div class="card"><div class="welcome">
        <img class="logo" src="static/favicon.svg" alt="" style="width:56px;height:56px;margin:0 auto">
        <h2>Los geht's</h2><p>Lege dein erstes Subnetz an, z. B. <span class="mono">192.168.1.0/24</span>. Danach kannst du Adressen direkt in der Belegungskarte per Klick erfassen.</p>
        ${canEdit() ? `<button class="btn primary" data-act="new-subnet">${icon('plus')} Erstes Subnetz anlegen</button>` : ''}
      </div></div>`;
      return;
    }
    const pct = d.v4_capacity ? (d.v4_used * 100) / d.v4_capacity : 0;
    const total = d.address_count || 0;
    const stack = Object.keys(state.statuses).map((k) => (total ? `<i style="width:${(d.status[k] * 100) / total}%;background:${STATUS_COLOR[k]}"></i>` : '')).join('');
    view.innerHTML = `
      <div class="page-head"><div class="titles"><div class="eyebrow">Hallo ${esc(state.user.username)} 👋</div><h1>Übersicht</h1></div>
        <div class="actions">${canEdit() ? `<button class="btn primary" data-act="new-subnet">${icon('plus')} Subnetz</button>` : ''}</div></div>
      <div class="stats">
        <div class="stat"><div class="k">${icon('network')} Subnetze</div><div class="v">${fmtNum(d.subnet_count)}</div><div class="s">in ${d.section_count} Bereich${d.section_count === 1 ? '' : 'en'}</div></div>
        <div class="stat"><div class="k">${icon('grid')} Adressen</div><div class="v">${fmtNum(total)}</div><div class="s">${fmtNum(d.status.active || 0)} aktiv</div></div>
        <div class="stat"><div class="k">${icon('layers')} VLANs</div><div class="v">${fmtNum(d.vlan_count)}</div><div class="s"><a href="#/vlans">verwalten</a></div></div>
        <div class="stat wide"><div class="k">IPv4-Auslastung (Endnetze)</div><div class="v">${pct.toFixed(1).replace('.', ',')} %</div>
          <div class="s">${fmtNum(d.v4_used)} von ${fmtNum(d.v4_capacity)} nutzbaren Adressen</div><div class="bar ${barCls(pct)}"><i style="width:${Math.min(100, pct)}%"></i></div></div>
      </div>
      <div class="dash-grid">
        <div class="card"><div class="card-head"><h2>Am stärksten ausgelastet</h2></div><div class="card-body flush">
          ${d.top.map((s) => `<a class="util-row" href="#/subnet/${s.id}"><div><div class="mono">${esc(s.cidr)}</div><div class="muted" style="font-size:12.5px">${esc(s.name || s.section_name)}</div></div>
            <div class="bar ${barCls(s.usage)}"><i style="width:${s.usage}%"></i></div><div class="pct">${s.used} / ${capLabel(s)}</div></a>`).join('')}
        </div></div>
        <div>
          <div class="card"><div class="card-head"><h2>Adressen nach Status</h2></div><div class="card-body">
            <div class="bar stack" style="height:10px;margin-top:2px">${stack}</div>
            <div class="status-legend">${Object.entries(state.statuses).map(([k, l]) => `<div><i style="background:${STATUS_COLOR[k]}"></i>${esc(l)}<b>${fmtNum(d.status[k] || 0)}</b></div>`).join('')}</div>
          </div></div>
          <div class="card"><div class="card-head"><h2>Letzte Änderungen</h2><span class="spacer"></span><a href="#/log">Alle anzeigen</a></div>
            <ul class="feed">${d.recent.map(feedItem).join('') || '<li class="muted">Noch keine Änderungen</li>'}</ul></div>
        </div>
      </div>`;
  }

  function feedItem(r) {
    const ic = { create: 'plus', delete: 'trash', update: 'edit', scan: 'radar', import: 'upload', restore: 'restore' }[r.action] || 'clock';
    return `<li><div class="ic ${esc(r.action)}">${icon(ic)}</div><div><div>${esc(r.summary)}</div><div class="meta">${esc(r.username)} · ${ago(r.ts)}</div></div></li>`;
  }

  // ================================================================== Subnet view
  async function viewSubnet(id, params) {
    const d = await api('GET', `api/subnets/${id}`);
    const keep = cur && cur.id === id;
    cur = { id, d, filter: keep ? cur.filter : '', status: keep ? cur.status : '', sort: keep ? cur.sort : { k: 'ip', dir: 1 }, sel: new Set() };
    renderSubnet(params && params.get('ip'));
  }

  async function reloadSubnet() {
    if (!cur) return;
    cur.d = await api('GET', `api/subnets/${cur.id}`);
    cur.sel.clear();
    renderSubnet();
    refreshMeta();
  }

  function renderSubnet(highlightIp) {
    const { subnet: s, calc: c, children, parents, map_enabled: mapOn, scan } = cur.d;
    setTitle(s.cidr);
    const used = s.used;
    const capNum = Number(s.capacity);
    const free = s.version === 4 ? capNum - used : null;
    const canScan = canEdit() && s.version === 4 && capNum <= state.scanMax;
    const crumbs = [`<span>${icon('folder')} ${esc(s.section_name)}</span>`, ...parents.map((p) => `<span>›</span><a href="#/subnet/${p.id}" class="mono">${esc(p.cidr)}</a>`)];
    const meta = [s.location && `Standort: ${esc(s.location)}`, s.dns && `DNS: <span class="mono">${esc(s.dns)}</span>`].filter(Boolean).join(' · ');

    $('#view').innerHTML = `
      <div class="page-head">
        <div class="titles">
          <div class="eyebrow">${crumbs.join(' ')}${s.vlan_number != null ? ` <span class="badge accent">VLAN ${esc(s.vlan_number)}${s.vlan_name ? ` · ${esc(s.vlan_name)}` : ''}</span>` : ''}</div>
          <h1><span class="mono">${esc(s.cidr)}</span>${s.name ? `<span class="sub">${esc(s.name)}</span>` : ''}</h1>
          ${s.description ? `<p class="desc">${esc(s.description)}</p>` : ''}
          ${meta ? `<p class="desc" style="font-size:13px">${meta}</p>` : ''}
        </div>
        <div class="actions">
          ${canEdit() ? `<button class="btn primary" data-act="add-address" title="Adresse manuell anlegen (Taste N)">${icon('plus')} Adresse</button>` : ''}
          ${canScan ? `<button class="btn" data-act="scan" id="scan-btn" title="Alle Hosts per Ping prüfen">${icon('radar')} Scan</button>` : ''}
          <div class="dd"><button class="btn" data-act="export-menu">${icon('download')} Export</button></div>
          ${canEdit() ? `<div class="dd"><button class="btn icon" data-act="subnet-menu" title="Weitere Aktionen">${icon('more')}</button></div>` : ''}
        </div>
      </div>

      <div class="stats">
        <div class="stat wide"><div class="k">Belegung</div><div class="v">${fmtNum(used)} <span class="muted" style="font-size:14px;font-weight:500">von ${capLabel(s)}</span></div>
          <div class="s">${s.version === 4 ? `${fmtNum(free)} frei · ${String(s.usage).replace('.', ',')} % belegt` : 'IPv6-Netz'}</div>
          <div class="bar ${barCls(s.usage)}"><i style="width:${Math.max(s.usage, used ? 1 : 0)}%"></i></div></div>
        <div class="stat"><div class="k">Netzmaske</div><div class="v mono">${esc(c.netmask)}</div><div class="s">/${c.prefix}${c.wildcard !== '–' ? ` · Wildcard ${esc(c.wildcard)}` : ''}</div></div>
        <div class="stat"><div class="k">Gateway</div><div class="v mono">${esc(s.gateway || '–')}</div><div class="s">${s.version === 4 ? `Broadcast ${esc(c.broadcast)}` : '&nbsp;'}</div></div>
        <div class="stat"><div class="k">Hostbereich</div><div class="v mono" title="${esc(c.first)} – ${esc(c.last)}">${esc(c.first)}</div><div class="s mono">bis ${esc(c.last)}</div></div>
        ${s.version === 4 && capNum <= state.scanMax ? `<div class="stat"><div class="k">${icon('radar')} Letzter Scan</div><div class="v" style="font-size:16px">${scan ? ago(scan.ts) : 'noch nie'}</div>
          <div class="s">${scan ? `${scan.alive.length} Hosts online` : 'Ping-Scan über „Scan“'}</div></div>` : ''}
      </div>

      ${children.length ? `<div class="card"><div class="card-head"><h2>${icon('split')} Unternetze <span class="count">${children.length}</span></h2></div>
        <div class="card-body"><div class="children">${children.map((ch) => `<a class="child-card" href="#/subnet/${ch.id}">
          <div class="mono">${esc(ch.cidr)}</div><div class="muted">${esc(ch.name || '—')}${ch.vlan_number != null ? ` · VLAN ${esc(ch.vlan_number)}` : ''}</div>
          <div class="bar ${barCls(ch.usage)}"><i style="width:${ch.usage}%"></i></div><div class="muted" style="margin-top:6px">${ch.used} / ${capLabel(ch)} belegt</div></a>`).join('')}</div></div></div>` : ''}

      <div class="card" id="addr-card">
        <div class="card-head">
          <h2>Adressen <span class="count" id="addr-count"></span></h2>
          ${mapOn ? `<button class="btn sm ghost" data-act="to-map" title="Zur Belegungskarte springen">${icon('grid')} Belegungskarte ↓</button>` : ''}
          <span class="spacer"></span>
          <div class="toolbar">
            <div class="chips" id="status-chips"></div>
            <input class="input" data-act="addr-filter" placeholder="Filtern…" value="${esc(cur.filter)}">
          </div>
        </div>
        <div id="bulkbar"></div>
        <div class="table-wrap" id="addr-table"></div>
      </div>

      ${mapOn ? `<div class="card" id="map-card">
        <div class="card-head"><h2>Adressbelegung</h2><span class="spacer"></span>
          <div class="legend">
            <span><i style="background:var(--surface-2)"></i>frei</span>
            ${Object.entries(state.statuses).map(([k, l]) => `<span><i style="background:${STATUS_COLOR[k]};border-color:transparent"></i>${esc(l)}</span>`).join('')}
            <span><i style="box-shadow:inset 0 0 0 2px var(--st-gateway);border-color:transparent"></i>Gateway</span>
            ${scan ? '<span><i style="border:2px dashed var(--st-found)"></i>online, nicht erfasst</span>' : ''}
          </div></div>
        <div class="card-body">${hostmapHTML()}
          <div class="faint" style="font-size:12.5px;margin-top:6px">${canEdit() ? 'Tipp: Freie Adresse anklicken, um sie direkt zu belegen. Belegte Adresse anklicken zum Bearbeiten.' : 'Belegte Adresse anklicken, um sie in der Liste zu zeigen.'}${scan ? ' Weißer Punkt = antwortet auf Ping.' : ''}</div>
        </div></div>`
        : `<div class="card"><div class="card-body faint">${icon('grid')} Die Belegungskarte wird für IPv4-Netze bis /20 angezeigt. Für dieses Netz nutze „+ Adresse“ bzw. „Nächste freie“.</div></div>`}
    `;
    renderAddrTable();
    if (highlightIp) {
      const row = $(`#addr-table tr[data-ip="${CSS.escape(highlightIp)}"]`);
      if (row) { row.classList.add('flash'); row.scrollIntoView({ block: 'center' }); }
    }
  }

  function filteredAddresses() {
    const { addresses } = cur.d;
    const q = cur.filter.trim().toLowerCase();
    let list = addresses.filter((a) => (!cur.status || a.status === cur.status)
      && (!q || [a.ip, a.hostname, a.description, a.mac, a.owner, a.device_type, a.note].some((v) => (v || '').toLowerCase().includes(q))));
    const { k, dir } = cur.sort;
    const key = k === 'ip' ? 'ip_key' : k;
    const cmp = k === 'ip'
      ? (a, b) => (a.ip_key < b.ip_key ? -1 : a.ip_key > b.ip_key ? 1 : 0)
      : (a, b) => String(a[key] || '').localeCompare(String(b[key] || ''), 'de', { numeric: true }) || (a.ip_key < b.ip_key ? -1 : 1);
    list = [...list].sort((a, b) => cmp(a, b) * dir);
    return list;
  }

  function renderAddrTable() {
    const { addresses, subnet: s, scan } = cur.d;
    const alive = new Set((scan ? scan.alive : []).map((x) => x.ip));
    const counts = {};
    addresses.forEach((a) => { counts[a.status] = (counts[a.status] || 0) + 1; });
    $('#status-chips').innerHTML = [['', 'Alle', addresses.length], ...Object.entries(state.statuses).map(([k, l]) => [k, l, counts[k] || 0])]
      .filter(([k, , n]) => !k || n)
      .map(([k, l, n]) => `<button class="chip ${cur.status === k ? 'on' : ''}" data-act="status-chip" data-s="${k}">${k ? `<span class="dot" style="background:${STATUS_COLOR[k]}"></span>` : ''}${esc(l)} ${n}</button>`).join('');

    const list = filteredAddresses();
    $('#addr-count').textContent = list.length === addresses.length ? addresses.length : `${list.length} / ${addresses.length}`;
    const th = (k, l) => `<th class="sortable" data-act="sort" data-k="${k}">${l}${cur.sort.k === k ? `<span class="arrow">${cur.sort.dir > 0 ? '▲' : '▼'}</span>` : ''}</th>`;
    const ed = canEdit();
    if (!addresses.length) {
      $('#addr-table').innerHTML = emptyState('grid', 'Noch keine Adressen in diesem Netz.',
        ed ? `<p><button class="btn primary" data-act="add-address">${icon('plus')} Adresse anlegen</button></p>` : '');
    } else if (!list.length) {
      $('#addr-table').innerHTML = emptyState('search', 'Keine Treffer für diesen Filter.');
    } else {
      $('#addr-table').innerHTML = `<table class="t"><thead><tr>
        ${ed ? `<th class="chk"><input type="checkbox" data-act="sel-all" ${list.every((a) => cur.sel.has(a.id)) ? 'checked' : ''}></th>` : ''}
        ${th('ip', 'IP-Adresse')}${th('hostname', 'Hostname')}${th('status', 'Status')}${th('description', 'Beschreibung')}${th('mac', 'MAC')}${th('device_type', 'Typ')}${th('owner', 'Besitzer')}${th('last_seen', 'Zuletzt online')}<th></th>
      </tr></thead><tbody>${list.map((a) => `<tr data-ip="${esc(a.ip)}">
        ${ed ? `<td class="chk"><input type="checkbox" data-act="sel" data-id="${a.id}" ${cur.sel.has(a.id) ? 'checked' : ''}></td>` : ''}
        <td class="ip">${alive.has(a.ip) ? '<span class="online-dot" title="Antwortet auf Ping"></span>' : ''}<span class="copy" data-act="copy" data-v="${esc(a.ip)}" title="Kopieren">${esc(a.ip)}</span>
          ${a.ip === s.gateway ? ' <span class="badge outline">GW</span>' : ''}
          ${a.subnet_id !== s.id ? ` <a class="badge outline" href="#/subnet/${a.subnet_id}" title="Gehört zu Unternetz">${esc(a.subnet_cidr)}</a>` : ''}</td>
        <td><b style="font-weight:600">${esc(a.hostname)}</b></td>
        <td><span class="badge st-${esc(a.status)}"><span class="dot"></span>${esc(state.statuses[a.status] || a.status)}</span></td>
        <td><div class="trunc" title="${esc(a.description)}${a.note ? `\n\n${esc(a.note)}` : ''}">${esc(a.description)}${a.note ? ' <span class="faint">📝</span>' : ''}</div></td>
        <td class="mono nowrap">${a.mac ? `<span class="copy" data-act="copy" data-v="${esc(a.mac)}">${esc(a.mac)}</span>` : ''}</td>
        <td>${esc(a.device_type)}</td>
        <td>${esc(a.owner)}</td>
        <td class="nowrap muted" title="${esc(fmtDate(a.last_seen))}">${a.last_seen ? ago(a.last_seen) : '–'}</td>
        <td class="actions-col"><div class="row-actions">
          <button class="btn ghost icon sm" data-act="edit-addr" data-id="${a.id}" title="${ed ? 'Bearbeiten' : 'Details'}">${icon('edit')}</button>
          ${ed ? `<button class="btn ghost icon sm danger" data-act="del-addr" data-id="${a.id}" title="Löschen">${icon('trash')}</button>` : ''}
        </div></td></tr>`).join('')}</tbody></table>`;
    }
    renderBulkbar();
  }

  function renderBulkbar() {
    const n = cur.sel.size;
    $('#bulkbar').innerHTML = n ? `<div class="bulkbar">${n} ausgewählt <span class="spacer" style="flex:1"></span>
      <div class="dd"><button class="btn sm" data-act="bulk-status">Status setzen</button></div>
      <button class="btn sm danger" data-act="bulk-delete">${icon('trash')} Löschen</button>
      <button class="btn sm ghost" data-act="bulk-clear">Aufheben</button></div>` : '';
  }

  function hostmapHTML() {
    const { calc: c, subnet: s, addresses, scan, children } = cur.d;
    const base = c.network_int;
    const size = Number(c.size);
    const sys = c.prefix <= 30;
    const byIp = new Map(addresses.map((a) => [a.ip, a]));
    const alive = new Map((scan ? scan.alive : []).map((x) => [x.ip, x]));
    const kids = children.map((ch) => {
      const [n, p] = ch.cidr.split('/');
      const st = ipToInt(n);
      return [st, st + 2 ** (32 - Number(p)) - 1];
    });
    let html = '';
    for (let b = 0; b < size; b += 256) {
      const end = Math.min(b + 256, size);
      const tiles = [];
      for (let i = b; i < end; i++) {
        const n = base + i;
        const ip = intToIp(n);
        const a = byIp.get(ip);
        const cls = ['tile'];
        if (sys && (i === 0 || i === size - 1)) cls.push('sys');
        else if (a) {
          cls.push(a.status);
          if (scan) cls.push(alive.has(ip) ? 'alive' : (a.status === 'active' ? 'dead' : ''));
        } else if (alive.has(ip)) cls.push('found');
        else cls.push('free');
        if (ip === s.gateway) cls.push('gw');
        if (kids.some(([x, y]) => n >= x && n <= y)) cls.push('child');
        tiles.push(`<div class="${cls.join(' ')}" data-ip="${ip}">${n % 256}</div>`);
      }
      html += `<div class="hm-block">${size > 256 ? `<h4>${intToIp(base + b)}/24</h4>` : ''}<div class="hostmap cols-16">${tiles.join('')}</div></div>`;
    }
    return html;
  }

  function onTileHover(e) {
    const t = e.target.closest('.tile');
    if (!t || !cur) return;
    const ip = t.dataset.ip;
    const a = cur.d.addresses.find((x) => x.ip === ip);
    const sc = cur.d.scan && cur.d.scan.alive.find((x) => x.ip === ip);
    const c = cur.d.calc;
    let html = `<b>${esc(ip)}</b>`;
    if (t.classList.contains('sys')) html += `<br>${ip === c.network ? 'Netzadresse' : 'Broadcast'}`;
    else if (a) {
      html += `${a.hostname ? ` · ${esc(a.hostname)}` : ''}<br>${esc(state.statuses[a.status])}${a.description ? ` – ${esc(a.description)}` : ''}`;
      if (sc) html += '<br>🟢 antwortet auf Ping';
    } else if (sc) html += `<br>Online, aber nicht erfasst${sc.dns ? `<br>DNS: ${esc(sc.dns)}` : ''}${canEdit() ? '<br>Klicken zum Übernehmen' : ''}`;
    else html += canEdit() ? '<br>frei – klicken zum Belegen' : '<br>frei';
    if (ip === cur.d.subnet.gateway) html += '<br>Gateway';
    const tt = $('#tooltip');
    tt.innerHTML = html;
    tt.hidden = false;
    moveTooltip(e);
  }
  function moveTooltip(e) {
    const tt = $('#tooltip');
    if (tt.hidden) return;
    const x = Math.min(e.clientX + 14, window.innerWidth - tt.offsetWidth - 8);
    const y = e.clientY + 18 + tt.offsetHeight > window.innerHeight ? e.clientY - tt.offsetHeight - 10 : e.clientY + 18;
    tt.style.left = `${x}px`;
    tt.style.top = `${y}px`;
  }

  function onTileClick(t) {
    const ip = t.dataset.ip;
    if (t.classList.contains('sys')) return;
    const a = cur.d.addresses.find((x) => x.ip === ip);
    $('#tooltip').hidden = true;
    if (a) {
      if (canEdit()) addressModal({ address: a });
      else {
        const row = $(`#addr-table tr[data-ip="${CSS.escape(ip)}"]`);
        if (row) { row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash'); row.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      }
      return;
    }
    if (!canEdit()) return;
    const sc = cur.d.scan && cur.d.scan.alive.find((x) => x.ip === ip);
    addressModal({ ip, preset: sc ? { hostname: sc.dns || '' } : {} });
  }

  // ------------------------------------------------------------------ Address dialog
  function addressModal({ address = null, ip = null, preset = {} }) {
    const s = cur.d.subnet;
    const c = cur.d.calc;
    const a = address || {};
    const isNew = !address;
    const quick = isNew && !!ip;
    const ed = canEdit();
    const v = (k) => esc(a[k] ?? preset[k] ?? '');
    const st = a.status || preset.status || 'active';
    const seg = `<div class="segmented">${Object.entries(state.statuses).map(([k, l]) => `<label><input type="radio" name="status" value="${k}" ${k === st ? 'checked' : ''} ${ed ? '' : 'disabled'}><span><i class="sdot" style="background:${STATUS_COLOR[k]}"></i>${esc(l)}</span></label>`).join('')}</div>`;
    const dis = ed ? '' : 'disabled';
    const fields = `
      ${quick ? `<div class="ip-hero">${icon('plus')}<div><div class="mono">${esc(ip)}</div><div class="muted">${esc(s.cidr)}${s.name ? ` · ${esc(s.name)}` : ''}</div></div></div><input type="hidden" name="ip" value="${esc(ip)}">`
        : `<div class="field"><label>IP-Adresse</label><div class="input-group"><input class="input mono" name="ip" value="${v('ip')}" placeholder="${esc(c.first)}" ${dis} ${isNew ? 'autofocus' : ''}>
           ${isNew ? `<button type="button" class="btn" data-x="nextfree" title="Nächste freie Adresse einsetzen">${icon('wand')} Nächste freie</button>` : ''}</div></div>`}
      <div class="field"><label>Hostname</label><div class="input-group"><input class="input" name="hostname" value="${v('hostname')}" placeholder="z. B. nas01" ${quick ? 'autofocus' : ''} ${dis}>
        ${ed ? `<button type="button" class="btn icon" data-x="dns" title="Hostname per Reverse-DNS ermitteln">${icon('globe')}</button>` : ''}</div></div>
      <div class="field"><label>Status</label>${seg}</div>
      <div class="field"><label>Beschreibung</label><input class="input" name="description" value="${v('description')}" ${dis}></div>
      <div class="grid-2">
        <div class="field"><label>MAC-Adresse</label><input class="input mono" name="mac" value="${v('mac')}" placeholder="AA:BB:CC:DD:EE:FF" ${dis}></div>
        <div class="field"><label>Gerätetyp</label><input class="input" name="device_type" list="dtypes" value="${v('device_type')}" placeholder="Server, Switch, AP …" ${dis}>
          <datalist id="dtypes">${[...new Set(['Server', 'Switch', 'Router', 'Firewall', 'Access Point', 'Drucker', 'NAS', 'VM', 'Container', 'Client', 'IoT', 'Kamera', ...cur.d.device_types])].map((t) => `<option value="${esc(t)}">`).join('')}</datalist></div>
      </div>
      <div class="field"><label>Besitzer / Verantwortlich</label><input class="input" name="owner" value="${v('owner')}" ${dis}></div>
      <div class="field"><label>Notiz</label><textarea class="input" name="note" rows="2" ${dis}>${v('note')}</textarea></div>
      ${!isNew ? `<div class="faint" style="font-size:12px;margin:-4px 0 10px">Angelegt ${fmtDate(a.created_at)} · geändert ${fmtDate(a.updated_at)}${a.updated_by ? ` von ${esc(a.updated_by)}` : ''}${a.last_seen ? ` · zuletzt online ${fmtDate(a.last_seen)}` : ''}</div>` : ''}
      ${isNew && !quick ? '<label class="check" style="margin-bottom:6px"><input type="checkbox" name="again"> Danach direkt die nächste freie Adresse anlegen</label>' : ''}`;

    const m = formModal({
      title: isNew ? 'Adresse hinzufügen' : (ed ? 'Adresse bearbeiten' : 'Adresse'),
      sub: !isNew ? `<span class="mono">${esc(a.ip)}</span> in ${esc(a.subnet_cidr || s.cidr)}` : (quick ? '' : `in <span class="mono">${esc(s.cidr)}</span>`),
      fields,
      submit: isNew ? 'Hinzufügen' : 'Speichern',
      left: !isNew && ed ? `<button type="button" class="btn danger" data-x="delete">${icon('trash')} Löschen</button>` : '',
      onSubmit: async (f, mm) => {
        if (!ed) return true;
        const payload = { subnet_id: s.id, ip: f.ip, hostname: f.hostname, status: f.status, description: f.description, mac: f.mac, device_type: f.device_type, owner: f.owner, note: f.note };
        if (isNew) await api('POST', 'api/addresses', payload);
        else await api('PUT', `api/addresses/${a.id}`, payload);
        toast(`${f.ip}${f.hostname ? ` (${f.hostname})` : ''} gespeichert`);
        await reloadSubnet();
        if (isNew && f.again) {
          ['hostname', 'description', 'mac', 'note'].forEach((k) => { mm.form[k].value = ''; });
          await fillNextFree(mm.form.ip);
          mm.form.hostname.focus();
          return false;
        }
        return true;
      },
      onMount: (mm) => {
        mm.el.addEventListener('click', async (e) => {
          const b = e.target.closest('[data-x]');
          if (!b) return;
          if (b.dataset.x === 'nextfree') fillNextFree(mm.form.ip, true);
          if (b.dataset.x === 'dns') {
            const ipv = mm.form.ip.value.trim();
            if (!ipv) return;
            b.disabled = true;
            try {
              const r = await api('GET', `api/dns?ip=${encodeURIComponent(ipv)}`);
              if (r.hostname) { mm.form.hostname.value = r.hostname; toast(`PTR: ${r.hostname}`); } else toast('Kein PTR-Eintrag gefunden', 'err');
            } catch (ex) { toast(ex.message, 'err'); } finally { b.disabled = false; }
          }
          if (b.dataset.x === 'delete') {
            mm.close();
            deleteAddress(a);
          }
        });
        if (isNew && !quick) fillNextFree(mm.form.ip, false);
      },
    });
    return m;
  }

  async function fillNextFree(input, notify = true) {
    try {
      const r = await api('GET', `api/subnets/${cur.id}/next-free`);
      input.value = r.ip;
      if (document.activeElement === input || notify) { input.focus(); input.select(); }
    } catch (e) { if (notify) toast(e.message, 'err'); }
  }

  async function deleteAddress(a) {
    if (!(await confirmBox({ title: 'Adresse löschen?', text: `<span class="mono">${esc(a.ip)}</span>${a.hostname ? ` (${esc(a.hostname)})` : ''} wird entfernt.` }))) return;
    try {
      await api('DELETE', `api/addresses/${a.id}`);
      toast(`${a.ip} gelöscht`);
      reloadSubnet();
    } catch (e) { toast(e.message, 'err'); }
  }

  // ------------------------------------------------------------------ Subnet dialog
  function calcPreview(v) {
    const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(v.trim());
    if (!m) return v.includes(':') ? 'IPv6-Netz' : '';
    const p = Number(m[2]);
    if (p > 32 || m[1].split('.').some((o) => Number(o) > 255)) return '⚠ ungültig';
    const ip = ipToInt(m[1]);
    const size = 2 ** (32 - p);
    const net = Math.floor(ip / size) * size;
    const usable = p <= 30 ? size - 2 : size;
    const norm = `${intToIp(net)}/${p}`;
    return `${norm !== v.trim() ? `→ ${norm} · ` : ''}${intToIp(net)} – ${intToIp(net + size - 1)} · ${fmtNum(usable)} nutzbar`;
  }

  function subnetModal(sub = null, preset = {}) {
    const isNew = !sub;
    const x = sub || preset;
    const v = (k) => esc(x[k] ?? '');
    const secSel = state.sections.map((s) => `<option value="${s.id}" ${s.id === (x.section_id ?? state.sections[0]?.id) ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
    const vlanSel = `<option value="">– kein VLAN –</option>${state.vlans.map((vl) => `<option value="${vl.id}" ${vl.id === x.vlan_id ? 'selected' : ''}>${esc(vl.number)}${vl.name ? ` – ${esc(vl.name)}` : ''}</option>`).join('')}`;
    formModal({
      title: isNew ? (preset.parent ? 'Unternetz anlegen' : 'Subnetz anlegen') : 'Subnetz bearbeiten',
      sub: preset.parent ? `innerhalb von <span class="mono">${esc(preset.parent)}</span>` : '',
      fields: `
        <div class="field"><label>Netz (CIDR)</label><input class="input mono" name="cidr" value="${v('cidr')}" placeholder="192.168.10.0/24" autofocus>
          <div class="calc-preview" id="calcp">${x.cidr ? esc(calcPreview(x.cidr)) : ''}</div></div>
        <div class="field"><label>Name</label><input class="input" name="name" value="${v('name')}" placeholder="z. B. LAN, Server, IoT, Management"></div>
        <div class="grid-2">
          <div class="field"><label>Bereich</label><select class="input" name="section_id">${secSel}</select></div>
          <div class="field"><label>VLAN</label><select class="input" name="vlan_id">${vlanSel}</select></div>
        </div>
        <div class="grid-2">
          <div class="field"><label>Gateway</label><input class="input mono" name="gateway" value="${v('gateway')}" placeholder="optional"></div>
          <div class="field"><label>DNS-Server</label><input class="input mono" name="dns" value="${v('dns')}" placeholder="optional"></div>
        </div>
        <div class="field"><label>Standort</label><input class="input" name="location" value="${v('location')}" placeholder="optional, z. B. Keller-Rack"></div>
        <div class="field"><label>Beschreibung</label><textarea class="input" name="description" rows="2">${v('description')}</textarea></div>`,
      submit: isNew ? 'Anlegen' : 'Speichern',
      onMount: (m) => {
        const inp = m.form.cidr;
        const gw = m.form.gateway;
        const upd = () => {
          $('#calcp', m.el).textContent = calcPreview(inp.value);
          const mm = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(inp.value.trim());
          if (mm && Number(mm[2]) <= 30) {
            const size = 2 ** (32 - Number(mm[2]));
            gw.placeholder = `z. B. ${intToIp(Math.floor(ipToInt(mm[1]) / size) * size + 1)}`;
          }
        };
        inp.addEventListener('input', upd);
        upd();
      },
      onSubmit: async (f) => {
        const payload = { ...f, section_id: Number(f.section_id), vlan_id: f.vlan_id ? Number(f.vlan_id) : null };
        let id = sub && sub.id;
        if (isNew) id = (await api('POST', 'api/subnets', payload)).id;
        else await api('PUT', `api/subnets/${sub.id}`, payload);
        toast(isNew ? 'Subnetz angelegt' : 'Subnetz gespeichert');
        await refreshMeta();
        if (location.hash === `#/subnet/${id}`) reloadSubnet(); else location.hash = `#/subnet/${id}`;
      },
    });
  }

  async function deleteSubnet() {
    const { subnet: s, parents } = cur.d;
    const own = cur.d.addresses.filter((a) => a.subnet_id === s.id).length;
    const parent = parents[parents.length - 1];
    const text = `<span class="mono">${esc(s.cidr)}</span>${s.name ? ` „${esc(s.name)}“` : ''} wird gelöscht.<br><br>${own
      ? (parent ? `Die ${own} Adresse(n) werden in das übergeordnete Netz <span class="mono">${esc(parent.cidr)}</span> verschoben.` : `<b>Die ${own} Adresse(n) werden ebenfalls gelöscht.</b>`)
      : 'Das Netz enthält keine eigenen Adressen.'}`;
    if (!(await confirmBox({ title: 'Subnetz löschen?', text }))) return;
    try {
      await api('DELETE', `api/subnets/${s.id}`);
      toast('Subnetz gelöscht');
      cur = null;
      await refreshMeta();
      location.hash = parent ? `#/subnet/${parent.id}` : '#/';
    } catch (e) { toast(e.message, 'err'); }
  }

  // ------------------------------------------------------------------ Import
  function importModal() {
    const s = cur.d.subnet;
    formModal({
      title: 'CSV importieren', sub: `nach <span class="mono">${esc(s.cidr)}</span>`, size: 'lg', submit: 'Importieren',
      fields: `
        <label class="dropzone" id="dz">${icon('upload')}<div style="margin-top:6px"><b>CSV-Datei auswählen</b> oder hierher ziehen</div>
          <div class="faint" style="font-size:12px;margin-top:4px" id="dz-name">Trennzeichen ; oder , werden automatisch erkannt</div>
          <input type="file" accept=".csv,.txt,text/csv" hidden id="dz-file"></label>
        <div class="field" style="margin-top:14px"><label>… oder Inhalt einfügen</label>
          <textarea class="input mono" name="csv" rows="6" placeholder="IP-Adresse;Hostname;Beschreibung;MAC-Adresse;Status&#10;192.168.1.10;nas01;Synology;AA:BB:CC:DD:EE:FF;Aktiv"></textarea>
          <span class="hint">Erkannte Spalten: IP-Adresse/ip, Hostname, Beschreibung, MAC, Besitzer, Gerätetyp, Status, Notiz – auch die eigene CSV-Exportdatei und phpIPAM-Exporte funktionieren. Zeilen mit Status „frei“ werden übersprungen.</span></div>
        <label class="check"><input type="checkbox" name="update"> Bereits vorhandene IPs aktualisieren (sonst überspringen)</label>`,
      onMount: (m) => {
        const dz = $('#dz', m.el);
        const fi = $('#dz-file', m.el);
        const take = async (file) => {
          if (!file) return;
          m.form.csv.value = await readFileText(file);
          $('#dz-name', m.el).textContent = `${file.name} · ${m.form.csv.value.split(/\r?\n/).filter(Boolean).length - 1} Zeilen`;
        };
        fi.addEventListener('change', () => take(fi.files[0]));
        dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
        dz.addEventListener('dragleave', () => dz.classList.remove('over'));
        dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); take(e.dataTransfer.files[0]); });
      },
      onSubmit: async (f) => {
        if (!f.csv.trim()) throw new Error('Bitte eine Datei wählen oder Inhalt einfügen');
        const r = await api('POST', `api/subnets/${s.id}/import`, { csv: f.csv, update: !!f.update });
        await reloadSubnet();
        const sum = `${r.created} neu · ${r.updated} aktualisiert · ${r.skipped} übersprungen`;
        if (r.errors.length) infoModal('Import abgeschlossen', `<p>${sum}</p><p><b>${r.errors.length} Fehler:</b></p><div class="result-list">${r.errors.map(esc).join('<br>')}</div>`);
        else toast(`Import: ${sum}`);
      },
    });
  }

  // ------------------------------------------------------------------ Scan
  async function runScan(btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Scanne…';
    try {
      const r = await api('POST', `api/subnets/${cur.id}/scan`, {});
      toast(`${r.alive} von ${r.scanned} Hosts online${r.unknown ? `, ${r.unknown} davon nicht erfasst` : ''}`);
      await reloadSubnet();
    } catch (e) {
      toast(e.message, 'err');
      btn.disabled = false;
      btn.innerHTML = `${icon('radar')} Scan`;
    }
  }

  // ================================================================== Event delegation
  const ACTIONS = {
    'new-subnet': () => subnetModal(),
    'add-address': () => addressModal({}),
    scan: (t) => runScan(t),
    copy: (t) => copyText(t.dataset.v),
    'to-map': () => $('#map-card').scrollIntoView({ behavior: 'smooth', block: 'start' }),
    sort: (t) => {
      const k = t.dataset.k;
      cur.sort = cur.sort.k === k ? { k, dir: -cur.sort.dir } : { k, dir: 1 };
      renderAddrTable();
    },
    'status-chip': (t) => { cur.status = t.dataset.s; renderAddrTable(); },
    'edit-addr': (t) => addressModal({ address: cur.d.addresses.find((a) => a.id === Number(t.dataset.id)) }),
    'del-addr': (t) => deleteAddress(cur.d.addresses.find((a) => a.id === Number(t.dataset.id))),
    'bulk-clear': () => { cur.sel.clear(); renderAddrTable(); },
    'bulk-delete': async () => {
      const n = cur.sel.size;
      if (!(await confirmBox({ title: `${n} Adressen löschen?`, text: 'Die ausgewählten Einträge werden dauerhaft entfernt.' }))) return;
      try { await api('POST', 'api/addresses/bulk', { ids: [...cur.sel], action: 'delete' }); toast(`${n} Adressen gelöscht`); reloadSubnet(); } catch (e) { toast(e.message, 'err'); }
    },
    'bulk-status': (t) => openMenu(t, Object.entries(state.statuses).map(([k, l]) => ({
      label: l, icon: 'check',
      onClick: async () => {
        try { await api('POST', 'api/addresses/bulk', { ids: [...cur.sel], action: 'status', status: k }); toast(`Status → ${l}`); reloadSubnet(); } catch (e) { toast(e.message, 'err'); }
      },
    }))),
    'export-menu': (t) => {
      const s = cur.d.subnet;
      const base = `api/export/subnet/${s.id}`;
      const free = cur.d.map_enabled;
      openMenu(t, [
        { lbl: `Export ${s.cidr}` },
        state.xlsx && { label: 'Excel (.xlsx)', icon: 'sheet', href: `${base}?format=xlsx`, download: true },
        state.xlsx && free && { label: 'Excel inkl. freier IPs', small: 'Offline-Liste', icon: 'sheet', href: `${base}?format=xlsx&free=1`, download: true },
        { label: 'CSV (Excel, Semikolon)', icon: 'file', href: base, download: true },
        free && { label: 'CSV inkl. freier IPs', icon: 'file', href: `${base}?free=1`, download: true },
        { label: 'CSV mit Komma', small: 'international', icon: 'file', href: `${base}?sep=comma`, download: true },
        { sep: true },
        { label: 'Drucken / PDF', icon: 'file', onClick: () => window.print() },
      ]);
    },
    'subnet-menu': (t) => {
      const s = cur.d.subnet;
      openMenu(t, [
        { label: 'Bearbeiten', icon: 'edit', onClick: () => subnetModal(s) },
        { label: 'Unternetz anlegen', icon: 'split', onClick: () => subnetModal(null, { section_id: s.section_id, vlan_id: s.vlan_id, parent: s.cidr, cidr: s.version === 4 ? `${s.cidr.split('/')[0]}/${Math.min(s.prefix + 1, 32)}` : '' }) },
        { label: 'CSV importieren', icon: 'upload', onClick: importModal },
        { sep: true },
        { label: 'Subnetz löschen', icon: 'trash', danger: true, onClick: deleteSubnet },
      ]);
    },
    'vlan-add': () => vlanModal(),
    'vlan-edit': (t) => vlanModal(state.vlans.find((v) => v.id === Number(t.dataset.id))),
    'vlan-del': async (t) => {
      const v = state.vlans.find((x) => x.id === Number(t.dataset.id));
      if (!(await confirmBox({ title: 'VLAN löschen?', text: `VLAN ${esc(v.number)} „${esc(v.name)}“ wird gelöscht. Zugeordnete Subnetze bleiben erhalten.` }))) return;
      try { await api('DELETE', `api/vlans/${v.id}`); toast('VLAN gelöscht'); await refreshMeta(); viewVlans(); } catch (e) { toast(e.message, 'err'); }
    },
    'sec-add': () => sectionModal(),
    'sec-edit': (t) => sectionModal(state.sections.find((s) => s.id === Number(t.dataset.id))),
    'sec-del': async (t) => {
      const s = state.sections.find((x) => x.id === Number(t.dataset.id));
      if (!(await confirmBox({ title: 'Bereich löschen?', text: `Bereich „${esc(s.name)}“ wird gelöscht.` }))) return;
      try { await api('DELETE', `api/sections/${s.id}`); toast('Bereich gelöscht'); await refreshMeta(); viewAdmin('sections'); } catch (e) { toast(e.message, 'err'); }
    },
    'user-add': () => userModal(),
    'user-edit': (t) => userModal(adminUsers.find((u) => u.id === Number(t.dataset.id))),
    'user-del': async (t) => {
      const u = adminUsers.find((x) => x.id === Number(t.dataset.id));
      if (!(await confirmBox({ title: 'Benutzer löschen?', text: `„${esc(u.username)}“ verliert sofort den Zugang.` }))) return;
      try { await api('DELETE', `api/users/${u.id}`); toast('Benutzer gelöscht'); viewAdmin('users'); } catch (e) { toast(e.message, 'err'); }
    },
    restore: () => $('#restore-file').click(),
    'log-more': () => loadLog(true),
  };

  function onViewClick(e) {
    const tile = e.target.closest('.tile');
    if (tile && cur) { onTileClick(tile); return; }
    const t = e.target.closest('[data-act]');
    if (!t || t.tagName === 'INPUT') return;
    const fn = ACTIONS[t.dataset.act];
    if (fn) { e.preventDefault(); e.stopPropagation(); fn(t, e); }
  }
  function onViewInput(e) {
    const t = e.target;
    if (t.dataset.act === 'addr-filter') { cur.filter = t.value; renderAddrTable(); }
    if (t.dataset.act === 'log-filter') { clearTimeout(logState.timer); logState.timer = setTimeout(() => { logState.q = t.value; loadLog(false); }, 250); }
  }
  function onViewChange(e) {
    const t = e.target;
    if (t.dataset.act === 'sel') {
      const id = Number(t.dataset.id);
      if (t.checked) cur.sel.add(id); else cur.sel.delete(id);
      const all = $('[data-act="sel-all"]');
      if (all) all.checked = filteredAddresses().every((a) => cur.sel.has(a.id));
      renderBulkbar();
    }
    if (t.dataset.act === 'sel-all') {
      filteredAddresses().forEach((a) => (t.checked ? cur.sel.add(a.id) : cur.sel.delete(a.id)));
      $$('[data-act="sel"]').forEach((c) => { c.checked = t.checked; });
      renderBulkbar();
    }
    if (t.id === 'restore-file') doRestore(t);
  }

  // ================================================================== VLANs
  async function viewVlans() {
    setTitle('VLANs');
    state.vlans = await api('GET', 'api/vlans');
    const ed = canEdit();
    $('#view').innerHTML = `
      <div class="page-head"><div class="titles"><h1>VLANs</h1><p class="desc">Ordne Subnetze ihren VLANs zu – die Zuordnung erfolgt im Subnetz-Dialog.</p></div>
        <div class="actions">${ed ? `<button class="btn primary" data-act="vlan-add">${icon('plus')} VLAN</button>` : ''}</div></div>
      <div class="card"><div class="table-wrap">${state.vlans.length ? `<table class="t"><thead><tr><th>VLAN-ID</th><th>Name</th><th>Beschreibung</th><th>Subnetze</th><th></th></tr></thead><tbody>
        ${state.vlans.map((v) => `<tr><td><span class="badge accent mono">${esc(v.number)}</span></td><td><b style="font-weight:600">${esc(v.name)}</b></td>
          <td class="muted"><div class="trunc">${esc(v.description)}</div></td>
          <td>${v.subnets.map((s) => `<a class="mono" href="#/subnet/${s.id}">${esc(s.cidr)}</a>`).join(', ') || '<span class="faint">–</span>'}</td>
          <td class="actions-col">${ed ? `<div class="row-actions"><button class="btn ghost icon sm" data-act="vlan-edit" data-id="${v.id}">${icon('edit')}</button>
            <button class="btn ghost icon sm danger" data-act="vlan-del" data-id="${v.id}">${icon('trash')}</button></div>` : ''}</td></tr>`).join('')}
        </tbody></table>` : emptyState('layers', 'Noch keine VLANs angelegt.')}</div></div>`;
  }

  function vlanModal(v = null) {
    formModal({
      title: v ? 'VLAN bearbeiten' : 'VLAN anlegen', size: 'sm',
      fields: `<div class="grid-2"><div class="field"><label>VLAN-ID</label><input class="input mono" name="number" type="number" min="1" max="4094" value="${esc(v ? v.number : '')}" autofocus></div>
        <div class="field"><label>Name</label><input class="input" name="name" value="${esc(v ? v.name : '')}"></div></div>
        <div class="field"><label>Beschreibung</label><input class="input" name="description" value="${esc(v ? v.description : '')}"></div>`,
      onSubmit: async (f) => {
        if (v) await api('PUT', `api/vlans/${v.id}`, f); else await api('POST', 'api/vlans', f);
        toast('VLAN gespeichert');
        await refreshMeta();
        if (location.hash.startsWith('#/vlans')) viewVlans();
      },
    });
  }

  // ================================================================== Change log
  async function viewLog() {
    setTitle('Änderungsprotokoll');
    logState = { rows: [], q: '', timer: null, done: false };
    $('#view').innerHTML = `<div class="page-head"><div class="titles"><h1>Änderungsprotokoll</h1><p class="desc">Wer hat wann was geändert.</p></div></div>
      <div class="card"><div class="card-head"><input class="input" style="max-width:320px;height:32px" data-act="log-filter" placeholder="Filtern nach Text oder Benutzer…"></div>
      <div class="table-wrap" id="log-table"></div><div class="card-body" id="log-more" style="text-align:center"></div></div>`;
    await loadLog(false);
  }

  async function loadLog(more) {
    const before = more && logState.rows.length ? logState.rows[logState.rows.length - 1].id : '';
    const rows = await api('GET', `api/log?limit=100&q=${encodeURIComponent(logState.q)}${before ? `&before=${before}` : ''}`);
    logState.rows = more ? logState.rows.concat(rows) : rows;
    const lbl = { create: 'Angelegt', update: 'Geändert', delete: 'Gelöscht', scan: 'Scan', import: 'Import', restore: 'Wiederherstellung' };
    $('#log-table').innerHTML = logState.rows.length ? `<table class="t"><thead><tr><th>Zeitpunkt</th><th>Benutzer</th><th>Aktion</th><th>Details</th></tr></thead><tbody>
      ${logState.rows.map((r) => `<tr><td class="nowrap muted">${esc(fmtDate(r.ts))}</td><td>${esc(r.username)}</td><td><span class="badge">${esc(lbl[r.action] || r.action)}</span></td><td>${esc(r.summary)}</td></tr>`).join('')}
      </tbody></table>` : emptyState('clock', 'Keine Einträge');
    $('#log-more').innerHTML = rows.length === 100 ? '<button class="btn" data-act="log-more">Ältere laden</button>' : '';
  }

  // ================================================================== Administration
  let adminUsers = [];
  async function viewAdmin(tab) {
    if (!canEdit()) { location.hash = '#/'; return; }
    if (!isAdmin() && tab !== 'sections') tab = 'sections';
    setTitle('Verwaltung');
    const tabs = [isAdmin() && ['users', 'Benutzer'], ['sections', 'Bereiche'], isAdmin() && ['backup', 'Backup & Wiederherstellung']].filter(Boolean);
    let body = '';
    if (tab === 'users') {
      adminUsers = await api('GET', 'api/users');
      body = `<div class="card"><div class="card-head"><h2>${icon('users')} Benutzer</h2><span class="spacer"></span><button class="btn primary sm" data-act="user-add">${icon('plus')} Benutzer</button></div>
        <div class="table-wrap"><table class="t"><thead><tr><th>Benutzername</th><th>Rolle</th><th>Letzter Login</th><th>Angelegt</th><th></th></tr></thead><tbody>
        ${adminUsers.map((u) => `<tr><td><b style="font-weight:600">${esc(u.username)}</b>${u.id === state.user.id ? ' <span class="badge outline">du</span>' : ''}</td>
          <td><span class="badge ${u.role === 'admin' ? 'accent' : ''}">${esc(ROLE_LABEL[u.role] || u.role)}</span></td>
          <td class="muted">${u.last_login ? ago(u.last_login) : 'nie'}</td><td class="muted">${esc(fmtDate(u.created_at))}</td>
          <td class="actions-col"><div class="row-actions"><button class="btn ghost icon sm" data-act="user-edit" data-id="${u.id}">${icon('edit')}</button>
          ${u.id !== state.user.id ? `<button class="btn ghost icon sm danger" data-act="user-del" data-id="${u.id}">${icon('trash')}</button>` : ''}</div></td></tr>`).join('')}
        </tbody></table></div>
        <div class="card-body faint" style="font-size:12.5px;border-top:1px solid var(--border)"><b>Rollen:</b> Administrator – alles inkl. Benutzer &amp; Backups · Bearbeiter – Netze, Adressen, VLANs pflegen · Nur lesen – ansehen &amp; exportieren.</div></div>`;
    } else if (tab === 'sections') {
      state.sections = await api('GET', 'api/sections');
      body = `<div class="card"><div class="card-head"><h2>${icon('folder')} Bereiche</h2><span class="muted" style="font-size:13px">Gruppieren Subnetze, z. B. nach Standort oder Zweck. Gleiche Netze dürfen in verschiedenen Bereichen vorkommen.</span><span class="spacer"></span>
        <button class="btn primary sm" data-act="sec-add">${icon('plus')} Bereich</button></div>
        <div class="table-wrap"><table class="t"><thead><tr><th>Name</th><th>Beschreibung</th><th>Sortierung</th><th>Subnetze</th><th></th></tr></thead><tbody>
        ${state.sections.map((s) => `<tr><td><b style="font-weight:600">${esc(s.name)}</b></td><td class="muted">${esc(s.description)}</td><td>${s.sort}</td><td>${s.subnet_count}</td>
          <td class="actions-col"><div class="row-actions"><button class="btn ghost icon sm" data-act="sec-edit" data-id="${s.id}">${icon('edit')}</button>
          <button class="btn ghost icon sm danger" data-act="sec-del" data-id="${s.id}">${icon('trash')}</button></div></td></tr>`).join('')}
        </tbody></table></div></div>`;
    } else if (tab === 'backup') {
      const b = await api('GET', 'api/backup/list');
      body = `<div class="dash-grid">
        <div>
          <div class="card"><div class="card-head"><h2>${icon('download')} Herunterladen</h2></div><div class="card-body" style="display:grid;gap:8px">
            ${state.xlsx ? `<a class="btn" href="api/export/all?format=xlsx&free=1" download>${icon('sheet')} Excel komplett inkl. freier IPs</a>` : ''}
            <a class="btn" href="api/export/all" download>${icon('file')} CSV komplett</a>
            <a class="btn" href="api/backup/json" download>${icon('db')} JSON-Backup (wiederherstellbar)</a>
            <a class="btn" href="api/backup/db" download>${icon('db')} SQLite-Datenbank</a>
            <p class="faint" style="font-size:12.5px;margin:6px 0 0">Excel/CSV sind zum Nachschlagen, wenn das IPAM selbst nicht läuft. Das JSON-Backup kann hier wieder eingespielt werden.</p>
          </div></div>
          <div class="card"><div class="card-head"><h2>${icon('restore')} Wiederherstellen</h2></div><div class="card-body">
            <p style="margin-top:0">Spielt ein JSON-Backup ein und <b>ersetzt</b> alle Bereiche, VLANs, Subnetze und Adressen. Benutzer bleiben unverändert. Vorher wird automatisch eine Sicherung der aktuellen Datenbank angelegt.</p>
            <button class="btn danger" data-act="restore">${icon('upload')} JSON-Backup einspielen…</button>
            <input type="file" id="restore-file" accept=".json,application/json" hidden>
          </div></div>
        </div>
        <div class="card"><div class="card-head"><h2>${icon('clock')} Automatische Sicherungen</h2></div><div class="card-body">
          <p style="margin-top:0" class="muted">Täglich wird eine Kopie der Datenbank auf dem Server abgelegt (die letzten ${b.keep} werden behalten):<br><span class="mono" style="font-size:12px">${esc(b.dir)}</span></p>
          ${b.files.length ? `<table class="t"><thead><tr><th>Datei</th><th>Größe</th><th>Zeit</th></tr></thead><tbody>${b.files.slice(0, 30).map((f) => `<tr><td class="mono">${esc(f.name)}</td><td class="muted">${(f.size / 1024).toFixed(0)} KB</td><td class="muted">${esc(fmtDate(f.mtime))}</td></tr>`).join('')}</tbody></table>` : '<p class="faint">Noch keine Sicherungen.</p>'}
          <p class="faint" style="font-size:12.5px">Notfallzugang ohne Weboberfläche:<br><span class="mono">python app.py reset-password &lt;benutzer&gt;</span></p>
        </div></div></div>`;
    }
    $('#view').innerHTML = `<div class="page-head"><div class="titles"><h1>Verwaltung</h1></div></div>
      <div class="tabs">${tabs.map(([k, l]) => `<a href="#/admin/${k}" class="${k === tab ? 'active' : ''}">${l}</a>`).join('')}</div>${body}`;
  }

  async function doRestore(input) {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    let data;
    try { data = JSON.parse(await readFileText(file)); } catch { toast('Datei ist kein gültiges JSON', 'err'); return; }
    const n = `${(data.subnets || []).length} Subnetze, ${(data.addresses || []).length} Adressen, Stand ${esc(data.created ? fmtDate(data.created) : '?')}`;
    if (!(await confirmBox({ title: 'Backup wiederherstellen?', text: `Alle aktuellen Netzdaten werden durch die Sicherung ersetzt:<br><b>${n}</b>`, ok: 'Wiederherstellen' }))) return;
    try { await api('POST', 'api/backup/restore', data); toast('Wiederherstellung abgeschlossen'); cur = null; await refreshMeta(); viewAdmin('backup'); } catch (e) { toast(e.message, 'err'); }
  }

  function sectionModal(s = null) {
    formModal({
      title: s ? 'Bereich bearbeiten' : 'Bereich anlegen', size: 'sm',
      fields: `<div class="field"><label>Name</label><input class="input" name="name" value="${esc(s ? s.name : '')}" autofocus placeholder="z. B. Zuhause, Rechenzentrum, VPN"></div>
        <div class="field"><label>Beschreibung</label><input class="input" name="description" value="${esc(s ? s.description : '')}"></div>
        <div class="field"><label>Sortierung</label><input class="input" type="number" name="sort" value="${esc(s ? s.sort : 0)}"><span class="hint">Kleinere Zahl = weiter oben</span></div>`,
      onSubmit: async (f) => {
        if (s) await api('PUT', `api/sections/${s.id}`, f); else await api('POST', 'api/sections', f);
        toast('Bereich gespeichert');
        await refreshMeta();
        if (location.hash.startsWith('#/admin')) viewAdmin('sections');
      },
    });
  }

  function userModal(u = null) {
    const roles = Object.entries(ROLE_LABEL).map(([k, l]) => `<option value="${k}" ${(u ? u.role : 'editor') === k ? 'selected' : ''}>${l}</option>`).join('');
    formModal({
      title: u ? `Benutzer „${u.username}“` : 'Benutzer anlegen', size: 'sm', submit: u ? 'Speichern' : 'Anlegen',
      fields: `${u ? '' : '<div class="field"><label>Benutzername</label><input class="input" name="username" autofocus></div>'}
        <div class="field"><label>Rolle</label><select class="input" name="role">${roles}</select></div>
        <div class="field"><label>${u ? 'Neues Passwort' : 'Passwort'}</label><input class="input" type="password" name="password" autocomplete="new-password" placeholder="${u ? 'leer lassen = unverändert' : 'mind. 8 Zeichen'}"></div>`,
      onSubmit: async (f) => {
        if (u) await api('PUT', `api/users/${u.id}`, { role: f.role, password: f.password || undefined });
        else await api('POST', 'api/users', f);
        toast('Benutzer gespeichert');
        viewAdmin('users');
      },
    });
  }

  function passwordModal() {
    formModal({
      title: 'Passwort ändern', size: 'sm',
      fields: `<div class="field"><label>Aktuelles Passwort</label><input class="input" type="password" name="current" autocomplete="current-password" autofocus></div>
        <div class="field"><label>Neues Passwort</label><input class="input" type="password" name="new" autocomplete="new-password"><span class="hint">Mindestens 8 Zeichen. Andere Sitzungen werden abgemeldet.</span></div>
        <div class="field"><label>Wiederholen</label><input class="input" type="password" name="new2" autocomplete="new-password"></div>`,
      onSubmit: async (f) => {
        if (f.new !== f.new2) throw new Error('Neue Passwörter stimmen nicht überein');
        const s = await api('POST', 'api/me/password', { current: f.current, new: f.new });
        state.csrf = s.csrf;
        toast('Passwort geändert');
      },
    });
  }

  // ================================================================== Search
  let searchSel = -1;
  let searchTimer = null;
  function hideSearch() { const r = $('#qres'); if (r) r.classList.add('hidden'); }
  function setupSearch() {
    const q = $('#q');
    const res = $('#qres');
    q.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(async () => {
        const v = q.value.trim();
        if (v.length < 2) { hideSearch(); return; }
        try {
          const r = await api('GET', `api/search?q=${encodeURIComponent(v)}`);
          const items = [];
          if (r.addresses.length) {
            items.push('<h6>Adressen</h6>');
            r.addresses.slice(0, 12).forEach((a) => items.push(`<a href="#/subnet/${a.subnet_id}?ip=${encodeURIComponent(a.ip)}"><span class="badge st-${esc(a.status)}" style="padding:2px 5px"><span class="dot"></span></span><span class="r-main">${esc(a.ip)}</span><span class="r-sub">${esc(a.hostname || a.description || a.mac)} · ${esc(a.subnet_cidr)}</span></a>`));
          }
          if (r.subnets.length) {
            items.push('<h6>Subnetze</h6>');
            r.subnets.slice(0, 8).forEach((s) => items.push(`<a href="#/subnet/${s.id}">${icon('network')}<span class="r-main">${esc(s.cidr)}</span><span class="r-sub">${esc(s.name)} · ${esc(s.section_name)}</span></a>`));
          }
          if (r.vlans.length) {
            items.push('<h6>VLANs</h6>');
            r.vlans.slice(0, 5).forEach((v2) => items.push(`<a href="#/vlans">${icon('layers')}<span class="r-main">VLAN ${esc(v2.number)}</span><span class="r-sub">${esc(v2.name)}</span></a>`));
          }
          res.innerHTML = items.join('') || '<div class="empty">Keine Treffer</div>';
          res.classList.remove('hidden');
          searchSel = -1;
        } catch (e) { toast(e.message, 'err'); }
      }, 160);
    });
    q.addEventListener('focus', () => { if (res.innerHTML && q.value.trim().length >= 2) res.classList.remove('hidden'); });
    q.addEventListener('keydown', (e) => {
      const links = $$('a', res);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        searchSel = Math.max(0, Math.min(links.length - 1, searchSel + (e.key === 'ArrowDown' ? 1 : -1)));
        links.forEach((l, i) => l.classList.toggle('sel', i === searchSel));
      } else if (e.key === 'Enter') {
        const l = links[Math.max(0, searchSel)];
        if (l) { location.hash = l.getAttribute('href'); hideSearch(); q.value = ''; q.blur(); }
      } else if (e.key === 'Escape') { hideSearch(); q.blur(); }
    });
    res.addEventListener('click', (e) => { if (e.target.closest('a')) { hideSearch(); q.value = ''; q.blur(); } });
  }

  // ================================================================== Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const mods = $$('.modal-backdrop');
      if (mods.length) { mods[mods.length - 1].querySelector('[data-close]').click(); return; }
      closeMenus();
    }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (typing || e.ctrlKey || e.metaKey || e.altKey || $('.modal-backdrop')) return;
    if (e.key === '/' && $('#q')) { e.preventDefault(); $('#q').focus(); }
    if ((e.key === 'n' || e.key === '+') && cur && canEdit() && location.hash.startsWith('#/subnet/')) { e.preventDefault(); addressModal({}); }
  });

  boot();
})();

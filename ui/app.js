// DLPBooster app.js — IPC wiring, i18n, FOV control, install flow.
/* global I18N_FA, I18N_EN */
// window.__TAURI__ is injected asynchronously; NEVER destructure it at
// top level — one throw here kills every panel. Lazy access instead.
let _ipc = null;
function ipc() {
  if (_ipc) return _ipc;
  const t = window.__TAURI__;
  if (!t || !t.core) throw new Error('tauri ipc not ready');
  _ipc = { invoke: t.core.invoke };
  return _ipc;
}
function call(cmd, args) {
  try { return ipc().invoke(cmd, args); }
  catch (e) { return Promise.reject(e); }
}

// ---------- state ----------
const state = {
  lang: 'fa',
  unlocked: false,
  lastPath: null,
  gamePath: null,
  fov: 90,
  selectedMode: null,
  running: false,
};

// FOV->aspect ratio map (fov.rs parity)
const AR_TABLE = { 70: '1.60', 75: '1.70', 80: '1.75', 85: '1.95', 90: '2.15', 95: '2.32', 100: '2.49', 105: '2.64', 110: '2.79', 115: '2.94', 120: '3.09' };

// ---------- i18n ----------
function t(key) {
  return (state.lang === 'en' ? window.I18N_EN : window.I18N_FA)[key] || key;
}

function applyLang() {
  document.documentElement.lang = state.lang;
  document.documentElement.dir = state.lang === 'fa' ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  const u = document.getElementById('unlock-input');
  const p = document.getElementById('path-input');
  if (u) u.placeholder = t('unlockPlaceholder');
  if (p) p.placeholder = t('pathPlaceholder');
  renderBackups();
  updateDetectBadge();
}

function setLang(lang) {
  state.lang = lang;
  call('set_settings', { patch: { lang } }).catch(() => {});
  applyLang();
}

// ---------- fatal-error surface (never silent) ----------
function fatal(err) {
  const d = document.createElement('pre');
  d.style.cssText = 'color:#f87171;padding:12px;direction:ltr;text-align:left;white-space:pre-wrap;font-size:12px;position:relative;z-index:999';
  d.textContent = 'app.js error: ' + ((err && err.stack) || err);
  document.body.appendChild(d);
}

// ---------- boot ----------
async function boot() {
  // __TAURI__ injection is async — wait up to ~5s before first IPC call.
  for (let i = 0; i < 50 && !(window.__TAURI__ && window.__TAURI__.core); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  let s = {};
  try { s = await call('get_settings'); } catch (e) { /* defaults */ }
  state.lang = s.lang || 'fa';
  state.unlocked = !!s.unlocked;
  state.lastPath = s.last_path || null;
  const sw = document.getElementById('sw-unit-status');
  if (sw) sw.checked = !!s.unit_status_new;
  applyLang();
  setFov(90);
  selectCardByKey('display');

  if (state.unlocked) showTesterModes();

  try {
    if (await call('running_from_pkg')) {
      showModal(t('guardTitle'), 'This copy was extracted to TEMP — run the installed exe.', [{ label: 'OK' }]);
    }
  } catch (e) { /* non-fatal */ }

  await refreshGame();
}

async function refreshGame() {
  try {
    const found = await call('find_game');
    if (found) {
      state.gamePath = found.deadlock;
      document.getElementById('nogame-panel').style.display = 'none';
      document.getElementById('main-ui').style.display = 'block';
      call('set_settings', { patch: { last_path: found.deadlock } }).catch(() => {});
    } else if (state.lastPath && await call('pick_game', { path: state.lastPath })) {
      state.gamePath = state.lastPath;
      document.getElementById('nogame-panel').style.display = 'none';
      document.getElementById('main-ui').style.display = 'block';
    } else {
      state.gamePath = null;
      document.getElementById('nogame-panel').style.display = 'block';
      if (state.lastPath) document.getElementById('path-input').value = state.lastPath;
    }
  } catch (e) {
    // IPC down: keep main UI visible, show the locate panel as fallback
    document.getElementById('nogame-panel').style.display = 'block';
  }
  updateDetectBadge();
  refreshRunning();
}

async function refreshRunning() {
  try {
    const running = (await call('check_running')).length > 0;
    state.running = running;
    const btn = document.getElementById('btn-launch');
    btn.classList.toggle('running', running);
    btn.querySelector('span').textContent = running ? t('launchRunning') : t('launch');
  } catch (e) { /* non-fatal */ }
}

// ---------- locate game ----------
async function pickFolder() {
  try {
    const dlg = window.__TAURI__ && window.__TAURI__.dialog;
    if (dlg && dlg.open) {
      const dir = await dlg.open({ directory: true, title: t('locate') });
      if (dir) document.getElementById('path-input').value = Array.isArray(dir) ? dir[0] : dir;
    }
    // plugin absent: manual paste still works
  } catch (e) { /* non-fatal */ }
}

async function confirmPath() {
  const p = document.getElementById('path-input').value.trim();
  if (!p) return;
  const ok = await call('pick_game', { path: p });
  if (ok) {
    state.gamePath = ok.deadlock;
    call('set_settings', { patch: { last_path: ok.deadlock } }).catch(() => {});
    document.getElementById('nogame-panel').style.display = 'none';
    document.getElementById('main-ui').style.display = 'block';
    updateDetectBadge();
    refreshRunning();
  } else {
    showModal(t('locate'), t('locateDesc'), [{ label: 'OK' }]);
  }
}

// ---------- detect badge ----------
async function updateDetectBadge() {
  if (!state.gamePath) return;
  const cit = state.gamePath.replace(/[\\/]+$/, '') + '\\game\\citadel';
  let res;
  try { res = await call('detect_tier_cmd', { citadel: cit }); } catch (e) { return; }
  const badge = document.getElementById('detect-badge');
  if (res === 'T1' || res === 'T2' || res === 'T3') {
    badge.textContent = (res === 'T3' ? `POTATO (${res}) ` : `${res} `) + t('currentTier');
    badge.style.color = 'var(--deadlock-orange)';
  } else if (res === 'MISSING') {
    badge.textContent = t('currentMissing');
    badge.style.color = 'var(--text-muted)';
  } else {
    badge.textContent = t('currentUnknown');
    badge.style.color = 'var(--deadlock-cyan)';
  }
}

// ---------- install flow ----------
function stepLine(text, cls) {
  const log = document.getElementById('step-log');
  const div = document.createElement('div');
  div.textContent = text;
  if (cls) div.className = cls;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

async function doInstall() {
  if (!state.gamePath) { showModal(t('locate'), t('noGame'), [{ label: 'OK' }]); return; }
  if (!state.selectedMode) {
    // default to T1 instead of silently no-oping
    state.selectedMode = 'T1';
    const card = document.querySelector('.option-item.preset[data-mode="T1"]');
    if (card) card.classList.add('selected');
  }

  try {
    const running = await call('check_running');
    if (running.length > 0) {
      const keep = await showModal(t('guardTitle'), t('guardBody'), [
        { label: t('guardKeep'), value: true, kind: 'apply' },
        { label: t('guardCancel'), value: false },
      ]);
      if (!keep) return;
    }
  } catch (e) { /* guard check failed — backend re-checks anyway */ }

  const btn = document.getElementById('btn-install');
  btn.disabled = true;
  document.getElementById('step-log').innerHTML = '';
  stepLine(t('working'));
  try {
    const log = await call('install_mode', {
      mode: state.selectedMode,
      fov: state.fov,
      path: state.gamePath,
    });
    document.getElementById('step-log').innerHTML = '';
    for (const l of log) stepLine(`[${l.step}] ${l.detail} ${l.skipped ? '— ' + t('stepSkip') : '— ' + t('stepDone')}`, l.skipped ? 'skip' : 'ok');
    showModal(t('doneTitle'), t('doneBody'), [{ label: 'OK', kind: 'apply' }]);
  } catch (e) {
    document.getElementById('step-log').innerHTML = '';
    stepLine(String(e), 'skip');
    const msg = String(e).includes('NeedsAdmin') ? t('needsAdmin') : String(e);
    showModal(t('guardTitle'), msg, [{ label: 'OK' }]);
  }
  btn.disabled = false;
  updateDetectBadge();
}

// ---------- backup ----------
async function doBackupNow() {
  try {
    const name = await call('do_backup_cmd', { path: state.gamePath || '' });
    stepLine(`[backup] ${name}`, 'ok');
    renderBackups();
  } catch (e) {
    showModal(t('advTitle'), String(e), [{ label: 'OK' }]);
  }
}

async function renderBackups() {
  const list = document.getElementById('backup-list');
  if (!list) return;
  let names = [];
  try { names = (await call('list_backups')).map((b) => b.name); } catch (e) { return; }
  list.innerHTML = '';
  if (names.length === 0) {
    const d = document.createElement('div');
    d.className = 'option-detail';
    d.textContent = t('noBackups');
    list.appendChild(d);
    return;
  }
  for (const n of names) {
    const row = document.createElement('div');
    row.className = 'backup-row';
    const name = document.createElement('span');
    name.className = 'backup-name';
    name.textContent = n;
    const btn = document.createElement('button');
    btn.className = 'btn-apply btn-restore';
    btn.textContent = t('restore');
    btn.onclick = async () => {
      const go = await showModal(t('restore'), t('confirmRestore'), [
        { label: t('guardKeep'), value: true, kind: 'apply' },
        { label: t('guardCancel'), value: false },
      ]);
      if (!go) return;
      try {
        const rep = await call('do_restore', { name: n, path: state.gamePath || '' });
        stepLine(`[restore] ${n} — ${rep.removed_addons.length} addons removed`, 'ok');
        updateDetectBadge();
      } catch (e) {
        showModal(t('restore'), String(e), [{ label: 'OK' }]);
      }
    };
    row.appendChild(name);
    row.appendChild(btn);
    list.appendChild(row);
  }
}

// ---------- tester unlock ----------
function showTesterModes() {
  const l = document.getElementById('tester-locked');
  const m = document.getElementById('tester-modes');
  if (l) l.style.display = 'none';
  if (m) m.style.display = 'flex';
}

async function doUnlock() {
  const code = document.getElementById('unlock-input').value;
  try {
    await call('set_settings', { patch: { unlock_code: code } });
    state.unlocked = true;
    showTesterModes();
  } catch (e) {
    showModal(t('testerTitle'), t('unlockBad'), [{ label: 'OK' }]);
  }
}

// ---------- launch ----------
async function launchGame() {
  if (state.running) return;
  try { await call('launch_game'); } catch (e) { /* steam not found etc. */ }
  setTimeout(refreshRunning, 2000);
}

// ---------- modal ----------
function showModal(title, body, actions) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('modal');
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').textContent = body;
    const act = document.getElementById('modal-actions');
    act.innerHTML = '';
    for (const a of actions) {
      const b = document.createElement('button');
      b.className = a.kind === 'apply' ? 'btn-apply' : 'btn-reset';
      b.textContent = a.label;
      b.onclick = () => { overlay.style.display = 'none'; resolve(a.value); };
      act.appendChild(b);
    }
    overlay.style.display = 'flex';
  });
}

// ---------- FOV ----------
function setFov(v) {
  const slider = document.getElementById('fov-slider');
  const number = document.getElementById('fov-number');
  const snapped = Math.min(120, Math.max(70, Math.round((v - 70) / 5) * 5 + 70));
  state.fov = snapped;
  slider.value = snapped;
  number.value = snapped;
  document.getElementById('ar-preview').textContent = AR_TABLE[snapped] || '2.15';
  document.getElementById('fov-summary').textContent = `FOV ${snapped} · AR ${AR_TABLE[snapped] || '2.15'}`;
}

// ---------- tab switcher (CSP-safe: no inline onclick) ----------
const SECTION_TITLES = {
  display: 'presetsTitle',
  engine: 'cardEngine',
  latency: 'cardLatency',
  fov: 'fovTitle',
  advanced: 'advTitle',
};
const PANELS = ['display', 'engine', 'latency', 'fov', 'advanced'];

function selectCardByKey(tabKey) {
  const el = document.getElementById(`card-${tabKey}`);
  if (!el) return;
  document.querySelectorAll('.sci-card').forEach((card) => card.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('section-title').textContent = t(SECTION_TITLES[tabKey] || 'presetsTitle');
  for (const p of PANELS) {
    document.getElementById(`panel-${p}`).style.display = p === tabKey ? 'block' : 'none';
  }
  if (tabKey === 'advanced') renderBackups();
}

// ---------- wire everything ----------
window.addEventListener('DOMContentLoaded', () => {
  try {
    // window controls
    const getWin = () => window.__TAURI__ && window.__TAURI__.window.getCurrentWindow();
    document.getElementById('btn-min').onclick = () => { const w = getWin(); if (w) w.minimize(); };
    document.getElementById('btn-max').onclick = () => {
      const w = getWin(); if (!w) return;
      w.isMaximized().then((m) => (m ? w.unmaximize() : w.maximize())).catch(() => {});
    };
    document.getElementById('btn-close').onclick = () => { const w = getWin(); if (w) w.close(); };

    // actions
    document.getElementById('btn-pick-folder').onclick = pickFolder;
    document.getElementById('btn-confirm-path').onclick = confirmPath;
    document.getElementById('btn-launch').onclick = launchGame;
    document.getElementById('btn-install').onclick = doInstall;
    document.getElementById('btn-backup').onclick = doBackupNow;
    document.getElementById('btn-unlock').onclick = doUnlock;
    document.getElementById('sw-unit-status').onchange = (e) => {
      call('set_settings', { patch: { unit_status_new: e.target.checked } }).catch(() => {});
    };

    // FOV controls
    const slider = document.getElementById('fov-slider');
    const number = document.getElementById('fov-number');
    slider.oninput = () => setFov(Number(slider.value));
    number.onchange = () => setFov(Number(number.value) || 90);
    document.getElementById('panel-fov').addEventListener('wheel', (e) => {
      e.preventDefault();
      setFov(Number(slider.value) + (e.deltaY < 0 ? 5 : -5));
    }, { passive: false });

    // preset cards (single select, includes TEMP modes when visible)
    document.querySelectorAll('.option-item.preset').forEach((el) => {
      el.addEventListener('click', () => {
        document.querySelectorAll('.option-item.preset').forEach((p) => p.classList.remove('selected'));
        el.classList.add('selected');
        state.selectedMode = el.dataset.mode;
      });
    });
    // default selection so INSTALL always has a mode
    state.selectedMode = 'T1';
    const t1 = document.querySelector('.option-item.preset[data-mode="T1"]');
    if (t1) t1.classList.add('selected');

    // tab cards — replace inline onclick with proper listeners
    document.querySelectorAll('.sci-card[id^="card-"]').forEach((card) => {
      const key = card.id.replace('card-', '');
      card.addEventListener('click', () => selectCardByKey(key));
    });

    boot();
  } catch (err) {
    fatal(err);
  }
});

window.addEventListener('error', (e) => fatal(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => fatal(e.reason));

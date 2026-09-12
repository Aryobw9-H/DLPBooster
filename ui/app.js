// DLPBooster app.js — IPC wiring, i18n, FOV control, install flow.
/* global __TAURI__, I18N_FA, I18N_EN */
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

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
  document.getElementById('unlock-input').placeholder = t('unlockPlaceholder');
  document.getElementById('path-input').placeholder = t('pathPlaceholder');
  renderBackups();
  updateDetectBadge();
}

function setLang(lang) {
  state.lang = lang;
  invoke('set_settings', { patch: { lang } }).catch(() => {});
  applyLang();
}

// ---------- window controls ----------
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-min').onclick = () => window.__TAURI__.window.getCurrentWindow().minimize();
  document.getElementById('btn-max').onclick = () => {
    const w = window.__TAURI__.window.getCurrentWindow();
    w.isMaximized().then((m) => (m ? w.unmaximize() : w.maximize()));
  };
  document.getElementById('btn-close').onclick = () => window.__TAURI__.window.getCurrentWindow().close();
  document.getElementById('btn-pick-folder').onclick = pickFolder;
  document.getElementById('btn-confirm-path').onclick = confirmPath;
  document.getElementById('btn-launch').onclick = launchGame;
  document.getElementById('btn-install').onclick = doInstall;
  document.getElementById('btn-backup').onclick = doBackupNow;
  document.getElementById('btn-unlock').onclick = doUnlock;
  document.getElementById('sw-unit-status').onchange = (e) => {
    invoke('set_settings', { patch: { unit_status_new: e.target.checked } }).catch(() => {});
  };

  // FOV controls: slider + number + wheel, snap to 5
  const slider = document.getElementById('fov-slider');
  const number = document.getElementById('fov-number');
  const setFov = (v) => {
    const snapped = Math.min(120, Math.max(70, Math.round((v - 70) / 5) * 5 + 70));
    state.fov = snapped;
    slider.value = snapped;
    number.value = snapped;
    document.getElementById('ar-preview').textContent = AR_TABLE[snapped] || '2.15';
    document.getElementById('fov-summary').textContent = `FOV ${snapped} · AR ${AR_TABLE[snapped] || '2.15'}`;
  };
  slider.oninput = () => setFov(Number(slider.value));
  number.onchange = () => setFov(Number(number.value) || 90);
  document.getElementById('panel-fov').addEventListener('wheel', (e) => {
    e.preventDefault();
    setFov(Number(slider.value) + (e.deltaY < 0 ? 5 : -5));
  }, { passive: false });

  document.querySelectorAll('.option-item.preset').forEach((el) => {
    el.addEventListener('click', () => {
      document.querySelectorAll('.option-item.preset').forEach((p) => p.classList.remove('selected'));
      el.classList.add('selected');
      state.selectedMode = el.dataset.mode;
    });
  });

  boot();
});

// FOV->aspect ratio map (fov.rs parity)
const AR_TABLE = { 70: '1.60', 75: '1.70', 80: '1.75', 85: '1.95', 90: '2.15', 95: '2.32', 100: '2.49', 105: '2.64', 110: '2.79', 115: '2.94', 120: '3.09' };

// ---------- boot ----------
async function boot() {
  let s = {};
  try { s = await invoke('get_settings'); } catch (e) { /* defaults */ }
  state.lang = s.lang || 'fa';
  state.unlocked = !!s.unlocked;
  state.lastPath = s.last_path || null;
  document.getElementById('sw-unit-status').checked = !!s.unit_status_new;
  applyLang();
  setFov(90);

  if (await invoke('running_from_pkg')) {
    showModal(t('guardTitle'), 'This copy was extracted to TEMP — run the installed exe.', [{ label: 'OK' }]);
  }

  await refreshGame();
}

async function refreshGame() {
  const found = await invoke('find_game');
  if (found) {
    state.gamePath = found.deadlock;
    document.getElementById('nogame-panel').style.display = 'none';
    document.getElementById('main-ui').style.display = 'block';
    await invoke('set_settings', { patch: { last_path: found.deadlock } }).catch(() => {});
    updateDetectBadge();
    refreshRunning();
  } else if (state.lastPath && await invoke('pick_game', { path: state.lastPath })) {
    state.gamePath = state.lastPath;
    document.getElementById('nogame-panel').style.display = 'none';
    document.getElementById('main-ui').style.display = 'block';
    updateDetectBadge();
    refreshRunning();
  } else {
    state.gamePath = null;
    document.getElementById('nogame-panel').style.display = 'block';
    document.getElementById('main-ui').style.display = 'none';
    if (state.lastPath) document.getElementById('path-input').value = state.lastPath;
  }
}

async function refreshRunning() {
  const running = (await invoke('check_running')).length > 0;
  state.running = running;
  const btn = document.getElementById('btn-launch');
  btn.classList.toggle('running', running);
  btn.querySelector('span').textContent = running ? t('launchRunning') : t('launch');
}

// ---------- locate game ----------
async function pickFolder() {
  try {
    const { open } = window.__TAURI__.dialog;
    const dir = await open({ directory: true, title: t('locate') });
    if (dir) document.getElementById('path-input').value = Array.isArray(dir) ? dir[0] : dir;
  } catch (e) {
    // dialog plugin absent: manual input still works
  }
}

async function confirmPath() {
  const p = document.getElementById('path-input').value.trim();
  if (!p) return;
  const ok = await invoke('pick_game', { path: p });
  if (ok) {
    state.gamePath = ok.deadlock;
    await invoke('set_settings', { patch: { last_path: ok.deadlock } }).catch(() => {});
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
  try { res = await invoke('detect_tier_cmd', { citadel: cit }); } catch (e) { return; }
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
  if (!state.selectedMode) return;
  if (!state.gamePath) { showModal(t('locate'), t('noGame'), [{ label: 'OK' }]); return; }

  const running = await invoke('check_running');
  if (running.length > 0) {
    const keep = await showModal(t('guardTitle'), t('guardBody'), [
      { label: t('guardKeep'), value: true, kind: 'apply' },
      { label: t('guardCancel'), value: false },
    ]);
    if (!keep) return;
  }

  const btn = document.getElementById('btn-install');
  btn.disabled = true;
  document.getElementById('step-log').innerHTML = '';
  stepLine(t('working'));
  try {
    const log = await invoke('install_mode', {
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
    const name = await invoke('do_backup_cmd', { path: state.gamePath || '' });
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
  try { names = (await invoke('list_backups')).map((b) => b.name); } catch (e) { return; }
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
        const rep = await invoke('do_restore', { name: n, path: state.gamePath || '' });
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
async function doUnlock() {
  const code = document.getElementById('unlock-input').value;
  try {
    await invoke('set_settings', { patch: { unlock_code: code } });
    state.unlocked = true;
    document.getElementById('tester-locked').style.display = 'none';
    document.getElementById('tester-modes').style.display = 'flex';
  } catch (e) {
    showModal(t('testerTitle'), t('unlockBad'), [{ label: 'OK' }]);
  }
}

// ---------- launch ----------
async function launchGame() {
  if (state.running) return;
  try { await invoke('launch_game'); } catch (e) { /* steam not found etc. */ }
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

// ---------- tab switcher ----------
const SECTION_TITLES = {
  display: 'presetsTitle',
  engine: 'cardEngine',
  latency: 'cardLatency',
  fov: 'fovTitle',
  advanced: 'advTitle',
};
const PANELS = ['display', 'engine', 'latency', 'fov', 'advanced'];

window.selectCard = function (element, tabKey) {
  document.querySelectorAll('.sci-card').forEach((card) => card.classList.remove('active'));
  element.classList.add('active');
  document.getElementById('section-title').textContent = t(SECTION_TITLES[tabKey] || 'presetsTitle');
  for (const p of PANELS) {
    document.getElementById(`panel-${p}`).style.display = p === tabKey ? 'block' : 'none';
  }
  if (tabKey === 'advanced') renderBackups();
};

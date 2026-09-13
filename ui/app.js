// DLPBooster app.js — IPC wiring, i18n, FOV control, install flow.
/* global I18N_FA, I18N_EN */
// window.__TAURI__ is injected asynchronously; NEVER destructure it at
// top level — one throw here kills every panel. Lazy access instead.
function getInvoke() {
  if (window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === 'function') {
    return window.__TAURI__.core.invoke;
  }
  if (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === 'function') {
    return window.__TAURI_INTERNALS__.invoke;
  }
  if (window.__TAURI__ && typeof window.__TAURI__.invoke === 'function') {
    return window.__TAURI__.invoke;
  }
  return null;
}

function call(cmd, args) {
  const inv = getInvoke();
  if (!inv) {
    console.warn('[IPC WARNING] invoke not available, command:', cmd);
    return Promise.reject(new Error('tauri ipc not ready'));
  }
  return inv(cmd, args).catch((err) => {
    console.error(`[IPC ERROR] ${cmd}:`, err);
    return Promise.reject(err);
  });
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
  unitStatusNew: false,
  reflexMode: 1,
  fpsMax: 0,
  vsync: false,
  reduceFlash: true,
  textureBias: 0,
  ragdollGibLimit: true,
  customAutoexec: '',
  lastValvePings: null,
};

// FOV->aspect ratio map (fov.rs parity)
const AR_TABLE = { 70: '1.60', 75: '1.70', 80: '1.75', 85: '1.95', 90: '2.15', 95: '2.32', 100: '2.49', 105: '2.64', 110: '2.79', 115: '2.94', 120: '3.09' };

// ---------- i18n ----------
function t(key) {
  return (state.lang === 'en' ? window.I18N_EN : window.I18N_FA)[key] || key;
}

function applyLang() {
  document.documentElement.lang = state.lang;
  document.documentElement.dir = 'ltr'; // Strictly pinned LTR: layout/buttons never jump
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  const u = document.getElementById('unlock-input');
  const p = document.getElementById('path-input');
  const lbl = document.getElementById('lang-label');
  if (lbl) lbl.textContent = t('langToggle');
  if (u) u.placeholder = t('unlockPlaceholder');
  if (p) p.placeholder = t('pathPlaceholder');
  renderBackups();
  updateDetectBadge();
  if (state.lastValvePings) renderValvePings(state.lastValvePings);
}

function setLang(lang) {
  state.lang = lang;
  call('set_settings', { patch: { lang } }).catch(() => {});
  applyLang();
}

// ---------- fatal-error surface (never silent) ----------
function fatal(err) {
  console.error('[DLPBooster fatal]', err);
  let d = document.getElementById('dlp-fatal-banner');
  if (!d && document.body) {
    d = document.createElement('pre');
    d.id = 'dlp-fatal-banner';
    d.style.cssText = 'color:#f87171;background:#180608;border:1px solid #dc2626;padding:12px;margin:10px;border-radius:8px;direction:ltr;text-align:left;white-space:pre-wrap;font-size:12px;position:fixed;bottom:10px;left:10px;right:10px;z-index:99999;box-shadow:0 0 20px rgba(220,38,38,0.5)';
    document.body.appendChild(d);
  }
  if (d) d.textContent = 'app.js error: ' + ((err && err.stack) || err);
}

// ---------- boot ----------
async function boot() {
  // Wait for Tauri IPC to be ready
  for (let i = 0; i < 50 && !getInvoke(); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const inv = getInvoke();
  console.log('[boot] IPC connection:', inv ? 'READY' : 'UNAVAILABLE');

  let s = {};
  try { s = await call('get_settings'); } catch (e) { console.warn('[boot] get_settings failed:', e); }
  state.lang = s.lang || 'fa';
  state.unlocked = !!s.unlocked;
  state.lastPath = s.last_path || null;
  state.unitStatusNew = !!s.unit_status_new;
  state.reflexMode = s.reflex_mode ?? 1;
  state.fpsMax = s.fps_max ?? 0;
  state.vsync = !!s.vsync;
  state.reduceFlash = s.reduce_flash !== false;
  state.textureBias = s.texture_bias ?? 0;
  state.ragdollGibLimit = s.ragdoll_gib_limit !== false;
  state.customAutoexec = s.custom_autoexec || '';

  applyLang();
  syncSettingsToUi();
  setFov(90);
  selectCardByKey('graphic');

  if (state.unlocked) showTesterModes();

  try {
    if (await call('running_from_pkg')) {
      showModal(t('guardTitle'), 'This copy was extracted to TEMP — run the installed exe.', [{ label: 'OK' }]);
    }
  } catch (e) { /* non-fatal */ }

  await refreshGame();
}

function syncSettingsToUi() {
  const swUnit = document.getElementById('sw-unit-status');
  if (swUnit) swUnit.checked = !!state.unitStatusNew;

  const swVsync = document.getElementById('sw-vsync');
  if (swVsync) swVsync.checked = !!state.vsync;

  const swFlash = document.getElementById('sw-reduce-flash');
  if (swFlash) swFlash.checked = !!state.reduceFlash;

  const swRagdoll = document.getElementById('sw-ragdoll-limit');
  if (swRagdoll) swRagdoll.checked = !!state.ragdollGibLimit;

  const selBias = document.getElementById('sel-texture-bias');
  if (selBias) selBias.value = String(state.textureBias);

  const inpFps = document.getElementById('inp-fps-max');
  if (inpFps) inpFps.value = state.fpsMax;
  document.querySelectorAll('#chips-fps .chip-btn').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.val) === state.fpsMax);
  });

  document.querySelectorAll('#seg-reflex .seg-btn').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.val) === state.reflexMode);
  });
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
    if (btn) {
      btn.classList.toggle('running', running);
      const label = btn.querySelector('[data-i18n="launch"]');
      if (label) label.textContent = running ? t('launchRunning') : t('launch');
    }
  } catch (e) { /* non-fatal */ }
}

// ---------- locate game ----------
async function pickFolder() {
  try {
    let dir = null;
    const dlg = window.__TAURI__ && window.__TAURI__.dialog;
    if (dlg && dlg.open) {
      dir = await dlg.open({ directory: true, title: t('locate') });
    } else {
      dir = await call('plugin:dialog|open', { options: { directory: true, title: t('locate') } });
    }
    if (dir) {
      document.getElementById('path-input').value = Array.isArray(dir) ? dir[0] : dir;
    }
  } catch (e) {
    console.warn('[pickFolder failed]', e);
  }
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

// ---------- revert vanilla ----------
async function doRevertVanilla() {
  if (!state.gamePath) {
    showModal(t('revertVanilla'), t('noGame'), [{ label: 'OK' }]);
    return;
  }
  const confirm = await showModal(t('revertVanilla'), t('confirmRevertVanilla'), [
    { label: t('btnRevertVanilla'), value: true, kind: 'apply' },
    { label: t('guardCancel'), value: false },
  ]);
  if (!confirm) return;

  const btn = document.getElementById('btn-revert-vanilla');
  if (btn) btn.disabled = true;
  document.getElementById('step-log').innerHTML = '';
  stepLine(t('working'));
  try {
    const rep = await call('revert_original_cmd', { path: state.gamePath });
    let details = [];
    if (rep.restored_gi) details.push('gameinfo.gi');
    if (rep.restored_video) details.push('cfg\\video.txt');
    if (rep.removed_addons && rep.removed_addons.length > 0) {
      details.push(`${rep.removed_addons.length} addons removed`);
    }
    stepLine(`[revert] ${details.join(', ') || 'restored'}`, 'ok');
    updateDetectBadge();
    showModal(t('revertVanilla'), t('revertComplete'), [{ label: 'OK', kind: 'apply' }]);
  } catch (e) {
    stepLine(String(e), 'skip');
    showModal(t('revertVanilla'), String(e), [{ label: 'OK' }]);
  }
  if (btn) btn.disabled = false;
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

// ---------- social links: open in system browser ----------
async function openExternal(url) {
  // 1) Tauri opener plugin global (withGlobalTauri)
  try {
    const t = window.__TAURI__;
    const op = t && (t.opener || (t.plugins && t.plugins.opener));
    if (op) {
      if (typeof op.openUrl === 'function') { await op.openUrl(url); return; }
      if (typeof op.open === 'function') { await op.open(url); return; }
    }
  } catch (e) { /* fall through */ }
  // 2) direct command
  try { await call('plugin:opener|open_url', { url }); return; } catch (e) { /* fall through */ }
  // 3) webview fallback (may be blocked, harmless)
  try { window.open(url, '_blank'); } catch (e) {}
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
  if (slider) slider.value = snapped;
  if (number) number.value = snapped;
  const arPrev = document.getElementById('ar-preview');
  if (arPrev) arPrev.textContent = AR_TABLE[snapped] || '2.15';
  const fovSum = document.getElementById('fov-summary');
  if (fovSum) {
    fovSum.textContent = `FOV ${snapped} · AR ${AR_TABLE[snapped] || '2.15'}`;
    // tick accent on change
    fovSum.classList.add('tick');
    setTimeout(() => fovSum.classList.remove('tick'), 220);
  }
  document.querySelectorAll('#chips-fov .chip-btn').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.val) === snapped);
  });
}

// ---------- valve game servers ping ----------
let pingingActive = false;

function renderValvePings(servers) {
  const grid = document.getElementById('ping-grid');
  if (!grid || !Array.isArray(servers)) return;

  grid.innerHTML = '';
  let bestPing = Infinity;
  let bestServerName = '';

  for (const s of servers) {
    const hasPing = s.ping_ms !== null && s.ping_ms !== undefined;
    let qualityClass = 'ping-timeout';
    let msText = '-- ' + t('pingMs');

    if (hasPing) {
      const ms = s.ping_ms;
      msText = `${ms} ${t('pingMs')}`;
      if (ms < 80) qualityClass = 'ping-great';
      else if (ms < 130) qualityClass = 'ping-good';
      else if (ms < 180) qualityClass = 'ping-fair';
      else qualityClass = 'ping-high';

      if (ms < bestPing) {
        bestPing = ms;
        bestServerName = state.lang === 'fa' ? s.name_fa : (s.name || s.name_en);
      }
    }

    const card = document.createElement('div');
    card.className = `ping-card ${hasPing && s.ping_ms === bestPing ? 'is-best' : ''}`;

    const name = state.lang === 'fa' ? s.name_fa : (s.name || s.name_en);
    card.innerHTML = `
      <div class="sweep"></div>
      <div class="ping-card-top">
        <div class="ping-card-title">${name}</div>
        <span class="ping-code-badge">${s.id.toUpperCase()}</span>
      </div>
      <div class="ping-card-bottom">
        <span class="ping-ip" dir="ltr">${s.ip}</span>
        <div class="ping-ms-pill ${qualityClass}">
          <span class="ping-dot"></span>
          <span class="ping-val">${msText}</span>
        </div>
      </div>
    `;
    grid.appendChild(card);
  }
}

async function refreshValvePings() {
   if (pingingActive) return;
  pingingActive = true;
  const btn = document.getElementById('btn-refresh-ping');
  const grid = document.getElementById('ping-grid');
  const spinIcon = btn ? btn.querySelector('.refresh-icon') : null;
  if (btn) btn.disabled = true;
  if (spinIcon) spinIcon.classList.add('spin');

  if (grid && (!state.lastValvePings || state.lastValvePings.length === 0)) {
    grid.innerHTML = `<div class="dlp-loading"><div class="dlp-loader"><div class="l1"><div class="l2"><div class="l3"></div></div></div></div><span class="dlp-load-label">${t('pingTesting')}</span></div>`;
  }

  try {
    const servers = await call('ping_valve_servers');
    state.lastValvePings = servers;
    renderValvePings(servers);
  } catch (err) {
    console.error('[ping_valve_servers error]', err);
    if (grid && (!state.lastValvePings || state.lastValvePings.length === 0)) {
      grid.innerHTML = `<div class="ping-loading-msg text-danger">${String(err)}</div>`;
    }
  } finally {
    if (btn) btn.disabled = false;
    if (spinIcon) spinIcon.classList.remove('spin');
    pingingActive = false;
  }
}

// ---------- tab switcher (CSP-safe: no inline onclick) ----------
const SECTION_TITLES = {
  graphic: 'presetsTitle',
  latency: 'cardLatency',
  advanced: 'cardAdvanced',
};
const PANELS = ['graphic', 'latency', 'advanced'];

function selectCardByKey(tabKey) {
  const el = document.getElementById(`card-${tabKey}`);
  if (!el) return;
  document.querySelectorAll('.pro-card, .sci-card').forEach((card) => card.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('section-title').textContent = t(SECTION_TITLES[tabKey] || 'presetsTitle');
  for (const p of PANELS) {
    const pan = document.getElementById(`panel-${p}`);
    if (pan) pan.style.display = p === tabKey ? 'block' : 'none';
  }
  // install action only applies to graphic presets — hide elsewhere
  const footer = document.getElementById('action-footer');
  if (footer) footer.style.display = tabKey === 'graphic' ? 'flex' : 'none';
  // Motion One: slide+fade the activated panel in (micro-interaction)
  const active = document.getElementById(`panel-${tabKey}`);
  if (active && window.Motion) {
    Motion.animate(active, { opacity: [0, 1], transform: ['translateY(10px)', 'translateY(0px)'] }, { duration: 0.28, easing: 'ease-out' });
  }
  if (tabKey === 'latency') refreshValvePings();
  if (tabKey === 'advanced') renderBackups();
}

function getWin() {
  try {
    if (window.__TAURI__) {
      if (window.__TAURI__.webviewWindow && typeof window.__TAURI__.webviewWindow.getCurrentWebviewWindow === 'function') {
        return window.__TAURI__.webviewWindow.getCurrentWebviewWindow();
      }
      if (window.__TAURI__.window && typeof window.__TAURI__.window.getCurrentWindow === 'function') {
        return window.__TAURI__.window.getCurrentWindow();
      }
    }
  } catch (e) {}
  return null;
}

async function handleWinMin() {
  const w = getWin();
  if (w && typeof w.minimize === 'function') {
    try { await w.minimize(); return; } catch (e) {}
  }
  call('plugin:window|minimize', { label: 'main' }).catch(() => {});
}

async function handleWinMax() {
  const w = getWin();
  if (w && typeof w.isMaximized === 'function') {
    try {
      const maxed = await w.isMaximized();
      if (maxed) await w.unmaximize();
      else await w.maximize();
      setTimeout(updateScale, 50);
      setTimeout(updateScale, 200);
      return;
    } catch (e) {}
  }
  call('plugin:window|toggle_maximize', { label: 'main' }).catch(() => {});
  setTimeout(updateScale, 50);
  setTimeout(updateScale, 200);
}

async function handleWinClose() {
  const w = getWin();
  if (w && typeof w.close === 'function') {
    try { await w.close(); return; } catch (e) {}
  }
  call('plugin:window|close', { label: 'main' }).catch(() => {});
}

function setupTitlebarDrag() {
  const titlebar = document.querySelector('.app-titlebar');
  if (!titlebar) return;
  titlebar.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button, input, select, textarea, [data-tauri-drag-region="false"]')) return;
    const w = getWin();
    if (w && typeof w.startDragging === 'function') {
      w.startDragging().catch(() => {});
    } else {
      call('plugin:window|start_dragging', { label: 'main' }).catch(() => {});
    }
  });
  titlebar.addEventListener('dblclick', (e) => {
    if (e.target.closest('button, input, select, textarea, [data-tauri-drag-region="false"]')) return;
    handleWinMax();
  });
}

function updateScale() {
  const wrapper = document.getElementById('ui-scale-wrapper');
  if (!wrapper) return;
  const availW = window.innerWidth;
  const availH = window.innerHeight - 40; // titlebar is 40px
  const baseW = 920;
  const baseH = 540;
  // If window is at least base dimensions, keep native 1:1 scale (zero transform = 100% razor sharp native DirectWrite pixel grid)
  if (availW >= baseW && availH >= baseH) {
    wrapper.style.transform = 'none';
    return;
  }
  // Only downscale if the user resized the window smaller than base design dimensions
  const scale = Math.min(1, Math.min(availW / baseW, availH / baseH));
  wrapper.style.transform = `scale(${scale.toFixed(4)})`;
}

function selectPreset(mode) {
  state.selectedMode = mode;
  document.querySelectorAll('.tier-card, .tier-card-sm, .option-item.preset').forEach((p) => {
    const was = p.classList.contains('selected');
    p.classList.toggle('selected', p.dataset.mode === mode);
    // Animate.css: pop the card when it becomes selected
    if (!was && p.dataset.mode === mode && window.__animateStyle) {
      p.classList.add('animate__animated', 'animate__zoomIn');
      p.addEventListener('animationend', () => p.classList.remove('animate__animated', 'animate__zoomIn'), { once: true });
    }
  });
}

window.updateScale = updateScale;
window.selectPreset = selectPreset;
window.handleWinMin = handleWinMin;
window.handleWinMax = handleWinMax;
window.handleWinClose = handleWinClose;
window.toggleLang = () => setLang(state.lang === 'fa' ? 'en' : 'fa');
window.selectCardByKey = selectCardByKey;
window.refreshValvePings = refreshValvePings;
window.launchGame = launchGame;
window.pickFolder = pickFolder;
window.confirmPath = confirmPath;
window.doInstall = doInstall;
window.doBackupNow = doBackupNow;
window.doRevertVanilla = doRevertVanilla;
window.doUnlock = doUnlock;
window.setFov = setFov;

// ---------- wire everything ----------
function init() {
  try {
    updateScale();
    window.addEventListener('resize', updateScale);
    // flag Animate.css availability (loaded before app.js)
    window.__animateStyle = !!document.querySelector('link[href*="animate.min.css"]');
    // boot entrance: staggered card rise
    if (window.__animateStyle) {
      document.querySelectorAll('.cards-deck .pro-card').forEach((card, i) => {
        card.style.setProperty('--animate-delay', `${i * 0.07}s`);
        card.classList.add('animate__animated', 'animate__fadeInUp');
        card.addEventListener('animationend', () => card.classList.remove('animate__animated', 'animate__fadeInUp'), { once: true });
      });
    }
    // window controls
    const btnMin = document.getElementById('btn-min');
    if (btnMin) btnMin.onclick = handleWinMin;
    const btnMax = document.getElementById('btn-max');
    if (btnMax) btnMax.onclick = handleWinMax;
    const btnClose = document.getElementById('btn-close');
    if (btnClose) btnClose.onclick = handleWinClose;
    setupTitlebarDrag();

    // language switcher
    const btnLang = document.getElementById('btn-lang-toggle');
    if (btnLang) btnLang.onclick = window.toggleLang;

    // actions
    document.getElementById('btn-pick-folder').onclick = pickFolder;
    document.getElementById('btn-confirm-path').onclick = confirmPath;
    document.getElementById('btn-launch').onclick = launchGame;
    document.querySelectorAll('.social-card[data-url]').forEach((b) => {
      b.onclick = () => openExternal(b.dataset.url);
    });
    document.getElementById('btn-install').onclick = doInstall;
    document.getElementById('btn-backup').onclick = doBackupNow;
    document.getElementById('btn-revert-vanilla').onclick = doRevertVanilla;
    document.getElementById('btn-unlock').onclick = doUnlock;

    // options & switches
    const swUnit = document.getElementById('sw-unit-status');
    if (swUnit) {
      swUnit.onchange = (e) => {
        state.unitStatusNew = e.target.checked;
        call('set_settings', { patch: { unit_status_new: e.target.checked } }).catch(() => {});
      };
    }

    // Engine controls
    const selBias = document.getElementById('sel-texture-bias');
    if (selBias) {
      selBias.onchange = (e) => {
        state.textureBias = Number(e.target.value);
        call('set_settings', { patch: { texture_bias: state.textureBias } }).catch(() => {});
      };
    }
    const swRagdoll = document.getElementById('sw-ragdoll-limit');
    if (swRagdoll) {
      swRagdoll.onchange = (e) => {
        state.ragdollGibLimit = e.target.checked;
        call('set_settings', { patch: { ragdoll_gib_limit: state.ragdollGibLimit } }).catch(() => {});
      };
    }

    // Latency controls: Reflex
    document.querySelectorAll('#seg-reflex .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#seg-reflex .seg-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.reflexMode = Number(btn.dataset.val);
        call('set_settings', { patch: { reflex_mode: state.reflexMode } }).catch(() => {});
      });
    });

    // Latency controls: FPS cap
    const inpFps = document.getElementById('inp-fps-max');
    document.querySelectorAll('#chips-fps .chip-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#chips-fps .chip-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const val = Number(btn.dataset.val);
        state.fpsMax = val;
        if (inpFps) inpFps.value = val;
        call('set_settings', { patch: { fps_max: val } }).catch(() => {});
      });
    });
    if (inpFps) {
      inpFps.onchange = (e) => {
        const val = Math.max(0, Number(e.target.value) || 0);
        state.fpsMax = val;
        document.querySelectorAll('#chips-fps .chip-btn').forEach((b) => {
          b.classList.toggle('active', Number(b.dataset.val) === val);
        });
        call('set_settings', { patch: { fps_max: val } }).catch(() => {});
      };
    }

    const swVsync = document.getElementById('sw-vsync');
    if (swVsync) {
      swVsync.onchange = (e) => {
        state.vsync = e.target.checked;
        call('set_settings', { patch: { vsync: state.vsync } }).catch(() => {});
      };
    }

    const swFlash = document.getElementById('sw-reduce-flash');
    if (swFlash) {
      swFlash.onchange = (e) => {
        state.reduceFlash = e.target.checked;
        call('set_settings', { patch: { reduce_flash: state.reduceFlash } }).catch(() => {});
      };
    }

    // FOV controls
    const slider = document.getElementById('fov-slider');
    const number = document.getElementById('fov-number');
    if (slider) slider.oninput = () => setFov(Number(slider.value));
    if (number) number.onchange = () => setFov(Number(number.value) || 90);
    const pFov = document.getElementById('panel-fov');
    if (pFov) {
      pFov.addEventListener('wheel', (e) => {
        e.preventDefault();
        setFov(Number(slider ? slider.value : 90) + (e.deltaY < 0 ? 5 : -5));
      }, { passive: false });
    }
    document.querySelectorAll('#chips-fov .chip-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const val = Number(btn.dataset.val);
        setFov(val);
      });
    });
    const btnFovReset = document.getElementById('btn-fov-reset');
    if (btnFovReset) {
      btnFovReset.onclick = () => setFov(90);
    }

    // preset cards (single select, includes TEMP modes when visible)
    document.querySelectorAll('.tier-card, .tier-card-sm, .option-item.preset').forEach((el) => {
      el.addEventListener('click', () => {
        selectPreset(el.dataset.mode);
      });
    });
    // default selection so INSTALL always has a mode
    state.selectedMode = 'T1';
    selectPreset('T1');

    // tab cards — replace inline onclick with proper listeners
    document.querySelectorAll('.pro-card[id^="card-"], .sci-card[id^="card-"]').forEach((card) => {
      const key = card.id.replace('card-', '');
      card.addEventListener('click', () => selectCardByKey(key));
    });

    boot();
  } catch (err) {
    fatal(err);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

window.addEventListener('error', (e) => fatal(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => fatal(e.reason));

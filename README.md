# DLPBooster

GUI for the DeadlockBoost console payload: performance tier installs, POTATO mode,
backup/restore, per-user FOV, FA/EN interface, tester TEMP modes, auto-updater.

## Download

Get `DLP Booster_0.1.0_x64-setup.exe` from the
[Releases page](https://github.com/Aryobw9-H/DLPBooster/releases) (bare exe in a
zip also works — the app is self-contained).

**SmartScreen note:** the exe is unsigned in early releases. Windows may show a
blue warning — click "More info" → "Run anyway". This is expected and goes away
with signed releases later.

## What it does

- **Tier 1 / 2 / 3**: performance configs for `gameinfo.gi` + `cfg\video.txt` plus
  the matching addon set (tier 1–3 skip the 3 look-changing mods, POTATO installs
  only those 3).
- **POTATO**: absolute minimum visuals for max FPS.
- **FOV 70–120**: per-user field of view with aspect-ratio anchors, applied on
  every install.
- **New Deadlock UI toggle**: writes the `citadel_unit_status_use_new` managed
  block to `cfg\autoexec.cfg` on the next install (your own autoexec content is
  never touched).
- **Backup / Restore**: every install is preceded by automatic `.dlp.bak`
  snapshots (permanent, never deleted). Manual backups land in
  `%APPDATA%\DLPBooster\backups\` and can be restored from the history list —
  restore removes exactly the addons this tool added (tracked in
  `addons_manifest.txt`) and keeps your own mods.
- **TEMP modes** (tester code required): tier config with ALL 9 mods including
  the look-changing ones. Ask for a code.
- **Guard**: refuses to modify files while Deadlock is running (popup lets you
  continue at your own risk).
- **Auto-updater**: the app checks GitHub Releases for `latest.json` on startup.
  404 (no release yet) is silently ignored.

## For developers

- `src-tauri/build_payload.py` zips the private console payload from
  `D:\Claude\ddlock` into `src-tauri/payload.zip` before every build. That zip is
  **never committed** (gitignored, stays private). Everything else is MIT.
- Tests: `cargo test -p dlp-core` (payload, discovery, fov, merge goldens,
  detect fixtures, addon collision matrix, backup/restore roundtrip, install
  sandbox e2e).
- Build: `npm install && npm run tauri build`. Signed updater artifacts need
  `TAURI_SIGNING_PRIVATE_KEY` (see `.tauri/dlpbooster.key` — keep it secret, it
  is the release identity).
- Release uploads need the private key + `latest.json` pointing at the release
  assets (Task 13, on hold until Aryo says go).

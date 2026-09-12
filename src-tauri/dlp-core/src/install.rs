// Install orchestrator — port of install.bat main flow for the GUI.
// Order: guard -> write test -> .dlp.bak snapshot -> tier gi with FOV swap ->
// addons (per-mode only/exclude) -> video merge (read-only dance) -> optional
// autoexec block. Returns a step log for the frontend progress view.
use std::path::Path;

use crate::addons;
use crate::backup::set_readonly;
use crate::kvedit;
use crate::payload;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    T1,
    T2,
    T3,
    Potato,
    T1Mods,
    T2Mods,
}

impl Mode {
    pub fn tier_dir(self) -> &'static str {
        match self {
            Mode::T1 | Mode::T1Mods => "gi_tier1",
            Mode::T2 | Mode::T2Mods => "gi_tier2",
            Mode::T3 | Mode::Potato => "gi_tier3",
        }
    }
    pub fn video_dir(self) -> &'static str {
        match self {
            Mode::Potato => "potato",
            other => other.tier_dir(),
        }
    }
    /// addons.ps1 -Only / -Exclude per install.bat:
    /// tiers 1-3 exclude the look-changing 01/02/03; potato gets ONLY those;
    /// TEMP mods modes install ALL 9.
    pub fn addon_lists(self) -> (&'static str, &'static str) {
        const LOOK: &str = "pak01_dir.vpk,pak02_dir.vpk,pak03_dir.vpk";
        match self {
            Mode::T1 | Mode::T2 | Mode::T3 => ("", LOOK),
            Mode::Potato => (LOOK, ""),
            Mode::T1Mods | Mode::T2Mods => ("", ""),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct StepLog {
    pub step: String,
    pub detail: String,
    pub skipped: bool,
}

/// UTC timestamp helper (backup folder names; no chrono dep needed).
pub fn timestamp_utc(secs: u64) -> String {
    // days->y/m/d civil algorithm (Howard Hinnant), no external crate
    let days = (secs / 86400) as i64;
    let secs_of_day = secs % 86400;
    let (h, m, s) = (secs_of_day / 3600, (secs_of_day % 3600) / 60, secs_of_day % 60);
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mth = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mth <= 2 { y + 1 } else { y };
    format!("{y:04}-{mth:02}-{d:02}_{h:02}{m:02}{s:02}")
}

pub fn write_test(citadel: &Path) -> Result<(), String> {
    let p = citadel.join("_wtest.tmp");
    match std::fs::write(&p, b"t").and_then(|_| std::fs::remove_file(&p)) {
        Ok(_) => Ok(()),
        Err(_) => Err("NeedsAdmin: cannot write to the game folder - run the app as administrator".into()),
    }
}

fn snapshot_original(citadel: &Path) -> Result<Vec<StepLog>, String> {
    let mut log = vec![];
    for (src, bak) in [
        (citadel.join("gameinfo.gi"), citadel.join("gameinfo.gi.dlp.bak")),
        (citadel.join("cfg").join("video.txt"), citadel.join("cfg").join("video.txt.dlp.bak")),
    ] {
        if !bak.exists() {
            if src.exists() {
                std::fs::copy(&src, &bak).map_err(|e| e.to_string())?;
            } else if src.file_name().unwrap() == "gameinfo.gi" {
                std::fs::write(&src, b"").map_err(|e| e.to_string())?; // console: copy nul
                std::fs::copy(&src, &bak).map_err(|e| e.to_string())?;
            }
            log.push(StepLog { step: "backup".into(), detail: format!("snapshot {}", bak.file_name().unwrap().to_string_lossy()), skipped: false });
        }
    }
    Ok(log)
}

pub fn install(mode: Mode, fov: u32, deadlock: &str, pkg: &Path, data_dir: &Path) -> Result<Vec<StepLog>, String> {
    let mut log = vec![];
    let citadel = Path::new(deadlock).join("game").join("citadel");

    // 1) guard (BACKUP/RESTORE exempt — those go through backup.rs, not here).
    // Sandbox tests also count: any DLPB sandbox install dir is not a real game.
    if std::env::var("DLPB_NOGUARD").as_deref() != Ok("1") && std::env::var("DLPB_TEST_SANDBOX").as_deref() != Ok("1") {
        let running = crate::guard::game_running();
        if !running.is_empty() {
            return Err(format!("game running: {} — close Deadlock first", running.join(", ")));
        }
    }

    // 2) write test
    write_test(&citadel)?;
    log.push(StepLog { step: "write-test".into(), detail: "game folder writable".into(), skipped: false });

    // 3) .dlp.bak snapshots (permanent restore points, never deleted)
    log.extend(snapshot_original(&citadel)?);

    // 4) tier gameinfo.gi with per-user FOV swapped in
    let ar = crate::fov::aspect_ratio(fov);
    let src_gi = pkg.join(mode.tier_dir()).join("gameinfo.gi");
    let tpl = std::fs::read_to_string(&src_gi).map_err(|e| e.to_string())?;
    let staged = kvedit::set_fov(&tpl, ar);
    let dst_gi = citadel.join("gameinfo.gi");
    let current = std::fs::read(&dst_gi).unwrap_or_default();
    if current == staged.as_bytes() {
        log.push(StepLog { step: "gameinfo.gi".into(), detail: format!("already identical - skipped ({})", mode.tier_dir()), skipped: true });
    } else {
        std::fs::write(&dst_gi, &staged).map_err(|e| e.to_string())?;
        log.push(StepLog { step: "gameinfo.gi".into(), detail: format!("replaced with {} (FOV {fov}, AR {ar})", mode.tier_dir()), skipped: false });
    }

    // 5) addons per mode
    let (only, exclude) = mode.addon_lists();
    let rep = addons::install_addons(&pkg.join("addons"), &citadel.join("addons"), only, exclude)
        .map_err(|e| e.to_string())?;
    log.push(StepLog {
        step: "addons".into(),
        detail: format!(
            "{} added, {} identical, {} renumbered, {} user-kept",
            rep.added.len(), rep.skipped.len(), rep.renumbered.len(), rep.kept_user.len()
        ),
        skipped: rep.added.is_empty() && rep.renumbered.is_empty(),
    });

    // 6) video merge with read-only dance
    let vd = citadel.join("cfg").join("video.txt");
    if !vd.exists() {
        return Err("cfg\\video.txt missing - wrong folder?".into());
    }
    set_readonly(&vd, false).map_err(|e| e.to_string())?;
    let user_v = std::fs::read_to_string(&vd).map_err(|e| e.to_string())?;
    let tpl_v = std::fs::read_to_string(pkg.join(mode.video_dir()).join("video.txt")).map_err(|e| e.to_string())?;
    let merged = kvedit::merge_video(&user_v, &tpl_v);
    std::fs::write(&vd, &merged).map_err(|e| e.to_string())?;
    set_readonly(&vd, true).map_err(|e| e.to_string())?;
    log.push(StepLog { step: "video.txt".into(), detail: "patched + write-protected (backup: video.txt.dlp.bak)".into(), skipped: false });

    // 7) autoexec managed block per settings flag
    let s = crate::settings::load();
    let cfg_dir = citadel.join("cfg");
    std::fs::create_dir_all(&cfg_dir).map_err(|e| e.to_string())?;
    let ae = cfg_dir.join("autoexec.cfg");
    let existing = std::fs::read_to_string(&ae).unwrap_or_default();
    let new_ae = kvedit::upsert_autoexec(&existing, s.unit_status_new);
    if new_ae != existing {
        std::fs::write(&ae, new_ae).map_err(|e| e.to_string())?;
        log.push(StepLog {
            step: "autoexec.cfg".into(),
            detail: if s.unit_status_new { "managed block written (new unit status UI)".into() } else { "managed block removed".into() },
            skipped: false,
        });
    }

    Ok(log)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sandbox(tag: &str) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let base = std::env::temp_dir().join(format!("dlpb_inst_{tag}"));
        crate::backup::rm_ro(&base);
        // layout must mirror a real install: <deadlock>\game\citadel
        let cit = base.join("game").join("citadel");
        std::fs::create_dir_all(cit.join("cfg")).unwrap();
        std::fs::create_dir_all(cit.join("addons")).unwrap();
        std::fs::write(cit.join("gameinfo.gi"), "\"Version\" \"13\"\n\"r_aspectratio\"\t\t\t\t\t\t\"2.15\"\n").unwrap();
        std::fs::write(cit.join("cfg").join("video.txt"), "\"Version\" \"11\"\n\"setting.defaultres\" \"2560\"\n\"setting.defaultresheight\" \"1440\"\n\"setting.refreshrate_numerator\" \"165\"\n").unwrap();
        let data = base.join("data");
        std::fs::create_dir_all(&data).unwrap();
        std::env::set_var("DLPB_TEST_SANDBOX", "1"); // process-wide, once is enough
        let pkg = crate::payload::extract_to(&base.join("pkg")).unwrap();
        (cit, data, pkg)
    }

    #[test]
    fn sandbox_t1_end_to_end() {
        let (cit, data, pkg) = sandbox("t1");
        let deadlock = cit.parent().unwrap().parent().unwrap().to_path_buf(); // <deadlock> root
        let log = install(Mode::T1, 90, deadlock.to_str().unwrap(), &pkg, &data).unwrap();
        // step log lines
        for step in ["write-test", "gameinfo.gi", "addons", "video.txt"] {
            assert!(log.iter().any(|l| l.step == step), "missing {step} in {log:?}");
        }
        // gi contains aspectratio 2.15 (FOV 90)
        let gi = std::fs::read_to_string(cit.join("gameinfo.gi")).unwrap();
        assert!(gi.contains("\"r_aspectratio\"\t\t\t\t\t\t\"2.15\""), "gi: {gi}");
        // permanent snapshots
        assert!(cit.join("gameinfo.gi.dlp.bak").is_file());
        assert!(cit.join("cfg").join("video.txt.dlp.bak").is_file());
        // 6 vpks (9 minus 01/02/03), manifest has entries
        let count = std::fs::read_dir(cit.join("addons")).unwrap().flatten().count();
        assert_eq!(count, 6, "expected 6 vpks");
        let man = std::fs::read_to_string(cit.join("addons_manifest.txt")).unwrap();
        assert_eq!(man.lines().count(), 6);
        // video.txt merged with user identity + read-only
        let v = std::fs::read_to_string(cit.join("cfg").join("video.txt")).unwrap();
        assert!(v.contains("\"Version\"		\"11\""), "Version kept: {v}");
        assert!(v.contains("\"setting.defaultres\" \"2560\""));
        assert!(std::fs::metadata(cit.join("cfg").join("video.txt")).unwrap().permissions().readonly());
        crate::backup::rm_ro(cit.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn sandbox_potato_three_vpks() {
        let (cit, data, pkg) = sandbox("pot");
        let deadlock = cit.parent().unwrap().parent().unwrap().to_path_buf(); // <deadlock> root
        install(Mode::Potato, 100, deadlock.to_str().unwrap(), &pkg, &data).unwrap();
        // potato gi = tier3, AR for fov 100 = 2.49
        let gi = std::fs::read_to_string(cit.join("gameinfo.gi")).unwrap();
        assert!(gi.contains("\"r_aspectratio\"\t\t\t\t\t\t\"2.49\""), "gi: {gi}");
        let vpks: Vec<String> = std::fs::read_dir(cit.join("addons")).unwrap().flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(vpks.len(), 3);
        for n in ["pak01_dir.vpk", "pak02_dir.vpk", "pak03_dir.vpk"] {
            assert!(vpks.iter().any(|v| v == n), "missing {n}");
        }
        crate::backup::rm_ro(cit.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn sandbox_idempotent_second_run() {
        let (cit, data, pkg) = sandbox("idem");
        let deadlock = cit.parent().unwrap().parent().unwrap().to_path_buf(); // <deadlock> root
        install(Mode::T1, 90, deadlock.to_str().unwrap(), &pkg, &data).unwrap();
        let second = install(Mode::T1, 90, deadlock.to_str().unwrap(), &pkg, &data).unwrap();
        let gi_step = second.iter().find(|l| l.step == "gameinfo.gi").unwrap();
        assert!(gi_step.skipped, "second run should skip identical gi: {gi_step:?}");
        crate::backup::rm_ro(cit.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn timestamp_shape() {
        let ts = timestamp_utc(0);
        assert_eq!(ts, "1970-01-01_000000");
        // 2026-09-12 00:00:00 UTC = 1789171200
        assert_eq!(timestamp_utc(1789171200), "2026-09-12_000000");
    }
}

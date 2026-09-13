// Port of backup.ps1 + new restore-from-history (replaces console revert flow).
// Backups go to <data_dir>\backups\backup_YYYY-MM-DD_HHMMSS\ containing
// gameinfo.gi, video.txt, addons\*.vpk, addons_manifest.txt (only what exists).
// Restore: clear read-only on video.txt, copy gi+video back, delete every vpk
// listed in the CURRENT addons_manifest.txt (removes exactly what we added),
// copy backup addons back, NEVER touch *.dlp.bak snapshots (permanent).
use std::path::Path;

/// Remove a directory tree, clearing read-only flags first (Windows
/// remove_dir_all fails on read-only files — installs leave video.txt RO).
pub fn rm_ro(dir: &std::path::Path) {
    fn clear_ro(p: &std::path::Path) {
        if let Ok(md) = std::fs::symlink_metadata(p) {
            if md.permissions().readonly() {
                let mut perms = md.permissions();
                perms.set_readonly(false);
                let _ = std::fs::set_permissions(p, perms);
            }
        }
    }
    fn walk(p: &std::path::Path) {
        if let Ok(rd) = std::fs::read_dir(p) {
            for e in rd.flatten() {
                let ep = e.path();
                if ep.is_dir() {
                    walk(&ep);
                } else {
                    clear_ro(&ep);
                }
            }
        }
        clear_ro(p);
    }
    walk(dir);
    let _ = std::fs::remove_dir_all(dir);
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct RestoreReport {
    pub restored_gi: bool,
    pub restored_video: bool,
    pub removed_addons: Vec<String>,
    pub restored_addons: usize,
}

pub fn backups_root(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join("backups")
}

/// All backup folder names, sorted newest first.
pub fn list_backups(data_dir: &Path) -> Vec<String> {
    let root = backups_root(data_dir);
    let mut names: Vec<String> = std::fs::read_dir(&root)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.path().is_dir())
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|n| n.starts_with("backup_"))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names.reverse();
    names
}

/// Copy current state into a datestamped backup folder. Returns folder name.
/// Errors (String) when nothing found to back up (console exit-4 parity).
pub fn do_backup(citadel: &Path, data_dir: &Path) -> Result<String, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?;
    let name = format!("backup_{}", crate::install::timestamp_utc(now.as_secs()));
    let target = backups_root(data_dir).join(&name);
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;

    let mut copied = 0usize;
    let copy_one = |src: &Path, name: &str| -> usize {
        if src.is_file() {
            let _ = std::fs::copy(src, target.join(name));
            1
        } else {
            0
        }
    };
    copied += copy_one(&citadel.join("gameinfo.gi"), "gameinfo.gi");
    copied += copy_one(&citadel.join("cfg").join("video.txt"), "video.txt");

    let ad = citadel.join("addons");
    if ad.is_dir() {
        std::fs::create_dir_all(target.join("addons")).ok();
        let mut n = 0usize;
        for f in std::fs::read_dir(&ad).map_err(|e| e.to_string())?.flatten() {
            if f.path().extension().map(|e| e == "vpk").unwrap_or(false) {
                let _ = std::fs::copy(f.path(), target.join("addons").join(f.file_name()));
                n += 1;
            }
        }
        copied += n;
        copied += copy_one(&citadel.join("addons_manifest.txt"), "addons_manifest.txt");
    }

    if copied == 0 {
        // nothing found: remove the empty folder, mirror console exit 4
        let _ = std::fs::remove_dir_all(&target);
        return Err("nothing found to back up".into());
    }
    Ok(name)
}

/// Restore a named backup folder into citadel. `.dlp.bak` snapshots untouched.
pub fn restore(citadel: &Path, data_dir: &Path, name: &str) -> Result<RestoreReport, String> {
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("invalid backup name".into());
    }
    let bdir = backups_root(data_dir).join(name);
    if !bdir.is_dir() {
        return Err(format!("backup not found: {name}"));
    }
    let mut rep = RestoreReport { restored_gi: false, restored_video: false, removed_addons: vec![], restored_addons: 0 };

    // 1+2) gameinfo.gi + video.txt (clear read-only first — installer left it RO)
    let gi_b = bdir.join("gameinfo.gi");
    if gi_b.is_file() {
        std::fs::copy(&gi_b, citadel.join("gameinfo.gi")).map_err(|e| e.to_string())?;
        rep.restored_gi = true;
    }
    let vd_b = bdir.join("video.txt");
    if vd_b.is_file() {
        let vd = citadel.join("cfg").join("video.txt");
        if vd.exists() {
            set_readonly(&vd, false).map_err(|e| e.to_string())?;
        }
        std::fs::create_dir_all(vd.parent().unwrap()).map_err(|e| e.to_string())?;
        std::fs::copy(&vd_b, &vd).map_err(|e| e.to_string())?;
        rep.restored_video = true;
    }

    // 3) remove every vpk listed in the CURRENT manifest (ours), keep user's own
    let man = citadel.join("addons_manifest.txt");
    if man.is_file() {
        let content = std::fs::read_to_string(&man).map_err(|e| e.to_string())?;
        for ln in content.lines() {
            let n = ln.trim();
            if n.is_empty() {
                continue;
            }
            let p = citadel.join("addons").join(n);
            if p.is_file() {
                std::fs::remove_file(&p).map_err(|e| e.to_string())?;
                rep.removed_addons.push(n.to_string());
            }
        }
        let _ = std::fs::remove_file(&man);
    }

    // 4) copy backup addons back (user's own mods from before our install)
    let ba = bdir.join("addons");
    if ba.is_dir() {
        std::fs::create_dir_all(citadel.join("addons")).map_err(|e| e.to_string())?;
        for f in std::fs::read_dir(&ba).map_err(|e| e.to_string())?.flatten() {
            if f.path().is_file() {
                std::fs::copy(f.path(), citadel.join("addons").join(f.file_name()))
                    .map_err(|e| e.to_string())?;
                rep.restored_addons += 1;
            }
        }
    }
    Ok(rep)
}

/// Restore user's original vanilla files from permanent DLP snapshots (.dlp.bak)
/// and remove addons installed by DLP Booster (tracked in addons_manifest.txt).
/// Managed autoexec block is also removed.
/// Snapshots (.dlp.bak) are permanent and never deleted.
pub fn revert_original(citadel: &Path) -> Result<RestoreReport, String> {
    let mut rep = RestoreReport {
        restored_gi: false,
        restored_video: false,
        removed_addons: vec![],
        restored_addons: 0,
    };

    // 1) gameinfo.gi from gameinfo.gi.dlp.bak
    let gi_bak = citadel.join("gameinfo.gi.dlp.bak");
    if gi_bak.is_file() {
        std::fs::copy(&gi_bak, citadel.join("gameinfo.gi")).map_err(|e| e.to_string())?;
        rep.restored_gi = true;
    }

    // 2) video.txt from video.txt.dlp.bak
    let vd = citadel.join("cfg").join("video.txt");
    let vd_bak = citadel.join("cfg").join("video.txt.dlp.bak");
    if vd_bak.is_file() {
        if vd.exists() {
            set_readonly(&vd, false).map_err(|e| e.to_string())?;
        }
        std::fs::create_dir_all(vd.parent().unwrap()).map_err(|e| e.to_string())?;
        std::fs::copy(&vd_bak, &vd).map_err(|e| e.to_string())?;
        // Left writable (stock behavior)
        rep.restored_video = true;
    }

    // 3) addons from manifest
    let man = citadel.join("addons_manifest.txt");
    if man.is_file() {
        let content = std::fs::read_to_string(&man).map_err(|e| e.to_string())?;
        for ln in content.lines() {
            let n = ln.trim();
            if n.is_empty() {
                continue;
            }
            let p = citadel.join("addons").join(n);
            if p.is_file() {
                let _ = std::fs::remove_file(&p);
                rep.removed_addons.push(n.to_string());
            }
        }
        let _ = std::fs::remove_file(&man);
    }

    // 4) autoexec: strip managed block if present
    let ae = citadel.join("cfg").join("autoexec.cfg");
    if ae.is_file() {
        if let Ok(existing) = std::fs::read_to_string(&ae) {
            let stripped = crate::kvedit::upsert_autoexec(&existing, false);
            if stripped != existing {
                let _ = std::fs::write(&ae, stripped);
            }
        }
    }

    if !rep.restored_gi && !rep.restored_video && rep.removed_addons.is_empty() {
        return Err("nothing to revert - no .dlp.bak snapshots or addons manifest found".into());
    }

    Ok(rep)
}

pub fn set_readonly(p: &Path, ro: bool) -> std::io::Result<()> {
    let mut perms = std::fs::metadata(p)?.permissions();
    perms.set_readonly(ro);
    std::fs::set_permissions(p, perms)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mkcit(tag: &str) -> std::path::PathBuf {
        let cit = std::env::temp_dir().join(format!("dlpb_bk_{tag}"));
        let _ = std::fs::remove_dir_all(&cit);
        std::fs::create_dir_all(cit.join("cfg")).unwrap();
        std::fs::create_dir_all(cit.join("addons")).unwrap();
        cit
    }

    #[test]
    fn backup_restore_roundtrip() {
        let cit = mkcit("rt");
        let data = std::env::temp_dir().join("dlpb_bk_data_rt");
        let _ = std::fs::remove_dir_all(&data);
        std::fs::write(cit.join("gameinfo.gi"), b"GI-ORIGINAL").unwrap();
        std::fs::write(cit.join("cfg").join("video.txt"), b"VIDEO-ORIGINAL").unwrap();
        std::fs::write(cit.join("addons").join("user_mod.vpk"), b"USER-MOD").unwrap();
        // snapshot .dlp.bak must survive restore untouched
        std::fs::write(cit.join("gameinfo.gi.dlp.bak"), b"SNAPSHOT").unwrap();

        let name = do_backup(&cit, &data).unwrap();
        assert!(name.starts_with("backup_"));
        assert_eq!(list_backups(&data), vec![name.clone()]);

        // mutate everything
        std::fs::write(cit.join("gameinfo.gi"), b"GI-T1").unwrap();
        std::fs::write(cit.join("cfg").join("video.txt"), b"VIDEO-T1").unwrap();
        std::fs::write(cit.join("addons_manifest.txt"), "pak04_dir.vpk\npak05_dir.vpk\n").unwrap();
        std::fs::write(cit.join("addons").join("pak04_dir.vpk"), b"OUR-04").unwrap();
        std::fs::write(cit.join("addons").join("pak05_dir.vpk"), b"OUR-05").unwrap();

        set_readonly(&cit.join("cfg").join("video.txt"), true).unwrap();
        let rep = restore(&cit, &data, &name).unwrap();
        assert!(rep.restored_gi && rep.restored_video);
        assert_eq!(rep.removed_addons, vec!["pak04_dir.vpk", "pak05_dir.vpk"]);
        assert_eq!(std::fs::read(cit.join("gameinfo.gi")).unwrap(), b"GI-ORIGINAL");
        assert_eq!(std::fs::read(cit.join("cfg").join("video.txt")).unwrap(), b"VIDEO-ORIGINAL");
        // read-only flag cleared by restore
        assert!(!std::fs::metadata(cit.join("cfg").join("video.txt")).unwrap().permissions().readonly());
        // our vpks removed, user's own kept, backup addons copied back
        assert!(!cit.join("addons").join("pak04_dir.vpk").exists());
        assert!(!cit.join("addons").join("pak05_dir.vpk").exists());
        assert_eq!(std::fs::read(cit.join("addons").join("user_mod.vpk")).unwrap(), b"USER-MOD");
        // permanent snapshot untouched
        assert_eq!(std::fs::read(cit.join("gameinfo.gi.dlp.bak")).unwrap(), b"SNAPSHOT");
        let _ = std::fs::remove_dir_all(&cit);
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn backup_nothing_found_errors() {
        let cit = mkcit("empty");
        let data = std::env::temp_dir().join("dlpb_bk_data_empty");
        let _ = std::fs::remove_dir_all(&data);
        assert!(do_backup(&cit, &data).is_err());
        let _ = std::fs::remove_dir_all(&cit);
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn restore_rejects_path_traversal() {
        let cit = mkcit("trav");
        let data = std::env::temp_dir().join("dlpb_bk_data_trav");
        assert!(restore(&cit, &data, "../evil").is_err());
        let _ = std::fs::remove_dir_all(&cit);
    }

    #[test]
    fn list_backups_newest_first() {
        let data = std::env::temp_dir().join("dlpb_bk_data_order");
        let _ = std::fs::remove_dir_all(&data);
        for n in ["backup_2026-01-01_000001", "backup_2026-09-12_101010", "backup_2026-05-05_050505"] {
            std::fs::create_dir_all(data.join("backups").join(n)).unwrap();
        }
        let v = list_backups(&data);
        assert_eq!(v[0], "backup_2026-09-12_101010");
        assert_eq!(v[2], "backup_2026-01-01_000001");
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn revert_original_roundtrip() {
        let cit = mkcit("revert_rt");
        // Snapshots exist
        std::fs::write(cit.join("gameinfo.gi.dlp.bak"), b"GI-ORIGINAL").unwrap();
        std::fs::write(cit.join("cfg").join("video.txt.dlp.bak"), b"VIDEO-ORIGINAL").unwrap();
        // Mutated state
        std::fs::write(cit.join("gameinfo.gi"), b"GI-MODIFIED").unwrap();
        std::fs::write(cit.join("cfg").join("video.txt"), b"VIDEO-MODIFIED").unwrap();
        set_readonly(&cit.join("cfg").join("video.txt"), true).unwrap();
        std::fs::write(cit.join("addons_manifest.txt"), "pak04_dir.vpk\n").unwrap();
        std::fs::write(cit.join("addons").join("pak04_dir.vpk"), b"VPK").unwrap();

        let rep = revert_original(&cit).unwrap();
        assert!(rep.restored_gi);
        assert!(rep.restored_video);
        assert_eq!(rep.removed_addons, vec!["pak04_dir.vpk"]);
        assert_eq!(std::fs::read(cit.join("gameinfo.gi")).unwrap(), b"GI-ORIGINAL");
        assert_eq!(std::fs::read(cit.join("cfg").join("video.txt")).unwrap(), b"VIDEO-ORIGINAL");
        // Readonly flag must be cleared
        assert!(!std::fs::metadata(cit.join("cfg").join("video.txt")).unwrap().permissions().readonly());
        // Manifest must be deleted and addon removed
        assert!(!cit.join("addons_manifest.txt").exists());
        assert!(!cit.join("addons").join("pak04_dir.vpk").exists());
        // Snapshots remain permanent
        assert!(cit.join("gameinfo.gi.dlp.bak").is_file());
        assert!(cit.join("cfg").join("video.txt.dlp.bak").is_file());

        let _ = std::fs::remove_dir_all(&cit);
    }
}

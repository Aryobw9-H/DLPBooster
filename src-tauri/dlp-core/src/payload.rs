// Embedded console payload (tier dirs + addons). Extracted fresh per action —
// never reused across runs (stale stable-copy trap from the console .bat).
pub static PAYLOAD_ZIP: &[u8] = include_bytes!("../../payload.zip");

pub fn extract() -> std::io::Result<std::path::PathBuf> {
    extract_to(&std::env::temp_dir().join("DLPBoosterPkg"))
}

/// Extract into an explicit dir (tests use per-test dirs — the default dir is
/// shared process-global and parallel tests would race on the wipe).
pub fn extract_to(dir: &std::path::Path) -> std::io::Result<std::path::PathBuf> {
    if dir.exists() {
        std::fs::remove_dir_all(dir)?;
    }
    std::fs::create_dir_all(dir)?;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(PAYLOAD_ZIP))?;
    zip.extract(dir)?;
    Ok(dir.to_path_buf())
}

pub fn payload_dir(pkg: &std::path::Path, name: &str) -> std::path::PathBuf {
    pkg.join(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_contains_tiers_and_addons() {
        let pkg = extract().unwrap();
        for d in ["gi_tier1", "gi_tier2", "gi_tier3", "potato", "addons"] {
            assert!(pkg.join(d).is_dir(), "missing {d}");
        }
        assert!(pkg.join("gi_tier1").join("gameinfo.gi").is_file());
        assert!(pkg.join("addons").join("pak04_dir.vpk").is_file());
    }
}

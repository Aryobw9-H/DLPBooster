// %APPDATA%\DLPBooster\settings.json — lang, tester unlock, last path,
// unit-status autoexec option. Root overridable via DLPB_DATA_DIR (tests).
use std::path::PathBuf;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct Settings {
    pub lang: String,     // "fa" | "en"
    pub unlocked: bool,   // tester TEMP modes unlocked
    pub last_path: Option<String>,
    pub unit_status_new: bool, // citadel_unit_status_use_new autoexec block
}

impl Default for Settings {
    fn default() -> Self {
        Settings { lang: "fa".into(), unlocked: false, last_path: None, unit_status_new: false }
    }
}

/// Data root: %APPDATA%\DLPBooster (or $DLPB_DATA_DIR in tests).
pub fn data_dir() -> PathBuf {
    if let Ok(d) = std::env::var("DLPB_DATA_DIR") {
        return PathBuf::from(d);
    }
    #[cfg(windows)]
    {
        let base = std::env::var("APPDATA").map(PathBuf::from).unwrap_or_else(|_| {
            dirs::home_dir().unwrap_or_else(std::env::temp_dir)
        });
        base.join("DLPBooster")
    }
    #[cfg(not(windows))]
    dirs::home_dir().unwrap_or_else(std::env::temp_dir).join(".dlpbooster")
}

fn settings_path() -> PathBuf {
    data_dir().join("settings.json")
}

fn load_from(dir: &PathBuf) -> Settings {
    match std::fs::read(dir.join("settings.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

fn save_to(dir: &PathBuf, s: &Settings) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join("settings.json"), serde_json::to_string_pretty(s)?)?;
    Ok(())
}

pub fn load() -> Settings {
    load_from(&data_dir())
}

pub fn save(s: &Settings) -> std::io::Result<()> {
    save_to(&data_dir(), s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_missing_defaults() {
        let tmp = std::env::temp_dir().join("dlpb_settings_missing");
        crate::backup::rm_ro(&tmp);
        let s = load_from(&tmp);
        assert_eq!(s.lang, "fa");
        assert!(!s.unlocked);
        assert!(s.last_path.is_none());
        assert!(!s.unit_status_new);
        crate::backup::rm_ro(&tmp);
    }

    #[test]
    fn save_reload_roundtrip() {
        let tmp = std::env::temp_dir().join("dlpb_settings_rt");
        crate::backup::rm_ro(&tmp);
        let s = Settings { lang: "en".into(), unlocked: true, last_path: Some("D:\\SteamLibrary\\steamapps\\common\\Deadlock".into()), unit_status_new: true };
        save_to(&tmp, &s).unwrap();
        let s2 = load_from(&tmp);
        assert_eq!(s2.lang, "en");
        assert!(s2.unlocked);
        assert_eq!(s2.last_path.as_deref(), Some("D:\\SteamLibrary\\steamapps\\common\\Deadlock"));
        assert!(s2.unit_status_new);
        crate::backup::rm_ro(&tmp);
    }

    #[test]
    fn corrupt_file_falls_back_to_defaults() {
        let tmp = std::env::temp_dir().join("dlpb_settings_bad");
        crate::backup::rm_ro(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("settings.json"), b"{not json").unwrap();
        assert_eq!(load_from(&tmp).lang, "fa");
        crate::backup::rm_ro(&tmp);
    }
}

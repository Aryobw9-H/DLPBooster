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

pub fn load() -> Settings {
    match std::fs::read(settings_path()) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

pub fn save(s: &Settings) -> std::io::Result<()> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir)?;
    std::fs::write(settings_path(), serde_json::to_string_pretty(s)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_missing_defaults() {
        let tmp = std::env::temp_dir().join("dlpb_settings_missing");
        let _ = std::fs::remove_dir_all(&tmp);
        std::env::set_var("DLPB_DATA_DIR", &tmp);
        let s = load();
        assert_eq!(s.lang, "fa");
        assert!(!s.unlocked);
        assert!(s.last_path.is_none());
        assert!(!s.unit_status_new);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn save_reload_roundtrip() {
        let tmp = std::env::temp_dir().join("dlpb_settings_rt");
        let _ = std::fs::remove_dir_all(&tmp);
        std::env::set_var("DLPB_DATA_DIR", &tmp);
        let s = Settings { lang: "en".into(), unlocked: true, last_path: Some("D:\\SteamLibrary\\steamapps\\common\\Deadlock".into()), unit_status_new: true };
        save(&s).unwrap();
        let s2 = load();
        assert_eq!(s2.lang, "en");
        assert!(s2.unlocked);
        assert_eq!(s2.last_path.as_deref(), Some("D:\\SteamLibrary\\steamapps\\common\\Deadlock"));
        assert!(s2.unit_status_new);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn corrupt_file_falls_back_to_defaults() {
        let tmp = std::env::temp_dir().join("dlpb_settings_bad");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("settings.json"), b"{not json").unwrap();
        std::env::set_var("DLPB_DATA_DIR", &tmp);
        assert_eq!(load().lang, "fa");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

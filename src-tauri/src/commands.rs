// Tauri commands: thin IPC layer over dlp-core. Task 9.
use serde::{Deserialize, Serialize};

use dlp_core::{backup, detect, discovery, guard, install, payload, settings};

// ---------- discovery ----------
#[derive(Serialize)]
pub struct FoundDto {
    pub deadlock: String,
    pub owned: bool,
}

impl From<discovery::Found> for FoundDto {
    fn from(f: discovery::Found) -> Self {
        FoundDto { deadlock: f.deadlock, owned: f.owned }
    }
}

#[tauri::command]
pub fn find_game() -> Option<FoundDto> {
    discovery::find_game().map(Into::into)
}

#[tauri::command]
pub fn pick_game(path: String) -> Option<FoundDto> {
    discovery::validate_manual(&path).map(Into::into)
}

// ---------- detect ----------
#[tauri::command]
pub fn detect_tier_cmd(citadel: String) -> String {
    let pkg_dir = payload::extract().unwrap_or_default();
    let pkg = payload_dir_or(&pkg_dir);
    detect::detect_tier(std::path::Path::new(&citadel), &pkg).as_str().to_string()
}

fn payload_dir_or(p: &std::path::Path) -> std::path::PathBuf {
    if p.is_dir() { p.to_path_buf() } else { std::env::temp_dir().join("DLPBoosterPkg") }
}

// ---------- guard ----------
#[tauri::command]
pub fn check_running() -> Vec<String> {
    guard::game_running()
}

// ---------- install ----------
#[tauri::command]
pub fn install_mode(mode: String, fov: u32, path: String) -> Result<Vec<install::StepLog>, String> {
    let m = match mode.as_str() {
        "T1" => install::Mode::T1,
        "T2" => install::Mode::T2,
        "T3" => install::Mode::T3,
        "POTATO" => install::Mode::Potato,
        "T1MODS" => install::Mode::T1Mods,
        "T2MODS" => install::Mode::T2Mods,
        other => return Err(format!("unknown mode: {other}")),
    };
    let deadlock = resolve_path(&path)?;
    let pkg = payload::extract().map_err(|e| e.to_string())?;
    let data = settings::data_dir();
    install::install(m, fov, &deadlock, &pkg, &data)
}

fn resolve_path(path: &str) -> Result<String, String> {
    let p = if path.trim().is_empty() {
        settings::load().last_path.unwrap_or_default()
    } else {
        path.to_string()
    };
    if p.is_empty() || !std::path::Path::new(&p).join("game").join("citadel").is_dir() {
        return Err("no valid Deadlock path — locate the game first".into());
    }
    Ok(p)
}

// ---------- backup / restore ----------
#[derive(Serialize)]
pub struct BackupInfo {
    pub name: String,
}

#[tauri::command]
pub fn do_backup_cmd(path: String) -> Result<String, String> {
    let deadlock = resolve_path(&path)?;
    let cit = std::path::Path::new(&deadlock).join("game").join("citadel");
    backup::do_backup(&cit, &settings::data_dir())
}

#[tauri::command]
pub fn list_backups() -> Vec<BackupInfo> {
    backup::list_backups(&settings::data_dir())
        .into_iter()
        .map(|name| BackupInfo { name })
        .collect()
}

#[derive(Serialize)]
pub struct RestoreReportDto {
    pub restored_gi: bool,
    pub restored_video: bool,
    pub removed_addons: Vec<String>,
    pub restored_addons: usize,
}

#[tauri::command]
pub fn do_restore(name: String, path: String) -> Result<RestoreReportDto, String> {
    let deadlock = resolve_path(&path)?;
    let cit = std::path::Path::new(&deadlock).join("game").join("citadel");
    backup::restore(&cit, &settings::data_dir(), &name).map(|r| RestoreReportDto {
        restored_gi: r.restored_gi,
        restored_video: r.restored_video,
        removed_addons: r.removed_addons,
        restored_addons: r.restored_addons,
    })
}

// ---------- settings ----------
#[derive(Serialize)]
pub struct SettingsDto {
    pub lang: String,
    pub unlocked: bool,
    pub last_path: Option<String>,
    pub unit_status_new: bool,
}

impl From<settings::Settings> for SettingsDto {
    fn from(s: settings::Settings) -> Self {
        SettingsDto { lang: s.lang, unlocked: s.unlocked, last_path: s.last_path, unit_status_new: s.unit_status_new }
    }
}

#[derive(Deserialize)]
pub struct SettingsPatch {
    pub lang: Option<String>,
    pub unlock_code: Option<String>,
    pub last_path: Option<String>,
    pub unit_status_new: Option<bool>,
}

/// Tester unlock code. Placeholder until Aryo supplies the real code.
const DLPB_TESTER_CODE: &str = "DLP-2026";

#[tauri::command]
pub fn get_settings() -> SettingsDto {
    settings::load().into()
}

#[tauri::command]
pub fn set_settings(patch: SettingsPatch) -> Result<SettingsDto, String> {
    let mut s = settings::load();
    if let Some(lang) = patch.lang {
        if lang != "fa" && lang != "en" {
            return Err("lang must be fa or en".into());
        }
        s.lang = lang;
    }
    if let Some(code) = patch.unlock_code {
        if code.trim() != DLPB_TESTER_CODE {
            return Err("invalid unlock code".into());
        }
        s.unlocked = true;
    }
    if let Some(p) = patch.last_path {
        s.last_path = if p.trim().is_empty() { None } else { Some(p) };
    }
    if let Some(u) = patch.unit_status_new {
        s.unit_status_new = u;
    }
    settings::save(&s).map_err(|e| e.to_string())?;
    Ok(s.into())
}

// ---------- misc ----------
#[tauri::command]
pub fn launch_game() -> Result<(), String> {
    open::that("steam://rungameid/1422450").map_err(|e| e.to_string())
}

/// Guard: refuse to run if we're executing from the extracted temp package.
#[tauri::command]
pub fn running_from_pkg() -> bool {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            return parent.starts_with(std::env::temp_dir().join("DLPBoosterPkg"));
        }
    }
    false
}

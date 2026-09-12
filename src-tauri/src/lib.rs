// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Updater: silent-tolerant on 404 (no release yet) — default endpoints
        // errors are non-fatal and surface only when a check is requested.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::find_game,
            commands::pick_game,
            commands::detect_tier_cmd,
            commands::check_running,
            commands::install_mode,
            commands::do_backup_cmd,
            commands::list_backups,
            commands::do_restore,
            commands::get_settings,
            commands::set_settings,
            commands::launch_game,
            commands::running_from_pkg,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

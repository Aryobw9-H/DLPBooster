// Port of guard_game.ps1: abort if Deadlock-related process is running (it
// would overwrite our files on exit). DLPB_NOGUARD=1 bypasses (sandbox tests —
// same idea as console DDBOOST_NOGUARD).
pub const GUARD_NAMES: [&str; 3] = ["project8", "deadlock", "deadlock-mod-manager"];

/// Returns lowercase names of running Deadlock-related processes. Empty = safe.
pub fn game_running() -> Vec<String> {
    if std::env::var("DLPB_NOGUARD").as_deref() == Ok("1") {
        return vec![];
    }
    use sysinfo::System;
    let mut sys = System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let mut found = Vec::new();
    for (pid, proc_) in sys.processes() {
        let name = proc_.name().to_string_lossy().to_lowercase();
        let _ = pid;
        if GUARD_NAMES.contains(&name.as_str()) && !found.contains(&name) {
            found.push(name);
        }
    }
    found
}

#[cfg(test)]
mod tests {
    #[test]
    fn env_bypass_returns_empty() {
        std::env::set_var("DLPB_NOGUARD", "1");
        assert!(super::game_running().is_empty());
        std::env::remove_var("DLPB_NOGUARD");
    }
}

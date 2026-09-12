// Port of merge_video.ps1 + set_fov.ps1.
// merge_video: user's identity values (first occurrence wins) override template
// lines; all other lines byte-identical to template.
// set_fov: replace "r_aspectratio" "<num>" line, 6 tabs indent, no BOM.
pub const IDENTITY_KEYS: [&str; 7] = [
    "Version",
    "VendorID",
    "DeviceID",
    "setting.defaultres",
    "setting.defaultresheight",
    "setting.recommendedheight",
    "setting.refreshrate_numerator",
];

/// Strip UTF-8 BOM (detect.ps1 parity).
pub fn strip_bom(text: &str) -> &str {
    text.strip_prefix('\u{FEFF}').unwrap_or(text)
}

/// Parse one `"key" "value"` pair (PS1 regex: ^\s*"([^"]+)"\s+"([^"]*)").
/// Returns (key, value).
pub fn parse_kv(line: &str) -> Option<(&str, &str)> {
    let t = line.trim_start();
    if !t.starts_with('"') {
        return None;
    }
    let rest = &t[1..];
    let close = rest.find('"')?;
    let k = &rest[..close];
    let after_key = rest[close + 1..].trim_start();
    let v = after_key.strip_prefix('"')?;
    let vclose = v.find('"')?;
    Some((k, &v[..vclose]))
}

/// Parse a template line into (key, prefix end = value's opening quote index,
/// trailing start = index after value's closing quote).
/// Mirrors PS1 regex ^(\s*"([^"]+)"\s+)"([^"]*)"(.*)$.
fn parse_line(ln: &str) -> Option<(&str, usize, usize)> {
    let t = ln.trim_start();
    if !t.starts_with('"') {
        return None;
    }
    let rest = &t[1..];
    let close = rest.find('"')?;
    let k = &rest[..close];
    let after_key = &rest[close + 1..];
    let gap = after_key.len() - after_key.trim_start().len();
    if after_key[gap..].starts_with('"') {
        let prefix_end = ln.len() - after_key.len() + gap; // index of value's opening quote
        let v = &after_key[gap + 1..];
        let vclose = v.find('"')?;
        let trailing_start = ln.len() - v.len() + vclose + 1;
        return Some((k, prefix_end, trailing_start));
    }
    None
}

/// merge_video.ps1: identity keys take user values, everything else template.
pub fn merge_video(user: &str, template: &str) -> String {
    let mut uvals: Vec<(&str, &str)> = Vec::new();
    for ln in strip_bom(user).lines() {
        if let Some((k, v)) = parse_kv(ln) {
            if !uvals.iter().any(|(ek, _)| ek == k) {
                uvals.push((k, v));
            }
        }
    }
    let mut out = String::with_capacity(template.len() + 64);
    for ln in template.lines() {
        let mut replaced = false;
        if let Some((k, prefix_end, trailing_start)) = parse_line(ln) {
            if IDENTITY_KEYS.contains(&k) {
                if let Some((_, uv)) = uvals.iter().find(|(uk, _)| *uk == k) {
                    out.push_str(&ln[..prefix_end]);
                    out.push('"');
                    out.push_str(uv);
                    out.push('"');
                    out.push_str(&ln[trailing_start..]);
                    out.push('\n');
                    replaced = true;
                }
            }
        }
        if !replaced {
            out.push_str(ln);
            out.push('\n');
        }
    }
    out
}

/// set_fov.ps1: replace the r_aspectratio value; 6 tabs indent, no BOM.
pub fn set_fov(gi_content: &str, ar: &str) -> String {
    let mut out = String::with_capacity(gi_content.len());
    let mut replaced = false;
    for line in strip_bom(gi_content).split_inclusive('\n') {
        let t = line.trim_start();
        if !replaced && t.starts_with("\"r_aspectratio\"") {
            let indent = &line[..line.len() - t.len()];
            out.push_str(indent);
            out.push_str("\"r_aspectratio\"\t\t\t\t\t\t\"");
            out.push_str(ar);
            out.push('"');
            if line.ends_with('\n') {
                out.push('\n');
            }
            replaced = true;
        } else {
            out.push_str(line);
        }
    }
    out
}

/// Managed autoexec block. File = user's own content untouched, plus one marked
/// block we own. enabled=false removes the block; user content always preserved.
pub fn upsert_autoexec(existing: &str, enabled: bool) -> String {
    const BEGIN: &str = "// DLP BEGIN";
    const END: &str = "// DLP END";
    let text = strip_bom(existing);
    let mut user_lines: Vec<&str> = Vec::new();
    let mut in_block = false;
    for line in text.lines() {
        if line.trim() == BEGIN {
            in_block = true;
            continue;
        }
        if line.trim() == END {
            in_block = false;
            continue;
        }
        if !in_block {
            user_lines.push(line);
        }
    }
    if !enabled {
        let mut s = user_lines.join("\n");
        if !s.is_empty() && (text.ends_with('\n') || s.contains('\n')) {
            s.push('\n');
        }
        return s;
    }
    let mut s = String::new();
    for line in &user_lines {
        s.push_str(line);
        s.push('\n');
    }
    s.push_str(BEGIN);
    s.push('\n');
    s.push_str("\tcitadel_unit_status_use_new \"true\"\n");
    s.push_str(END);
    s.push('\n');
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    const TPL: &str = "\"Version\" \"13\"\n\"VendorID\" \"0\"\n\"DeviceID\" \"0\"\n\"setting.defaultres\" \"1920\"\n\"setting.defaultresheight\" \"1080\"\n\"setting.refreshrate_numerator\" \"240\"\n\"setting.mat_queue_mode\" \"2\"\n";

    #[test]
    fn merge_overrides_identity_keeps_rest() {
        let user = "\"Version\" \"11\"\n\"junk\" \"x\"\n\"setting.defaultres\" \"2560\"\n\"setting.defaultresheight\" \"1440\"\n\"setting.refreshrate_numerator\" \"165\"\n";
        let merged = merge_video(user, TPL);
        assert!(merged.contains("\"Version\" \"11\""));
        assert!(merged.contains("\"setting.defaultres\" \"2560\""));
        assert!(merged.contains("\"setting.defaultresheight\" \"1440\""));
        assert!(merged.contains("\"setting.refreshrate_numerator\" \"165\""));
        assert!(merged.contains("\"setting.mat_queue_mode\" \"2\"\n"));
        assert!(merged.contains("\"VendorID\" \"0\"\n")); // template default kept
        assert!(!merged.contains("junk")); // template is source of shape
    }

    #[test]
    fn merge_missing_user_values_keep_template() {
        assert_eq!(merge_video("", TPL), TPL);
    }

    #[test]
    fn merge_first_occurrence_wins() {
        let user = "\"Version\" \"1\"\n\"Version\" \"2\"\n";
        assert!(merge_video(user, TPL).contains("\"Version\" \"1\""));
    }

    #[test]
    fn merge_preserves_trailing_comment() {
        let tpl = "\"setting.defaultres\" \"1920\" // width\n";
        let out = merge_video("\"setting.defaultres\" \"2560\"", tpl);
        assert_eq!(out, "\"setting.defaultres\" \"2560\" // width\n");
    }

    #[test]
    fn set_fov_swaps_value_six_tabs() {
        let gi = "\t\t\"r_aspectratio\"\t\t\t\t\t\t\"2.15\"\nother\n";
        let out = set_fov(gi, "3.09");
        assert!(out.contains("\t\t\"r_aspectratio\"\t\t\t\t\t\t\"3.09\"\n"));
        assert!(out.contains("other\n"));
        assert!(!out.contains("2.15"));
    }

    #[test]
    fn set_fov_bom_stripped() {
        let gi = "\u{FEFF}\"r_aspectratio\" \"2.15\"\n";
        let out = set_fov(gi, "1.60");
        assert!(!out.starts_with('\u{FEFF}'));
        assert!(out.contains("\"1.60\""));
    }

    #[test]
    fn set_fov_no_match_untouched() {
        let gi = "nothing here\n";
        assert_eq!(set_fov(gi, "2.15"), gi);
    }

    #[test]
    fn autoexec_upsert_empty() {
        let out = upsert_autoexec("", true);
        assert!(out.contains("// DLP BEGIN\n\tcitadel_unit_status_use_new \"true\"\n// DLP END\n"));
        assert_eq!(out.lines().count(), 3);
    }

    #[test]
    fn autoexec_replace_no_duplicate() {
        let existing = "fps_max 0\n// DLP BEGIN\n\tcitadel_unit_status_use_new \"true\"\n// DLP END\n";
        let out = upsert_autoexec(existing, true);
        assert_eq!(out.matches("// DLP BEGIN").count(), 1);
        assert!(out.starts_with("fps_max 0\n"));
    }

    #[test]
    fn autoexec_disable_removes_block_only() {
        let existing = "my_cvar 1\n// DLP BEGIN\n\tcitadel_unit_status_use_new \"true\"\n// DLP END\nafter_cvar 2\n";
        let out = upsert_autoexec(existing, false);
        assert!(!out.contains("DLP"));
        assert!(out.contains("my_cvar 1\n"));
        assert!(out.contains("after_cvar 2"));
    }

    #[test]
    fn autoexec_user_content_untouched() {
        let existing = "// my own tweaks\nr_thing \"3\"\n";
        let out = upsert_autoexec(existing, true);
        assert!(out.starts_with("// my own tweaks\nr_thing \"3\"\n"));
        assert!(out.contains("// DLP BEGIN"));
        assert_eq!(upsert_autoexec(existing, false), existing);
    }
}

// Port of install.bat FOV block: slider value snaps to nearest 5 in 70..=120,
// number maps to Sqooky aspect-ratio anchor.
pub fn snap(input: f64) -> u32 {
    let v = ((input + 2.0) / 5.0).floor() * 5.0;
    v.clamp(70.0, 120.0) as u32
}

pub fn aspect_ratio(fov: u32) -> &'static str {
    match fov {
        70 => "1.60",
        75 => "1.70",
        80 => "1.75",
        85 => "1.95",
        90 => "2.15",
        95 => "2.32",
        100 => "2.49",
        105 => "2.64",
        110 => "2.79",
        115 => "2.94",
        120 => "3.09",
        _ => "2.15",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snap_cases() {
        assert_eq!(snap(77.0), 75);
        assert_eq!(snap(86.0), 85);
        assert_eq!(snap(119.0), 120);
        assert_eq!(snap(69.0), 70);
        assert_eq!(snap(999.0), 120);
        assert_eq!(snap(90.0), 90);
        assert_eq!(snap(92.4), 90);
        assert_eq!(snap(93.0), 95);
    }

    #[test]
    fn aspect_ratio_table() {
        assert_eq!(aspect_ratio(70), "1.60");
        assert_eq!(aspect_ratio(75), "1.70");
        assert_eq!(aspect_ratio(80), "1.75");
        assert_eq!(aspect_ratio(85), "1.95");
        assert_eq!(aspect_ratio(90), "2.15");
        assert_eq!(aspect_ratio(95), "2.32");
        assert_eq!(aspect_ratio(100), "2.49");
        assert_eq!(aspect_ratio(105), "2.64");
        assert_eq!(aspect_ratio(110), "2.79");
        assert_eq!(aspect_ratio(115), "2.94");
        assert_eq!(aspect_ratio(120), "3.09");
        assert_eq!(aspect_ratio(0), "2.15");
        assert_eq!(aspect_ratio(91), "2.15");
    }
}

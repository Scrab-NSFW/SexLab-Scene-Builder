//! Animation event / HKX naming transforms between SexLab (`_A#_S#`) and OStim (`_N`).

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use log::warn;

/// Strip trailing `_A{n}_S{m}` from a SexLab-style event id.
pub fn strip_actor_stage_suffix(event: &str) -> Option<String> {
    let bytes = event.as_bytes();
    let mut i = bytes.len();
    let mut saw_s = false;
    while i > 0 && bytes[i - 1].is_ascii_digit() {
        i -= 1;
        saw_s = true;
    }
    if !saw_s || i < 2 || bytes[i - 1] != b'S' || bytes[i - 2] != b'_' {
        return None;
    }
    i -= 2;
    let mut saw_a = false;
    while i > 0 && bytes[i - 1].is_ascii_digit() {
        i -= 1;
        saw_a = true;
    }
    if !saw_a || i < 2 || bytes[i - 1] != b'A' || bytes[i - 2] != b'_' {
        return None;
    }
    i -= 2;
    if i == 0 {
        return None;
    }
    Some(event[..i].to_string())
}

/// Strip trailing `_{actor}` from an OStim-style event id (`Anim_0`).
pub fn strip_ostim_actor_suffix(event: &str) -> Option<(String, usize)> {
    let bytes = event.as_bytes();
    let mut i = bytes.len();
    let mut saw = false;
    while i > 0 && bytes[i - 1].is_ascii_digit() {
        i -= 1;
        saw = true;
    }
    if !saw || i < 2 || bytes[i - 1] != b'_' {
        return None;
    }
    let actor: usize = event[i..].parse().ok()?;
    let base = &event[..i - 1];
    if base.is_empty() {
        return None;
    }
    Some((base.to_string(), actor))
}

/// Animation base from either SexLab `_A#_S#` or OStim `_{actor}` event ids.
pub fn animation_base_from_event(event: &str) -> Option<String> {
    if let Some(base) = strip_actor_stage_suffix(event) {
        return Some(base);
    }
    strip_ostim_actor_suffix(event).map(|(b, _)| b)
}

/// Build SexLab event id from OStim animation base + actor/stage (1-based).
#[cfg(test)]
pub fn ostim_to_slsb_event(animation: &str, actor_1based: usize, stage_1based: usize) -> String {
    format!("{animation}_A{actor_1based}_S{stage_1based}")
}

/// OStim graph event for actor index (0-based): `{animation}_{actor}`.
pub fn ostim_actor_event(animation: &str, actor_0based: usize) -> String {
    format!("{animation}_{actor_0based}")
}

/// Prefer a shared animation prefix across events; fall back to `fallback`.
pub fn derive_anim_base(events: impl IntoIterator<Item = impl AsRef<str>>, fallback: &str) -> String {
    let mut derived: Option<String> = None;
    for event in events {
        let event = event.as_ref();
        if event.is_empty() {
            continue;
        }
        let Some(id) = animation_base_from_event(event) else {
            return fallback.to_string();
        };
        match &derived {
            None => derived = Some(id),
            Some(existing) if existing == &id => {}
            Some(_) => return fallback.to_string(),
        }
    }
    derived
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

/// Sanitize a string into a safe OStim scene / animation / pack folder id.
pub fn sanitize_ostim_id(raw: &str, fallback: &str) -> String {
    let cleaned: String = raw
        .trim()
        .trim_start_matches('$')
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else if c.is_whitespace() {
                '_'
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string();
    let collapsed = cleaned
        .split('_')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("_");
    if collapsed.is_empty() {
        fallback.to_string()
    } else if collapsed.to_ascii_lowercase().starts_with("ostim") {
        format!("SLSB_{collapsed}")
    } else {
        collapsed
    }
}

/// Relative HKX path used in OStim animlists:
/// `..\Pack\AnimFolder\Anim_0.hkx`
pub fn ostim_hkx_rel_path(pack_folder: &str, anim_folder: &str, animation: &str, actor: usize) -> String {
    format!(r"..\{pack_folder}\{anim_folder}\{animation}_{actor}.hkx")
}

/// SexLab-style clip filename stem for actor/stage (1-based).
pub fn slsb_hkx_stem(base: &str, actor_1based: usize, stage_1based: usize) -> String {
    format!("{base}_A{actor_1based}_S{stage_1based}")
}

/// Copy OStim clips into `dest_dir`, preferring native `{event}.hkx` names.
///
/// Falls back to renaming `{animation}_{actor}.hkx` → `_A#_S#` when events use
/// SexLab suffixes (legacy / mixed packs).
pub fn copy_ostim_hkx_for_events(
    source_root: &Path,
    dest_dir: &Path,
    events: impl IntoIterator<Item = impl AsRef<str>>,
) -> Result<(usize, usize), String> {
    std::fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    let mut copied = 0usize;
    let mut missing = 0usize;
    let mut seen = HashSet::new();
    for event in events {
        let event = event.as_ref();
        if event.is_empty() || !seen.insert(event.to_string()) {
            continue;
        }
        let native = format!("{event}.hkx");
        if let Some(src) = find_file_named(source_root, &native)? {
            let dest = dest_dir.join(&native);
            std::fs::copy(&src, &dest).map_err(|e| e.to_string())?;
            copied += 1;
            continue;
        }
        if let Some(base) = strip_actor_stage_suffix(event) {
            // Event is SexLab-shaped; try OStim source `{base}_{actor-1}.hkx`.
            if let Some((_, a_s)) = event.rsplit_once("_A") {
                if let Some((a_str, s_str)) = a_s.split_once("_S") {
                    if let (Ok(actor_1), Ok(_stage_1)) =
                        (a_str.parse::<usize>(), s_str.parse::<usize>())
                    {
                        let file_name = format!("{base}_{}.hkx", actor_1.saturating_sub(1));
                        if let Some(src) = find_file_named(source_root, &file_name)? {
                            let dest = dest_dir.join(&native);
                            std::fs::copy(&src, &dest).map_err(|e| e.to_string())?;
                            copied += 1;
                            continue;
                        }
                    }
                }
            }
        }
        missing += 1;
        warn!(
            "OStim HKX not found for event '{event}' under {}",
            source_root.display()
        );
    }
    Ok((copied, missing))
}

/// Copy/rename SexLab `_A#_S#` clips into OStim `{animation}_{actor}.hkx` layout.
/// Also accepts source files already named `{animation}_{actor}.hkx`.
pub fn copy_slsb_hkx_to_ostim(
    source_root: &Path,
    dest: &Path,
    base: &str,
    animation: &str,
    stage_1based: usize,
    actor_count: usize,
) -> Result<usize, String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let mut copied = 0;
    for actor in 0..actor_count {
        let out = dest.join(format!("{animation}_{actor}.hkx"));
        let candidates = [
            format!("{}.hkx", slsb_hkx_stem(base, actor + 1, stage_1based)),
            format!("{animation}_{actor}.hkx"),
            format!("{base}_{actor}.hkx"),
        ];
        let mut found = None;
        for file_name in &candidates {
            if let Some(src) = find_file_named(source_root, file_name)? {
                found = Some(src);
                break;
            }
        }
        let Some(src) = found else {
            continue;
        };
        if out.exists() {
            continue;
        }
        std::fs::copy(&src, &out).map_err(|e| e.to_string())?;
        copied += 1;
    }
    Ok(copied)
}

pub fn find_file_named(root: &Path, file_name: &str) -> Result<Option<PathBuf>, String> {
    if !root.exists() {
        return Ok(None);
    }
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path
                .file_name()
                .and_then(|s| s.to_str())
                .map(|s| s.eq_ignore_ascii_case(file_name))
                .unwrap_or(false)
            {
                return Ok(Some(path));
            }
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_and_builds_events() {
        assert_eq!(
            strip_actor_stage_suffix("MLCBedCowgirl_A1_S2").as_deref(),
            Some("MLCBedCowgirl")
        );
        assert_eq!(
            ostim_to_slsb_event("MLCBedCowgirl", 1, 2),
            "MLCBedCowgirl_A1_S2"
        );
        assert_eq!(ostim_actor_event("MLCBedCowgirl", 0), "MLCBedCowgirl_0");
        assert_eq!(
            strip_ostim_actor_suffix("MLCBedCowgirl_0"),
            Some(("MLCBedCowgirl".into(), 0))
        );
        assert_eq!(
            animation_base_from_event("MLCBedCowgirl_0").as_deref(),
            Some("MLCBedCowgirl")
        );
        assert_eq!(
            animation_base_from_event("MLCBedCowgirl_A1_S1").as_deref(),
            Some("MLCBedCowgirl")
        );
    }

    #[test]
    fn sanitizes_reserved_prefix() {
        assert!(sanitize_ostim_id("OStimFoo", "x").starts_with("SLSB_"));
        assert_eq!(sanitize_ostim_id("MLC Bed", "x"), "MLC_Bed");
    }
}

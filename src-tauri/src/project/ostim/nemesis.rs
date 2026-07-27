//! OStim animlist writing and merging.
//!
//! Behavior patches are not generated here; imported OStim packs ship their own
//! Nemesis patches, which export copies verbatim from the pack source.

use std::fs;
use std::io::Write;
use std::path::Path;

use crate::project::ostim::events::{ostim_actor_event, ostim_hkx_rel_path};

#[derive(Debug, Clone)]
pub struct OstimAnimEntry {
    pub animation: String,
    /// Folder under `meshes/actors/character/animations/<pack>/`
    pub folder: String,
    pub actor_count: usize,
    /// Transition / one-shot clips use `-a,Tn`
    pub oneshot: bool,
}

pub fn write_ostim_animlist(
    pack_root: &Path,
    pack_folder: &str,
    entries: &[OstimAnimEntry],
) -> Result<std::path::PathBuf, String> {
    let anim_root = pack_root
        .join("meshes")
        .join("actors")
        .join("character")
        .join("animations")
        .join(pack_folder);
    fs::create_dir_all(&anim_root).map_err(|e| e.to_string())?;

    let list_name = format!("ATT_{pack_folder}_animlist.txt");
    let list_path = anim_root.join(&list_name);
    let mut file = fs::File::create(&list_path).map_err(|e| e.to_string())?;

    writeln!(
        file,
        "' SLSB-generated OStim animlist for {pack_folder}"
    )
    .map_err(|e| e.to_string())?;
    writeln!(file, "' Run Nemesis (or compatible) to register these events.").map_err(|e| e.to_string())?;
    writeln!(file).map_err(|e| e.to_string())?;

    let mut seen = std::collections::HashSet::new();
    for entry in entries {
        for actor in 0..entry.actor_count {
            let event = ostim_actor_event(&entry.animation, actor);
            if !seen.insert(event.clone()) {
                continue;
            }
            let rel = ostim_hkx_rel_path(pack_folder, &entry.folder, &entry.animation, actor);
            let flags = if entry.oneshot { "-a,Tn" } else { "-Tn" };
            writeln!(file, "b {flags} {event} {rel}").map_err(|e| e.to_string())?;
        }
    }
    Ok(list_path)
}

/// Append only new animlist event lines; keep existing hand-edits / prior exports.
/// Creates a full list when the file is missing.
pub fn merge_ostim_animlist(
    pack_root: &Path,
    pack_folder: &str,
    entries: &[OstimAnimEntry],
) -> Result<(std::path::PathBuf, usize), String> {
    let anim_root = pack_root
        .join("meshes")
        .join("actors")
        .join("character")
        .join("animations")
        .join(pack_folder);
    fs::create_dir_all(&anim_root).map_err(|e| e.to_string())?;

    let list_name = format!("ATT_{pack_folder}_animlist.txt");
    let list_path = anim_root.join(&list_name);

    let mut existing_body = String::new();
    let mut seen_events = std::collections::HashSet::new();
    if list_path.is_file() {
        let text = fs::read_to_string(&list_path).map_err(|e| e.to_string())?;
        for line in text.lines() {
            let trimmed = line.trim();
            if let Some(event) = animlist_event_name(trimmed) {
                seen_events.insert(event);
            }
            existing_body.push_str(line);
            existing_body.push('\n');
        }
    } else {
        existing_body.push_str(&format!(
            "' SLSB-generated OStim animlist for {pack_folder}\n\
             ' Run Nemesis (or compatible) to register these events.\n\n"
        ));
    }

    let mut appended = 0usize;
    let mut additions = String::new();
    for entry in entries {
        for actor in 0..entry.actor_count {
            let event = ostim_actor_event(&entry.animation, actor);
            if !seen_events.insert(event.clone()) {
                continue;
            }
            let rel = ostim_hkx_rel_path(pack_folder, &entry.folder, &entry.animation, actor);
            let flags = if entry.oneshot { "-a,Tn" } else { "-Tn" };
            additions.push_str(&format!("b {flags} {event} {rel}\n"));
            appended += 1;
        }
    }

    if appended > 0 || !list_path.is_file() {
        let mut out = existing_body;
        if !additions.is_empty() {
            if !out.ends_with('\n') && !out.is_empty() {
                out.push('\n');
            }
            out.push_str(&additions);
        }
        fs::write(&list_path, out).map_err(|e| e.to_string())?;
    }
    Ok((list_path, appended))
}

fn animlist_event_name(line: &str) -> Option<String> {
    // `b -Tn EventName ..\Pack\...` or `b -a,Tn EventName ...`
    let mut parts = line.split_whitespace();
    if parts.next()? != "b" {
        return None;
    }
    let flags_or_event = parts.next()?;
    let event = if flags_or_event.starts_with('-') {
        parts.next()?.to_string()
    } else {
        flags_or_event.to_string()
    };
    if event.is_empty() {
        None
    } else {
        Some(event)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn writes_animlist() {
        let tmp = std::env::temp_dir().join(format!("slsb_ostim_nem_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let entries = vec![OstimAnimEntry {
            animation: "TestAnim".into(),
            folder: "TestAnim".into(),
            actor_count: 2,
            oneshot: false,
        }];
        let list = write_ostim_animlist(&tmp, "TestPack", &entries).unwrap();
        assert!(list.exists());
        let body = fs::read_to_string(&list).unwrap();
        assert!(body.contains("b -Tn TestAnim_0"));
        assert!(body.contains("TestAnim_1"));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn merge_appends_only_new_events() {
        let tmp = std::env::temp_dir().join(format!("slsb_ostim_merge_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let entries = vec![OstimAnimEntry {
            animation: "TestAnim".into(),
            folder: "TestAnim".into(),
            actor_count: 2,
            oneshot: false,
        }];
        let (list, added) = merge_ostim_animlist(&tmp, "TestPack", &entries).unwrap();
        assert_eq!(added, 2);

        // Re-merging the same entries adds nothing and keeps the body intact.
        let before = fs::read_to_string(&list).unwrap();
        let (_, added) = merge_ostim_animlist(&tmp, "TestPack", &entries).unwrap();
        assert_eq!(added, 0);
        assert_eq!(fs::read_to_string(&list).unwrap(), before);

        let more = vec![OstimAnimEntry {
            animation: "OtherAnim".into(),
            folder: "OtherAnim".into(),
            actor_count: 1,
            oneshot: true,
        }];
        let (_, added) = merge_ostim_animlist(&tmp, "TestPack", &more).unwrap();
        assert_eq!(added, 1);
        let body = fs::read_to_string(&list).unwrap();
        assert!(body.contains("b -Tn TestAnim_0"));
        assert!(body.contains("b -a,Tn OtherAnim_0"));
        let _ = fs::remove_dir_all(&tmp);
    }
}

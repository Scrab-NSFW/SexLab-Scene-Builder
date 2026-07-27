//! Write a complete OStim pack tree from an SLSB `Package`.

use std::collections::HashSet;
use std::fs;
use std::io::BufWriter;
use std::path::{Path, PathBuf};

use log::info;

use crate::project::ostim::convert::{
    animations_from_ostim_json, scene_to_ostim_files, stage_ostim_folder,
};
use crate::project::ostim::events::{
    copy_slsb_hkx_to_ostim, sanitize_ostim_id, strip_actor_stage_suffix,
};
use crate::project::ostim::nemesis::{merge_ostim_animlist, write_ostim_animlist, OstimAnimEntry};
use crate::project::package::Package;
use crate::project::progress::JobProgress;
use crate::project::scene::Scene;
use crate::project::NanoID;

#[derive(Debug, Default)]
pub struct OstimExportSummary {
    pub scenes_written: usize,
    pub json_files: usize,
    /// Scene JSON files left unchanged (content already matched on disk).
    pub json_skipped: usize,
    pub hkx_copied: usize,
    pub animlist: Option<PathBuf>,
    pub animlist_lines_added: usize,
    pub nemesis_dir: Option<PathBuf>,
    pub facial_copied: bool,
    pub nemesis_from_source: bool,
    pub assets_written: usize,
    pub sound_copied: bool,
    /// True when the destination pack already had scene JSON (merge path).
    pub incremental: bool,
}

pub fn pack_folder_name(pack: &Package) -> String {
    sanitize_ostim_id(&pack.fnis_mod_name(), &pack.prefix_hash.0)
}

fn scene_export_folder(scene: &Scene, fallback_id: &str) -> String {
    scene
        .tags
        .iter()
        .find_map(|t| t.strip_prefix("ostim_folder:"))
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| fallback_id.to_string())
}

fn stage_export_folder(scene: &Scene, scene_id: &str, group_fallback: &str) -> String {
    if let Some(stage) = scene.stages.iter().find(|s| {
        s.tags
            .iter()
            .any(|t| t == &format!("ostim_id:{scene_id}"))
    }) {
        if let Some(folder) = stage_ostim_folder(stage) {
            return folder;
        }
    }
    scene_export_folder(scene, group_fallback)
}

fn resolve_ostim_pack_root(pack: &Package, root_dir: &Path) -> (String, PathBuf) {
    let pack_folder = pack_folder_name(pack);
    let pack_root = if root_dir
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s == pack_folder)
        .unwrap_or(false)
    {
        root_dir.to_path_buf()
    } else {
        root_dir.join(&pack_folder)
    };
    (pack_folder, pack_root)
}

fn ostim_scenes_root(pack_root: &Path) -> PathBuf {
    pack_root
        .join("SKSE")
        .join("Plugins")
        .join("OStim")
        .join("scenes")
}

fn modpack_name(pack: &Package, pack_folder: &str) -> String {
    if pack.pack_name.trim().is_empty() {
        pack_folder.to_string()
    } else {
        pack.pack_name.clone()
    }
}

/// Write OStim scene JSON for selected SLSB scenes only (no animlist / Nemesis / HKX).
pub fn write_ostim_json_subset(
    pack: &Package,
    root_dir: &Path,
    scene_ids: &[NanoID],
    progress: Option<&JobProgress<'_>>,
) -> Result<OstimExportSummary, String> {
    let (pack_folder, pack_root) = resolve_ostim_pack_root(pack, root_dir);
    let scenes_root = ostim_scenes_root(&pack_root);
    fs::create_dir_all(&scenes_root).map_err(|e| e.to_string())?;
    let modpack = modpack_name(pack, &pack_folder);

    let mut summary = OstimExportSummary {
        incremental: pack_has_existing_scenes(&scenes_root),
        ..Default::default()
    };
    let id_set: HashSet<&str> = scene_ids.iter().map(|id| id.0.as_str()).collect();
    let scene_list: Vec<_> = pack
        .scenes
        .values()
        .filter(|s| id_set.contains(s.id.0.as_str()))
        .filter(|s| !s.has_warnings && !s.stages.is_empty())
        .collect();
    let total_scenes = scene_list.len() as u64;
    if let Some(p) = progress {
        p.update(
            "Writing OStim scene JSON…",
            Some(0),
            Some(total_scenes.max(1)),
        );
    }

    for (si, scene) in scene_list.into_iter().enumerate() {
        if let Some(p) = progress {
            p.update(
                &format!(
                    "Writing OStim JSON… ({}/{})",
                    si + 1,
                    total_scenes.max(1)
                ),
                Some((si + 1) as u64),
                Some(total_scenes.max(1)),
            );
        }
        let _ = write_scene_ostim_json(scene, &modpack, &scenes_root, &mut summary)?;
    }

    if summary.json_files == 0 && summary.json_skipped == 0 {
        return Err(
            "No scene JSON to export (scene missing, has warnings, or empty stages)".into(),
        );
    }
    Ok(summary)
}

fn pack_has_existing_scenes(scenes_root: &Path) -> bool {
    if !scenes_root.is_dir() {
        return false;
    }
    let Ok(entries) = fs::read_dir(scenes_root) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Ok(inner) = fs::read_dir(&path) {
                if inner.flatten().any(|e| {
                    e.path()
                        .extension()
                        .and_then(|x| x.to_str())
                        .map(|x| x.eq_ignore_ascii_case("json"))
                        .unwrap_or(false)
                }) {
                    return true;
                }
            }
        } else if path
            .extension()
            .and_then(|x| x.to_str())
            .map(|x| x.eq_ignore_ascii_case("json"))
            .unwrap_or(false)
        {
            return true;
        }
    }
    false
}

fn nemesis_already_present(pack_root: &Path) -> bool {
    pack_root.join("Nemesis_Engine").join("mod").is_dir()
}

/// Write pretty JSON only when missing or content differs. Returns true if written.
fn write_ostim_json_if_changed(
    path: &Path,
    json: &serde_json::Value,
) -> Result<bool, String> {
    if path.is_file() {
        if let Ok(bytes) = fs::read(path) {
            if let Ok(existing) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                if existing == *json {
                    return Ok(false);
                }
            }
        }
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let file = fs::File::create(path).map_err(|e| e.to_string())?;
    serde_json::to_writer_pretty(BufWriter::new(file), json).map_err(|e| e.to_string())?;
    Ok(true)
}

struct SceneJsonOut {
    json: serde_json::Value,
    changed: bool,
}

fn write_scene_ostim_json(
    scene: &Scene,
    modpack: &str,
    scenes_root: &Path,
    summary: &mut OstimExportSummary,
) -> Result<Vec<SceneJsonOut>, String> {
    let files = scene_to_ostim_files(scene, modpack)?;
    if files.is_empty() {
        return Ok(Vec::new());
    }

    let group_fallback = files
        .first()
        .map(|(id, _)| id.clone())
        .unwrap_or_else(|| "Scene".into());

    let mut out = Vec::new();
    let mut any_written = false;
    for (scene_id, json) in files {
        let folder_name = stage_export_folder(scene, &scene_id, &group_fallback);
        let folder = scenes_root.join(&folder_name);
        let out_path = folder.join(format!("{scene_id}.json"));
        let changed = write_ostim_json_if_changed(&out_path, &json)?;
        if changed {
            summary.json_files += 1;
            any_written = true;
        } else {
            summary.json_skipped += 1;
        }
        out.push(SceneJsonOut { json, changed });
    }
    if any_written {
        summary.scenes_written += 1;
    }
    Ok(out)
}

/// Export OStim scenes + animlist + Nemesis under `root_dir/{Pack}/` or `root_dir`.
///
/// First export into an empty pack is a full write (JSON, HKX, animlist, pack extras).
/// Re-export into an existing pack is incremental: only rewrite changed scene JSON,
/// copy missing HKX, and merge new animlist lines — pack extras are left untouched.
pub fn write_ostim_pack(
    pack: &Package,
    root_dir: &Path,
    hkx_source: Option<&Path>,
    progress: Option<&JobProgress<'_>>,
) -> Result<OstimExportSummary, String> {
    let (pack_folder, pack_root) = resolve_ostim_pack_root(pack, root_dir);

    let scenes_root = ostim_scenes_root(&pack_root);
    fs::create_dir_all(&scenes_root).map_err(|e| e.to_string())?;
    let incremental = pack_has_existing_scenes(&scenes_root);

    let modpack = modpack_name(pack, &pack_folder);

    let mut summary = OstimExportSummary {
        incremental,
        ..Default::default()
    };
    let mut anim_entries: Vec<OstimAnimEntry> = Vec::new();
    let mut seen_anim = HashSet::new();

    let scene_list: Vec<_> = pack
        .scenes
        .values()
        .filter(|s| !s.has_warnings && !s.stages.is_empty())
        .collect();
    let total_scenes = scene_list.len() as u64;
    if let Some(p) = progress {
        p.update(
            if incremental {
                "Updating changed OStim scene JSON…"
            } else {
                "Writing OStim scene JSON…"
            },
            Some(0),
            Some(total_scenes.max(1)),
        );
    }

    for (si, scene) in scene_list.into_iter().enumerate() {
        if let Some(p) = progress {
            p.update(
                &format!(
                    "{}… ({}/{})",
                    if incremental {
                        "Updating OStim scenes"
                    } else {
                        "Writing OStim scenes"
                    },
                    si + 1,
                    total_scenes.max(1)
                ),
                Some((si + 1) as u64),
                Some(total_scenes.max(1)),
            );
        }
        let files = write_scene_ostim_json(scene, &modpack, &scenes_root, &mut summary)?;
        if files.is_empty() {
            continue;
        }

        let actor_count = scene.positions.len().max(1);
        for file in &files {
            for (animation, oneshot) in animations_from_ostim_json(&file.json) {
                if seen_anim.insert(animation.clone()) {
                    anim_entries.push(OstimAnimEntry {
                        folder: animation.clone(),
                        animation: animation.clone(),
                        actor_count,
                        oneshot,
                    });
                }
            }
            let copy_hkx = !incremental || file.changed;
            if copy_hkx {
                if let Some(src) = hkx_source {
                    summary.hkx_copied += copy_scene_hkx(
                        src,
                        &pack_root,
                        &pack_folder,
                        scene,
                        &file.json,
                    )?;
                }
            }
        }
    }

    if summary.json_files == 0 && summary.json_skipped == 0 {
        return Err("No scenes to export to OStim".into());
    }

    if let Some(src) = hkx_source {
        if !incremental {
            if let Some(p) = progress {
                p.phase("Copying pack extras…");
            }
            if copy_facial_expressions(src, &pack_root)? {
                summary.facial_copied = true;
            }

            if copy_sound_from_source(src, &pack_root)? {
                summary.sound_copied = true;
            }

            if let Some(nem) = copy_nemesis_from_source(src, &pack_root)? {
                summary.nemesis_dir = Some(nem);
                summary.nemesis_from_source = true;
            }
        } else if let Some(p) = progress {
            p.phase("Merging animlist (incremental)…");
        }
    }

    if let Some(p) = progress {
        p.phase(if incremental {
            "Merging animlist…"
        } else {
            "Writing animlist and assets…"
        });
    }

    if !incremental {
        let n_assets = write_embedded_ostim_assets(pack, &pack_root)?;
        summary.assets_written = n_assets;
        if n_assets > 0 {
            summary.facial_copied = summary.facial_copied
                || pack
                    .ostim_assets
                    .keys()
                    .any(|k| k.starts_with("facial expressions/"));
        }
    }

    if incremental {
        let (animlist, added) = merge_ostim_animlist(&pack_root, &pack_folder, &anim_entries)?;
        summary.animlist = Some(animlist);
        summary.animlist_lines_added = added;
    } else {
        let animlist = write_ostim_animlist(&pack_root, &pack_folder, &anim_entries)?;
        summary.animlist = Some(animlist);
    }

    if incremental && nemesis_already_present(&pack_root) {
        summary.nemesis_dir = Some(pack_root.join("Nemesis_Engine").join("mod"));
    }

    info!(
        "{} OStim export: wrote {} JSON (skipped {}), {} hkx, animlist +{}",
        if incremental { "Incremental" } else { "Full" },
        summary.json_files,
        summary.json_skipped,
        summary.hkx_copied,
        summary.animlist_lines_added
    );
    Ok(summary)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<usize, String> {
    if !src.is_dir() {
        return Ok(0);
    }
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    let mut n = 0;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            n += copy_dir_recursive(&from, &to)?;
        } else {
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::copy(&from, &to).map_err(|e| e.to_string())?;
            n += 1;
        }
    }
    Ok(n)
}

fn copy_facial_expressions(src_root: &Path, pack_root: &Path) -> Result<bool, String> {
    let src = src_root
        .join("SKSE")
        .join("Plugins")
        .join("OStim")
        .join("facial expressions");
    if !src.is_dir() {
        return Ok(false);
    }
    let dst = pack_root
        .join("SKSE")
        .join("Plugins")
        .join("OStim")
        .join("facial expressions");
    let n = copy_dir_recursive(&src, &dst)?;
    Ok(n > 0)
}

fn copy_sound_from_source(src_root: &Path, pack_root: &Path) -> Result<bool, String> {
    let src = src_root.join("Sound");
    if !src.is_dir() {
        return Ok(false);
    }
    let n = copy_dir_recursive(&src, &pack_root.join("Sound"))?;
    Ok(n > 0)
}

/// Collect small UTF-8 OStim assets for embedding in `.slsb.json`.
///
/// Covers facial expressions and custom action JSON under `SKSE/Plugins/OStim/`.
/// Binary assets (HKX, WAV, Nemesis trees) stay on disk via `ostim_source`.
pub fn collect_ostim_text_assets(
    src_root: &Path,
) -> Result<indexmap::IndexMap<String, String>, String> {
    use indexmap::IndexMap;
    let mut out = IndexMap::new();
    let ostim = src_root.join("SKSE").join("Plugins").join("OStim");
    if !ostim.is_dir() {
        return Ok(out);
    }
    for sub in ["facial expressions", "actions", "equip objects", "voice sets"] {
        let dir = ostim.join(sub);
        if !dir.is_dir() {
            continue;
        }
        collect_text_files_under(&dir, sub, &mut out)?;
    }
    Ok(out)
}

fn collect_text_files_under(
    dir: &Path,
    rel_prefix: &str,
    out: &mut indexmap::IndexMap<String, String>,
) -> Result<(), String> {
    let mut stack = vec![dir.to_path_buf()];
    while let Some(cur) = stack.pop() {
        let Ok(rd) = fs::read_dir(&cur) else {
            continue;
        };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            let Some(ext) = p.extension().and_then(|x| x.to_str()) else {
                continue;
            };
            if !ext.eq_ignore_ascii_case("json")
                && !ext.eq_ignore_ascii_case("txt")
                && !ext.eq_ignore_ascii_case("ini")
            {
                continue;
            }
            let rel = p
                .strip_prefix(dir)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            let key = if rel.is_empty() {
                rel_prefix.to_string()
            } else {
                format!("{rel_prefix}/{rel}")
            };
            match fs::read_to_string(&p) {
                Ok(body) => {
                    out.insert(key, body);
                }
                Err(_) => {
                    // Skip non-UTF8 binaries under these folders.
                }
            }
        }
    }
    Ok(())
}

fn write_embedded_ostim_assets(pack: &Package, pack_root: &Path) -> Result<usize, String> {
    if pack.ostim_assets.is_empty() {
        return Ok(0);
    }
    let base = pack_root.join("SKSE").join("Plugins").join("OStim");
    let mut n = 0usize;
    for (rel, body) in &pack.ostim_assets {
        let rel = rel.replace('\\', "/");
        let dest = base.join(Path::new(&rel));
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        // Don't overwrite newer disk copies with identical content unnecessarily,
        // but always ensure the file exists for portable exports.
        fs::write(&dest, body).map_err(|e| e.to_string())?;
        n += 1;
    }
    Ok(n)
}

/// Prefer the source pack's real Nemesis patches over the SLSB stub.
fn copy_nemesis_from_source(src_root: &Path, pack_root: &Path) -> Result<Option<PathBuf>, String> {
    let src_mod = src_root.join("Nemesis_Engine").join("mod");
    if !src_mod.is_dir() {
        return Ok(None);
    }
    let mut has_patch = false;
    for entry in fs::read_dir(&src_mod).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        // Real packs have behavior patch trees (0_master / defaultmale / …), not just info.ini.
        if p.join("0_master").is_dir()
            || p.join("defaultmale").is_dir()
            || p.join("defaultfemale").is_dir()
        {
            has_patch = true;
            break;
        }
        // Or any .txt patch fragments beyond README
        let mut txts = 0;
        if let Ok(rd) = fs::read_dir(&p) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.ends_with(".txt") && !name.contains("README") {
                    txts += 1;
                }
            }
        }
        if txts > 2 {
            has_patch = true;
            break;
        }
    }
    if !has_patch {
        return Ok(None);
    }
    let dst = pack_root.join("Nemesis_Engine");
    copy_dir_recursive(&src_root.join("Nemesis_Engine"), &dst)?;
    Ok(Some(dst.join("mod")))
}

/// Copy SLSB `_A#_S#` clips into OStim `{anim}_{actor}.hkx` layout.
/// When all speeds share one animation name, only stage 1's clips are copied.
fn copy_scene_hkx(
    source_root: &Path,
    pack_root: &Path,
    pack_folder: &str,
    scene: &Scene,
    json: &serde_json::Value,
) -> Result<usize, String> {
    let actor_count = scene.positions.len().max(1);
    let speeds = json
        .get("speeds")
        .and_then(|s| s.as_array())
        .cloned()
        .unwrap_or_default();
    if speeds.is_empty() {
        return Ok(0);
    }

    let shared_anim = speeds
        .iter()
        .filter_map(|s| s.get("animation").and_then(|a| a.as_str()))
        .collect::<Vec<_>>();
    let one_clip_set = shared_anim.len() > 1 && shared_anim.windows(2).all(|w| w[0] == w[1]);

    let mut copied = 0;
    if one_clip_set {
        let animation = shared_anim[0];
        let base = scene
            .stages
            .first()
            .and_then(|st| st.positions.first())
            .and_then(|p| p.event.first())
            .map(|e| strip_actor_stage_suffix(e).unwrap_or_else(|| e.clone()))
            .unwrap_or_else(|| animation.to_string());
        let dest = pack_root
            .join("meshes")
            .join("actors")
            .join("character")
            .join("animations")
            .join(pack_folder)
            .join(animation);
        copied += copy_slsb_hkx_to_ostim(source_root, &dest, &base, animation, 1, actor_count)?;
    } else {
        for (si, speed) in speeds.iter().enumerate() {
            let Some(animation) = speed.get("animation").and_then(|a| a.as_str()) else {
                continue;
            };
            let stage = scene.stages.get(si).or_else(|| scene.stages.first());
            let base = stage
                .and_then(|st| st.positions.first())
                .and_then(|p| p.event.first())
                .map(|e| strip_actor_stage_suffix(e).unwrap_or_else(|| e.clone()))
                .unwrap_or_else(|| animation.to_string());
            let dest = pack_root
                .join("meshes")
                .join("actors")
                .join("character")
                .join("animations")
                .join(pack_folder)
                .join(animation);
            copied += copy_slsb_hkx_to_ostim(
                source_root,
                &dest,
                &base,
                animation,
                si + 1,
                actor_count,
            )?;
        }
    }
    Ok(copied)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::package::Package;
    use std::fs;

    #[test]
    fn round_trip_mlc_subset() {
        let root = PathBuf::from(
            "/mnt/Data/Coding/Animations/OStim/Lovemaking Compendium for OStim Standalone",
        );
        if !root.exists() {
            return;
        }
        let pack = Package::from_ostim(root.clone(), None).unwrap();
        assert!(
            pack.scenes.len() < 80 && pack.scenes.len() > 5,
            "expected folder-scoped scenes, got {}",
            pack.scenes.len()
        );

        let tmp = std::env::temp_dir().join(format!("slsb_ostim_rt_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let summary = write_ostim_pack(&pack, &tmp, Some(&root), None).unwrap();
        assert!(
            summary.json_files > 300,
            "expected one JSON per OStim node, got {}",
            summary.json_files
        );
        assert!(summary.animlist.as_ref().unwrap().exists());
        assert!(summary.facial_copied, "expected facial expressions copy");
        assert!(
            summary.nemesis_from_source,
            "expected Nemesis patches copied from source"
        );
        let _ = fs::remove_dir_all(&tmp);
    }
}

//! Convert between OStim scene JSON nodes and SLSB `Scene`s.
//!
//! Mapping policy (import):
//! - Build the directed navigation graph (navigations + transition `destination` / `origin`).
//! - Partition by **folder-scoped** weakly connected components: undirected CC using only
//!   edges whose endpoints share the same `scenes/<folder>/` (missing → `"<root>"`).
//! - Cross-folder edges with incompatible cast signatures merge those components so
//!   SexLab play (shared `PositionInfo`) stays valid.
//! - Each component → one SLSB `Scene`; each OStim node → one `Stage`.
//! - Inter-folder / external links become `ostim_nav*` / `ostim_dest:` tags; in-project
//!   targets are promoted to absolute `DestRef` edges (`.slr` v5). Vanilla hubs stay tags.
//!
//! Export:
//! - One OStim JSON per stage (`ostim_id` tag), with `destination` for transitions
//!   and `navigations` from the stage graph (plus external-id tags above).

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};

use indexmap::IndexMap;
use log::warn;
use serde_json::Value;

use crate::project::define::{looks_like_return, DestRef, GraphEdge, Node, Offset, Sex};
use crate::project::ostim::events::{
    derive_anim_base, ostim_actor_event, sanitize_ostim_id, animation_base_from_event,
};
use crate::project::ostim::mapping::{
    action_to_tags, infer_race_key, ostim_furniture_to_slsb, slsb_furniture_to_ostim, tags_to_actions,
};
use crate::project::position::Position;
use crate::project::position_info::PositionInfo;
use crate::project::progress::JobProgress;
use crate::project::scene::Scene;
use crate::project::stage::{Extra as StageExtra, Stage};
use crate::project::NanoID;

#[derive(Debug, Default)]
pub struct OstimImportSummary {
    /// SLSB scenes created (one per folder-scoped component, after cast merges).
    pub scenes_imported: usize,
    /// OStim JSON nodes folded into those scenes.
    pub nodes_grouped: usize,
    /// Of which were transition nodes.
    pub transitions_included: usize,
    pub files_read: usize,
    /// autoTransitions edges materialized into the stage graph.
    pub auto_transitions_linked: usize,
    /// autoTransitions destinations missing from the pack.
    pub auto_transitions_missing: usize,
    /// Folder components merged because a cross-folder edge joined incompatible casts.
    pub cast_merges: usize,
    /// Graph edges promoted to absolute DestRefs across scenes.
    pub cross_scene_links: usize,
}

#[derive(Debug, Clone)]
struct NavEdge {
    from: String,
    to: String,
    priority: i64,
    description: String,
    icon: String,
    border: String,
}

pub fn find_ostim_scenes_dir(path: &Path) -> Result<PathBuf, String> {
    if path.is_file() {
        return Err("Expected an OStim pack folder or scenes directory".into());
    }
    let candidates = [
        path.join("SKSE/Plugins/OStim/scenes"),
        path.join("SKSE/Plugins/OStim/Scenes"),
        path.to_path_buf(),
    ];
    for c in candidates {
        if c.is_dir() {
            return Ok(c);
        }
    }
    Err(format!(
        "Could not find OStim scenes under {}",
        path.display()
    ))
}

pub fn collect_scene_jsons(scenes_dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    visit_jsons(scenes_dir, &mut out)?;
    out.sort();
    Ok(out)
}

fn visit_jsons(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            visit_jsons(&path, out)?;
        } else if path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("json"))
            .unwrap_or(false)
        {
            out.push(path);
        }
    }
    Ok(())
}

pub fn scene_id_from_path(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("scene")
        .to_string()
}

pub fn parse_ostim_file(path: &Path) -> Result<(String, Value), String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let value: Value =
        serde_json::from_reader(std::io::BufReader::new(file)).map_err(|e| e.to_string())?;
    Ok((scene_id_from_path(path), value))
}

pub fn is_transition(value: &Value) -> bool {
    value
        .get("destination")
        .and_then(|v| v.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false)
}

/// Import OStim scenes grouped by navigation connected components.
#[cfg(test)]
pub fn import_ostim_scenes(
    pack_or_scenes: &Path,
) -> Result<(String, String, IndexMap<NanoID, Scene>, OstimImportSummary), String> {
    import_ostim_scenes_with_progress(pack_or_scenes, None)
}

/// Import OStim scenes, optionally reporting progress to the UI.
pub fn import_ostim_scenes_with_progress(
    pack_or_scenes: &Path,
    progress: Option<&JobProgress<'_>>,
) -> Result<(String, String, IndexMap<NanoID, Scene>, OstimImportSummary), String> {
    let scenes_dir = find_ostim_scenes_dir(pack_or_scenes)?;
    if let Some(p) = progress {
        p.phase("Collecting scene JSON files…");
    }
    let files = collect_scene_jsons(&scenes_dir)?;
    if files.is_empty() {
        return Err(format!("No OStim scene JSON files in {}", scenes_dir.display()));
    }

    let mut summary = OstimImportSummary {
        files_read: files.len(),
        ..Default::default()
    };
    let mut pack_name = String::new();
    let mut raw: IndexMap<String, Value> = IndexMap::new();
    // Parent folder under `scenes/` for each node (preserves author grouping).
    let mut scene_folders: HashMap<String, String> = HashMap::new();

    let total_files = files.len() as u64;
    for (i, path) in files.iter().enumerate() {
        if let Some(p) = progress {
            p.update(
                &format!("Reading scenes… ({}/{})", i + 1, total_files),
                Some((i + 1) as u64),
                Some(total_files),
            );
        }
        let (ostim_id, value) = parse_ostim_file(path)?;
        if pack_name.is_empty() {
            if let Some(mp) = value
                .get("modpack")
                .or_else(|| value.get("modPack"))
                .and_then(|v| v.as_str())
            {
                pack_name = mp.trim().to_string();
            }
        }
        if let Some(parent) = path
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|s| s.to_str())
        {
            if parent != "scenes" && !parent.is_empty() {
                scene_folders.insert(ostim_id.clone(), parent.to_string());
            }
        }
        warn_dropped_ostim_fields(&ostim_id, &value);
        raw.insert(ostim_id, value);
    }

    if let Some(p) = progress {
        p.phase("Building navigation graph…");
    }
    let mut edges = collect_edges(&raw);
    let auto_stats = append_auto_transition_edges(&raw, &mut edges);
    summary.auto_transitions_linked = auto_stats.0;
    summary.auto_transitions_missing = auto_stats.1;
    if summary.auto_transitions_missing > 0 {
        warn!(
            "OStim import: {} autoTransition destination(s) missing from pack",
            summary.auto_transitions_missing
        );
    }
    let (components, cast_merges) = folder_scoped_connected_components(
        raw.keys().cloned().collect(),
        &edges,
        &scene_folders,
        &raw,
    );
    summary.cast_merges = cast_merges;
    let mut scenes = IndexMap::new();

    let total_components = components.len() as u64;
    for (ci, component) in components.into_iter().enumerate() {
        if let Some(p) = progress {
            p.update(
                &format!(
                    "Building scenes… ({}/{})",
                    ci + 1,
                    total_components.max(1)
                ),
                Some((ci + 1) as u64),
                Some(total_components.max(1)),
            );
        }
        let scene = component_to_scene(&component, &raw, &edges, &scene_folders, ci)?;
        summary.nodes_grouped += component.len();
        summary.transitions_included += component
            .iter()
            .filter(|id| raw.get(*id).map(is_transition).unwrap_or(false))
            .count();
        scenes.insert(scene.id.clone(), scene);
        summary.scenes_imported += 1;
    }

    summary.cross_scene_links = promote_in_project_cross_scene_navs(&mut scenes);

    if scenes.is_empty() {
        return Err("No OStim scenes found".into());
    }
    if pack_name.is_empty() {
        pack_name = pack_or_scenes
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("OStimPack")
            .to_string();
    }
    // Keep human-readable modpack (spaces). Filesystem-safe names are derived at export.

    Ok((pack_name, String::new(), scenes, summary))
}

fn collect_edges(raw: &IndexMap<String, Value>) -> Vec<NavEdge> {
    let mut edges = Vec::new();
    for (sid, value) in raw {
        if let Some(dest) = value.get("destination").and_then(|v| v.as_str()) {
            if !dest.is_empty() {
                edges.push(NavEdge {
                    from: sid.clone(),
                    to: dest.to_string(),
                    priority: 0,
                    description: String::new(),
                    icon: String::new(),
                    border: String::new(),
                });
            }
            // Transition authored with origin: edge origin → this transition
            if let Some(origin) = value.get("origin").and_then(|v| v.as_str()) {
                if !origin.is_empty() {
                    edges.push(NavEdge {
                        from: origin.to_string(),
                        to: sid.clone(),
                        priority: value
                            .get("priority")
                            .and_then(|v| v.as_i64())
                            .unwrap_or(0),
                        description: value
                            .get("description")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .trim_start_matches('$')
                            .to_string(),
                        icon: value
                            .get("icon")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        border: value
                            .get("border")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                    });
                }
            }
        }
        if let Some(navs) = value.get("navigations").and_then(|v| v.as_array()) {
            for nav in navs {
                let prio = nav.get("priority").and_then(|v| v.as_i64()).unwrap_or(0);
                let desc = nav
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim_start_matches('$')
                    .to_string();
                let icon = nav
                    .get("icon")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let border = nav
                    .get("border")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if let Some(dest) = nav.get("destination").and_then(|v| v.as_str()) {
                    if !dest.is_empty() {
                        edges.push(NavEdge {
                            from: sid.clone(),
                            to: dest.to_string(),
                            priority: prio,
                            description: desc,
                            icon,
                            border,
                        });
                    }
                } else if let Some(origin) = nav.get("origin").and_then(|v| v.as_str()) {
                    // Nav option added to origin leading to this scene
                    if !origin.is_empty() {
                        edges.push(NavEdge {
                            from: origin.to_string(),
                            to: sid.clone(),
                            priority: prio,
                            description: desc,
                            icon,
                            border,
                        });
                    }
                }
            }
        }
    }
    edges
}

fn auto_transition_priority(kind: &str) -> i64 {
    match kind.trim().to_ascii_lowercase().as_str() {
        "climax" | "orgasm" => 3000,
        _ => 2000,
    }
}

fn push_auto_transition_map(
    from: &str,
    map: &serde_json::Map<String, Value>,
    id_set: &HashSet<&str>,
    edges: &mut Vec<NavEdge>,
    linked: &mut usize,
    missing: &mut usize,
) {
    for (kind, dest_v) in map {
        let Some(dest) = dest_v.as_str().filter(|s| !s.is_empty()) else {
            continue;
        };
        if !id_set.contains(dest) {
            *missing += 1;
            warn!(
                "OStim '{from}': autoTransitions.{kind} → '{dest}' not in pack"
            );
            continue;
        }
        let already = edges
            .iter()
            .any(|e| e.from == from && e.to == dest);
        if already {
            continue;
        }
        edges.push(NavEdge {
            from: from.to_string(),
            to: dest.to_string(),
            priority: auto_transition_priority(kind),
            description: kind.clone(),
            icon: String::new(),
            border: String::new(),
        });
        *linked += 1;
    }
}

/// Materialize actor/scene `autoTransitions` into nav edges. Returns (linked, missing).
fn append_auto_transition_edges(
    raw: &IndexMap<String, Value>,
    edges: &mut Vec<NavEdge>,
) -> (usize, usize) {
    let id_set: HashSet<&str> = raw.keys().map(|s| s.as_str()).collect();
    let mut linked = 0usize;
    let mut missing = 0usize;
    for (sid, value) in raw {
        if let Some(map) = value.get("autoTransitions").and_then(|v| v.as_object()) {
            push_auto_transition_map(sid, map, &id_set, edges, &mut linked, &mut missing);
        }
        if let Some(actors) = value.get("actors").and_then(|a| a.as_array()) {
            for actor in actors {
                if let Some(map) = actor.get("autoTransitions").and_then(|v| v.as_object()) {
                    push_auto_transition_map(sid, map, &id_set, edges, &mut linked, &mut missing);
                }
            }
        }
    }
    (linked, missing)
}

fn connected_components(ids: Vec<String>, edges: &[NavEdge]) -> Vec<Vec<String>> {
    let mut undirected: HashMap<String, HashSet<String>> = HashMap::new();
    for id in &ids {
        undirected.entry(id.clone()).or_default();
    }
    for e in edges {
        if undirected.contains_key(&e.from) && undirected.contains_key(&e.to) {
            undirected.get_mut(&e.from).unwrap().insert(e.to.clone());
            undirected.get_mut(&e.to).unwrap().insert(e.from.clone());
        }
    }

    let mut visited = HashSet::new();
    let mut components = Vec::new();
    let mut sorted_ids = ids;
    sorted_ids.sort();
    for start in sorted_ids {
        if !visited.insert(start.clone()) {
            continue;
        }
        let mut comp = Vec::new();
        let mut q = VecDeque::new();
        q.push_back(start);
        while let Some(u) = q.pop_front() {
            comp.push(u.clone());
            if let Some(neis) = undirected.get(&u) {
                let mut neis: Vec<_> = neis.iter().cloned().collect();
                neis.sort();
                for v in neis {
                    if visited.insert(v.clone()) {
                        q.push_back(v);
                    }
                }
            }
        }
        comp.sort();
        components.push(comp);
    }
    components.sort_by_key(|c| std::cmp::Reverse(c.len()));
    components
}

fn ostim_folder_key(id: &str, scene_folders: &HashMap<String, String>) -> String {
    scene_folders
        .get(id)
        .filter(|s| !s.is_empty())
        .cloned()
        .unwrap_or_else(|| "<root>".to_string())
}

/// Actor cast fingerprint for cast-merge decisions (count + intendedSex).
fn ostim_cast_signature(value: &Value) -> Vec<String> {
    let Some(actors) = value.get("actors").and_then(|a| a.as_array()) else {
        return Vec::new();
    };
    actors
        .iter()
        .map(|a| {
            a.get("intendedSex")
                .or_else(|| a.get("sex"))
                .and_then(|v| v.as_str())
                .unwrap_or("any")
                .to_ascii_lowercase()
        })
        .collect()
}

/// Folder-scoped CC, then merge components linked by cross-folder edges with mismatched casts.
/// Returns `(components, cast_merge_count)`.
fn folder_scoped_connected_components(
    ids: Vec<String>,
    edges: &[NavEdge],
    scene_folders: &HashMap<String, String>,
    raw: &IndexMap<String, Value>,
) -> (Vec<Vec<String>>, usize) {
    let intra: Vec<NavEdge> = edges
        .iter()
        .filter(|e| {
            ostim_folder_key(&e.from, scene_folders) == ostim_folder_key(&e.to, scene_folders)
        })
        .cloned()
        .collect();
    let comps = connected_components(ids, &intra);
    if comps.is_empty() {
        return (comps, 0);
    }

    let mut id_to_comp: HashMap<&str, usize> = HashMap::new();
    for (i, comp) in comps.iter().enumerate() {
        for id in comp {
            id_to_comp.insert(id.as_str(), i);
        }
    }

    let n = comps.len();
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(parent: &mut [usize], mut x: usize) -> usize {
        while parent[x] != x {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        x
    }
    let mut merges = 0usize;
    for e in edges {
        let (Some(&ci), Some(&cj)) = (
            id_to_comp.get(e.from.as_str()),
            id_to_comp.get(e.to.as_str()),
        ) else {
            continue;
        };
        let ai = find(&mut parent, ci);
        let aj = find(&mut parent, cj);
        if ai == aj {
            continue;
        }
        let Some(va) = raw.get(&e.from) else {
            continue;
        };
        let Some(vb) = raw.get(&e.to) else {
            continue;
        };
        if ostim_cast_signature(va) == ostim_cast_signature(vb) {
            continue;
        }
        // Union by index for stability.
        if ai < aj {
            parent[aj] = ai;
        } else {
            parent[ai] = aj;
        }
        merges += 1;
    }

    if merges == 0 {
        return (comps, 0);
    }

    let mut buckets: HashMap<usize, Vec<String>> = HashMap::new();
    for (i, comp) in comps.into_iter().enumerate() {
        let root = find(&mut parent, i);
        buckets.entry(root).or_default().extend(comp);
    }
    let mut merged: Vec<Vec<String>> = buckets.into_values().collect();
    for comp in &mut merged {
        comp.sort();
        comp.dedup();
    }
    merged.sort_by_key(|c| std::cmp::Reverse(c.len()));
    (merged, merges)
}

fn component_to_scene(
    component: &[String],
    raw: &IndexMap<String, Value>,
    edges: &[NavEdge],
    scene_folders: &HashMap<String, String>,
    index: usize,
) -> Result<Scene, String> {
    let mut scene = Scene::default();
    let id_set: HashSet<&str> = component.iter().map(|s| s.as_str()).collect();

    let mut stage_for_ostim: HashMap<String, NanoID> = HashMap::new();
    let mut stages: Vec<Stage> = Vec::new();

    for (i, ostim_id) in component.iter().enumerate() {
        let value = raw
            .get(ostim_id)
            .ok_or_else(|| format!("Missing OStim node {ostim_id}"))?;
        let mut stage = ostim_node_to_stage(ostim_id, value, i)?;
        // Per-node scenes/<folder>/ — connected graphs span multiple dirs.
        if let Some(folder) = scene_folders.get(ostim_id) {
            if !folder.is_empty()
                && !stage
                    .tags
                    .iter()
                    .any(|t| t.starts_with("ostim_folder:"))
            {
                stage.tags.push(format!("ostim_folder:{folder}"));
            }
        }
        stage_for_ostim.insert(ostim_id.clone(), stage.id.clone());
        stages.push(stage);
    }

    // Leave all nodes at the default (40,40). App.jsx detects stacked coords and
    // applies computeLayeredPositions so branching OStim graphs don't form a line.
    let mut graph: HashMap<NanoID, Node> = HashMap::new();
    for stage in &stages {
        graph.insert(stage.id.clone(), Node::default());
    }

    let mut nav_enc_parts: HashMap<NanoID, Vec<String>> = HashMap::new();
    let mut nav_origin_parts: HashMap<NanoID, Vec<String>> = HashMap::new();
    // Best inbound description for transition stages: (priority, description).
    let mut transition_nav: HashMap<NanoID, (i64, String)> = HashMap::new();
    for edge in edges {
        let from_local = id_set.contains(edge.from.as_str());
        let to_local = id_set.contains(edge.to.as_str());
        if !from_local && !to_local {
            continue;
        }

        // Outbound to an external (vanilla) scene — keep as ostim_nav on the local from stage.
        if from_local && !to_local {
            let Some(from_id) = stage_for_ostim.get(&edge.from) else {
                continue;
            };
            let from_is_transition = raw.get(&edge.from).map(is_transition).unwrap_or(false);
            if !from_is_transition {
                let mut enc =
                    format!("{}:{}:{}", edge.priority, edge.to, edge.description);
                if !edge.icon.is_empty() || !edge.border.is_empty() {
                    enc.push_str(&format!(":{}:{}", edge.icon, edge.border));
                }
                nav_enc_parts
                    .entry(from_id.clone())
                    .or_default()
                    .push(enc);
            } else {
                // Transition whose destination is outside the pack.
                if let Some(stage) = stages.iter_mut().find(|s| s.id == *from_id) {
                    let tag = format!("ostim_dest:{}", edge.to);
                    if !stage.tags.iter().any(|t| t == &tag) {
                        stage.tags.push(tag);
                    }
                }
            }
            continue;
        }

        // Inbound from an external (vanilla) scene — keep as ostim_nav_origin on the local to stage.
        if !from_local && to_local {
            let Some(to_id) = stage_for_ostim.get(&edge.to) else {
                continue;
            };
            let mut enc =
                format!("{}:{}:{}", edge.priority, edge.from, edge.description);
            if !edge.icon.is_empty() || !edge.border.is_empty() {
                enc.push_str(&format!(":{}:{}", edge.icon, edge.border));
            }
            nav_origin_parts
                .entry(to_id.clone())
                .or_default()
                .push(enc);
            continue;
        }

        let Some(from_id) = stage_for_ostim.get(&edge.from) else {
            continue;
        };
        let Some(to_id) = stage_for_ostim.get(&edge.to) else {
            continue;
        };
        if let Some(node) = graph.get_mut(from_id) {
            let from_is_transition = raw.get(&edge.from).map(is_transition).unwrap_or(false);
            let secondary = looks_like_return(
                edge.priority as i32,
                &edge.description,
                &edge.icon,
            );
            // Pose → transition: carry OStim nav priority/label. Transition → pose: auto-chain.
            let meta = if from_is_transition {
                GraphEdge::default()
            } else {
                GraphEdge {
                    priority: edge.priority as i32,
                    flags: 0,
                    label: edge.description.clone(),
                }
                .with_secondary(secondary)
            };
            node.push_dest(DestRef::local(&scene.id, to_id.clone()), meta);
        }
        // Pose stages: full nav UX in `ostim_nav:*` tags only — do not put outbound
        // description lists into `extra.nav_text` (that field is SexLab edge navtext).
        // Transitions: inbound description in extra.nav_text for via-edge / .slr.
        let from_is_transition = raw.get(&edge.from).map(is_transition).unwrap_or(false);
        if !from_is_transition {
            let mut enc = format!("{}:{}:{}", edge.priority, edge.to, edge.description);
            if !edge.icon.is_empty() || !edge.border.is_empty() {
                enc.push_str(&format!(":{}:{}", edge.icon, edge.border));
            }
            nav_enc_parts
                .entry(from_id.clone())
                .or_default()
                .push(enc);
        }

        let to_is_transition = raw.get(&edge.to).map(is_transition).unwrap_or(false);
        let desc = edge.description.trim();
        if to_is_transition && !desc.is_empty() {
            let better = match transition_nav.get(to_id) {
                None => true,
                Some((old_prio, old_desc)) => {
                    let old_return = old_desc.eq_ignore_ascii_case("return");
                    let new_return = desc.eq_ignore_ascii_case("return");
                    if old_return && !new_return {
                        true
                    } else if !old_return && new_return {
                        false
                    } else {
                        edge.priority > *old_prio
                    }
                }
            };
            if better {
                transition_nav.insert(to_id.clone(), (edge.priority, desc.to_string()));
            }
        }
    }

    for stage in &mut stages {
        if let Some(parts) = nav_origin_parts.get(&stage.id) {
            for enc in parts {
                let tag = format!("ostim_nav_origin:{enc}");
                if !stage.tags.iter().any(|t| t == &tag) {
                    stage.tags.push(tag);
                }
            }
        }
        if stage_is_transition(stage) {
            if let Some((_, desc)) = transition_nav.get(&stage.id) {
                stage.extra.nav_text = desc.clone();
            }
        } else if let Some(parts) = nav_enc_parts.get(&stage.id) {
            for enc in parts {
                let tag = format!("ostim_nav:{enc}");
                if !stage.tags.iter().any(|t| t == &tag) {
                    stage.tags.push(tag);
                }
            }
        }
    }

    disambiguate_duplicate_stage_names(&mut stages);

    // Root: prefer looping idle, else first looping, else first node
    let root_ostim = pick_root(component, raw);
    scene.root = stage_for_ostim
        .get(&root_ostim)
        .cloned()
        .unwrap_or_else(|| stages[0].id.clone());

    let root_value = raw.get(&root_ostim);
    let root_name = root_value
        .and_then(|v| v.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or(&root_ostim)
        .trim_start_matches('$');
    scene.name = if component.len() == 1 {
        root_name.to_string()
    } else {
        format!("{root_name} [{} nodes]", component.len())
    };

    // Furniture: majority among looping nodes
    let mut furn_counts: HashMap<String, usize> = HashMap::new();
    for id in component {
        let Some(v) = raw.get(id) else { continue };
        if is_transition(v) {
            continue;
        }
        let f = v
            .get("furniture")
            .and_then(|x| x.as_str())
            .unwrap_or("none")
            .to_string();
        *furn_counts.entry(f).or_default() += 1;
    }
    let best_furn = furn_counts
        .into_iter()
        .max_by_key(|(_, n)| *n)
        .map(|(f, _)| f)
        .unwrap_or_else(|| "none".into());
    let (furni_types, allow_bed) = ostim_furniture_to_slsb(&best_furn);
    scene.furniture.furni_types = furni_types;
    scene.furniture.allow_bed = allow_bed;
    if best_furn != "none" {
        scene.furniture.ostim_type = best_furn.clone();
    }
    if let Some(off) = root_value.and_then(|v| v.get("offset")) {
        scene.furniture.offset = read_offset(off);
    }

    // Scene tags: union of looping tags + group marker
    let mut tags = Vec::new();
    tags.push(format!("ostim_group:{index}"));
    if best_furn != "none" {
        tags.push(format!("ostim_furniture:{best_furn}"));
    }
    // Preserve source scenes/<folder>/ grouping (majority vote among component nodes).
    let mut folder_counts: HashMap<&str, usize> = HashMap::new();
    for id in component {
        if let Some(f) = scene_folders.get(id) {
            *folder_counts.entry(f.as_str()).or_default() += 1;
        }
    }
    if let Some((folder, _)) = folder_counts.into_iter().max_by_key(|(_, n)| *n) {
        tags.push(format!("ostim_folder:{folder}"));
    }
    for id in component {
        let Some(v) = raw.get(id) else { continue };
        if is_transition(v) {
            continue;
        }
        if let Some(arr) = v.get("tags").and_then(|t| t.as_array()) {
            for t in arr {
                if let Some(s) = t.as_str() {
                    if !tags.iter().any(|x| x.eq_ignore_ascii_case(s)) {
                        tags.push(s.to_string());
                    }
                }
            }
        }
        if let Some(actions) = v.get("actions").and_then(|a| a.as_array()) {
            for action in actions {
                if let Some(ty) = action.get("type").and_then(|t| t.as_str()) {
                    for t in action_to_tags(ty) {
                        if !tags.iter().any(|x| x.eq_ignore_ascii_case(t)) {
                            tags.push(t.to_string());
                        }
                    }
                    let actor = action.get("actor").and_then(|x| x.as_u64()).unwrap_or(0);
                    let target = action
                        .get("target")
                        .and_then(|x| x.as_u64())
                        .unwrap_or(actor);
                    let performer = action
                        .get("performer")
                        .and_then(|x| x.as_u64())
                        .unwrap_or(actor);
                    let full = format!("action:{ty}:{actor}:{target}:{performer}");
                    if !tags.iter().any(|x| x == &full) {
                        tags.push(full);
                    }
                }
            }
        }
    }
    scene.tags = tags;

    // Climax: stages tagged climax / name contains Climax / leaf looping with climax tag
    for stage in &mut stages {
        let is_climax = stage.tags.iter().any(|t| {
            let l = t.to_ascii_lowercase();
            l == "climax" || l.contains("climax") || l == "orgasm"
        }) || stage.name.to_ascii_lowercase().contains("climax");
        if is_climax {
            for pos in &mut stage.positions {
                pos.climax = true;
                pos.extra.climax = true;
            }
        }
    }
    // Also: stages that are destinations of priority>=3000 navigations
    for edge in edges {
        if edge.priority < 3000 {
            continue;
        }
        if !id_set.contains(edge.to.as_str()) {
            continue;
        }
        if let Some(stage_id) = stage_for_ostim.get(&edge.to) {
            if let Some(stage) = stages.iter_mut().find(|s| &s.id == stage_id) {
                if !stage_is_transition(stage) {
                    for pos in &mut stage.positions {
                        pos.climax = true;
                        pos.extra.climax = true;
                    }
                }
            }
        }
    }

    scene.stages = stages;
    scene.graph = graph;

    // PositionInfo from root stage
    if let Some(root_stage) = scene.get_stage(&scene.root) {
        scene.positions = root_stage
            .positions
            .iter()
            .map(|p| PositionInfo {
                sex: p.sex.clone(),
                race: p.race.clone(),
                scale: p.scale,
                submissive: false,
                vampire: false,
                dead: false,
                add_cum: 0,
            })
            .collect();
    } else if let Some(first) = scene.stages.first() {
        scene.positions = first
            .positions
            .iter()
            .map(|p| PositionInfo {
                sex: p.sex.clone(),
                race: p.race.clone(),
                scale: p.scale,
                submissive: false,
                vampire: false,
                dead: false,
                add_cum: 0,
            })
            .collect();
    }

    Ok(scene)
}

fn pick_root(component: &[String], raw: &IndexMap<String, Value>) -> String {
    let looping: Vec<&String> = component
        .iter()
        .filter(|id| raw.get(*id).map(|v| !is_transition(v)).unwrap_or(false))
        .collect();
    for id in &looping {
        if let Some(tags) = raw.get(*id).and_then(|v| v.get("tags")).and_then(|t| t.as_array())
        {
            if tags
                .iter()
                .any(|t| t.as_str() == Some("idle"))
            {
                return (*id).clone();
            }
        }
    }
    if let Some(id) = looping.first() {
        return (*id).clone();
    }
    component[0].clone()
}

/// One OStim JSON node → one SLSB stage (default speed as event; extra speeds tagged).
fn ostim_node_to_stage(ostim_id: &str, value: &Value, layout_index: usize) -> Result<Stage, String> {
    let speeds = value
        .get("speeds")
        .and_then(|v| v.as_array())
        .ok_or_else(|| format!("Scene '{ostim_id}' missing speeds"))?;
    if speeds.is_empty() {
        return Err(format!("Scene '{ostim_id}' has empty speeds"));
    }
    let actors = value
        .get("actors")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if actors.is_empty() {
        return Err(format!("Scene '{ostim_id}' has no actors"));
    }

    let default_speed = value
        .get("defaultSpeed")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as usize;
    let default_speed = default_speed.min(speeds.len() - 1);

    let length_sec = value.get("length").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let fixed_len_ms = if length_sec > 0.0 {
        (length_sec * 1000.0).round() as f32
    } else {
        0.0
    };

    let display_name = value
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or(ostim_id)
        .trim_start_matches('$')
        .to_string();

    let mut tags: Vec<String> = value
        .get("tags")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| t.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    tags.push(format!("ostim_id:{ostim_id}"));
    if is_transition(value) {
        if !tags.iter().any(|t| t.eq_ignore_ascii_case("transition")) {
            tags.push("transition".into());
        }
        if let Some(dest) = value.get("destination").and_then(|v| v.as_str()) {
            tags.push(format!("ostim_dest:{dest}"));
        }
    }

    if let Some(actions) = value.get("actions").and_then(|v| v.as_array()) {
        for action in actions {
            if let Some(ty) = action.get("type").and_then(|v| v.as_str()) {
                for t in action_to_tags(ty) {
                    if !tags.iter().any(|x| x.eq_ignore_ascii_case(t)) {
                        tags.push(t.to_string());
                    }
                }
                let actor = action.get("actor").and_then(|x| x.as_u64()).unwrap_or(0);
                let target = action
                    .get("target")
                    .and_then(|x| x.as_u64())
                    .unwrap_or(actor);
                let performer = action
                    .get("performer")
                    .and_then(|x| x.as_u64())
                    .unwrap_or(actor);
                let full = format!("action:{ty}:{actor}:{target}:{performer}");
                if !tags.iter().any(|x| x == &full) {
                    tags.push(full);
                }
            }
        }
    }

    for key in [
        "fadeOnEntry",
        "scaleOffsetWithFurniture",
        "noRandomSelection",
    ] {
        if let Some(v) = value.get(key) {
            let enc = if let Some(b) = v.as_bool() {
                b.to_string()
            } else {
                v.to_string()
            };
            tags.push(format!("ostim_{key}:{enc}"));
        }
    }

    // Extra speeds beyond default
    for (si, speed) in speeds.iter().enumerate() {
        if si == default_speed {
            continue;
        }
        let anim = speed
            .get("animation")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let pb = speed
            .get("playbackSpeed")
            .and_then(|v| v.as_f64())
            .unwrap_or(1.0);
        let ds = speed
            .get("displaySpeed")
            .and_then(|v| v.as_f64())
            .unwrap_or((si + 1) as f64);
        tags.push(format!("ostim_speed:{anim}|{pb}|{ds}"));
    }

    let def = &speeds[default_speed];
    let animation = def
        .get("animation")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("Scene '{ostim_id}' default speed missing animation"))?;
    let playback = def
        .get("playbackSpeed")
        .and_then(|v| v.as_f64())
        .unwrap_or(1.0);
    let display = def
        .get("displaySpeed")
        .and_then(|v| v.as_f64())
        .unwrap_or((default_speed + 1) as f64);

    let scene_tag_hints: Vec<String> = value
        .get("tags")
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| t.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let mut stage = Stage {
        id: NanoID::new_nanoid(),
        name: format!("{display_name}|pb:{playback}|ds:{display}"),
        positions: Vec::with_capacity(actors.len()),
        tags,
        extra: StageExtra {
            // OStim `length` on looping poses is clip duration, not SexLab auto-advance.
            fixed_len: if is_transition(value) {
                fixed_len_ms.max(1.0)
            } else {
                0.0
            },
            nav_text: String::new(),
            sound: String::new(),
        },
    };
    let _ = layout_index;

    for (ai, actor) in actors.iter().enumerate() {
        let mut pos = Position::new(None);
        let anim_index = actor
            .get("animationIndex")
            .and_then(|v| v.as_u64())
            .unwrap_or(ai as u64) as usize;
        pos.event = vec![ostim_actor_event(animation, anim_index)];
        pos.offset = actor.get("offset").map(read_offset).unwrap_or_default();
        if let Some(sos) = actor.get("sosBend").and_then(|v| v.as_i64()) {
            pos.schlong = sos.clamp(i8::MIN as i64, i8::MAX as i64) as i8;
        }
        pos.sex = intended_sex_to_sex(actor.get("intendedSex").and_then(|v| v.as_str()));
        pos.race = infer_race_key(actor, &scene_tag_hints);
        pos.scale = actor
            .get("scale")
            .and_then(|v| v.as_f64())
            .unwrap_or(1.0) as f32;
        if let Some(atags) = actor.get("tags").and_then(|v| v.as_array()) {
            for t in atags.iter().filter_map(|t| t.as_str()) {
                if !pos.tags.iter().any(|x| x.eq_ignore_ascii_case(t)) {
                    pos.tags.push(t.to_string());
                }
            }
        }
        if actor.get("noStrip").and_then(|v| v.as_bool()) == Some(true) {
            pos.strip_data = crate::project::define::Stripping::nothing();
        }
        if let Some(v) = actor.get("lookUp").and_then(|v| v.as_i64()) {
            pos.look_up = v.clamp(-100, 100) as i32;
        } else if let Some(v) = actor.get("lookDown").and_then(|v| v.as_i64()) {
            pos.look_up = (-v).clamp(-100, 100) as i32;
        }
        if let Some(v) = actor.get("lookLeft").and_then(|v| v.as_i64()) {
            pos.look_left = v.clamp(-100, 100) as i32;
        } else if let Some(v) = actor.get("lookRight").and_then(|v| v.as_i64()) {
            pos.look_left = (-v).clamp(-100, 100) as i32;
        }
        if let Some(idx) = actor.get("animationIndex").and_then(|v| v.as_u64()) {
            if idx as usize != ai {
                pos.animation_index = Some(idx as u32);
            }
        }
        if let Some(expr) = actor
            .get("expressionOverride")
            .and_then(|v| v.as_str())
        {
            pos.expression_override = expr.to_string();
        }
        if let Some(v) = actor.get("expressionAction").and_then(|v| v.as_i64()) {
            pos.expression_action = Some(v.clamp(i32::MIN as i64, i32::MAX as i64) as i32);
        }
        if let Some(v) = actor.get("scaleHeight").and_then(|v| v.as_f64()) {
            pos.scale_height = Some(v as f32);
        }
        if let Some(eq) = actor.get("equipObjects").and_then(|v| v.as_object()) {
            let names: Vec<String> = eq
                .iter()
                .filter(|(_, v)| v.as_bool() == Some(true))
                .map(|(k, _)| k.clone())
                .collect();
            if !names.is_empty() {
                pos.equip_objects = names.join(" ");
                pos.anim_obj = names.join(" ");
            }
        }
        if actor.get("feetOnGround").and_then(|v| v.as_bool()) == Some(true) {
            pos.feet_on_ground = true;
        }
        stage.positions.push(pos);
    }

    Ok(stage)
}

#[cfg(test)]
pub fn ostim_json_to_scene(ostim_id: &str, value: &Value) -> Result<Scene, String> {
    let mut raw = IndexMap::new();
    raw.insert(ostim_id.to_string(), value.clone());
    let edges = collect_edges(&raw);
    component_to_scene(&[ostim_id.to_string()], &raw, &edges, &HashMap::new(), 0)
}

fn intended_sex_to_sex(s: Option<&str>) -> Sex {
    match s.map(|x| x.to_ascii_lowercase()).as_deref() {
        Some("female") => Sex {
            male: false,
            female: true,
            futa: false,
        },
        Some("male") => Sex {
            male: true,
            female: false,
            futa: false,
        },
        _ => Sex {
            male: true,
            female: true,
            futa: false,
        },
    }
}

fn sex_to_intended(sex: &Sex) -> Option<&'static str> {
    if sex.female && !sex.male {
        Some("female")
    } else if sex.male && !sex.female {
        Some("male")
    } else {
        None
    }
}

fn read_offset(v: &Value) -> Offset {
    Offset {
        x: v.get("x").and_then(|x| x.as_f64()).unwrap_or(0.0) as f32,
        y: v.get("y").and_then(|x| x.as_f64()).unwrap_or(0.0) as f32,
        z: v.get("z").and_then(|x| x.as_f64()).unwrap_or(0.0) as f32,
        r: v.get("r").and_then(|x| x.as_f64()).unwrap_or(0.0) as f32,
    }
}

fn write_offset(off: &Offset) -> Value {
    serde_json::json!({ "x": off.x, "y": off.y, "z": off.z, "r": off.r })
}

fn parse_playback_from_stage_name(name: &str) -> (f64, f64) {
    let mut pb = 1.0;
    let mut ds = 1.0;
    for part in name.split('|') {
        if let Some(rest) = part.strip_prefix("pb:") {
            if let Ok(v) = rest.parse::<f64>() {
                pb = v;
            }
        } else if let Some(rest) = part.strip_prefix("ds:") {
            if let Ok(v) = rest.parse::<f64>() {
                ds = v;
            }
        }
    }
    (pb, ds)
}

pub fn stage_ostim_folder(stage: &Stage) -> Option<String> {
    stage
        .tags
        .iter()
        .find_map(|t| t.strip_prefix("ostim_folder:").map(|s| s.to_string()))
        .filter(|s| !s.is_empty())
}

fn stage_ostim_id(stage: &Stage) -> Option<String> {
    stage
        .tags
        .iter()
        .find_map(|t| t.strip_prefix("ostim_id:").map(|s| s.to_string()))
}

/// OStim often reuses the same display name for different transition clips
/// (e.g. forward vs reverse). Append destination / id so the graph is readable.
fn disambiguate_duplicate_stage_names(stages: &mut [Stage]) {
    let mut indexes_by_name: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, stage) in stages.iter().enumerate() {
        indexes_by_name
            .entry(stage.name.clone())
            .or_default()
            .push(i);
    }
    for idxs in indexes_by_name.values() {
        if idxs.len() < 2 {
            continue;
        }
        for &i in idxs {
            let dest = stages[i]
                .tags
                .iter()
                .find_map(|t| t.strip_prefix("ostim_dest:"))
                .map(|s| s.to_string());
            let oid = stage_ostim_id(&stages[i]);
            let suffix = dest.or(oid);
            if let Some(suf) = suffix {
                stages[i].name = format!("{} [{}]", stages[i].name, suf);
            }
        }
    }
}

fn stage_is_transition(stage: &Stage) -> bool {
    stage
        .tags
        .iter()
        .any(|t| t.eq_ignore_ascii_case("transition"))
        || stage
            .tags
            .iter()
            .any(|t| t.starts_with("ostim_dest:"))
}

fn extract_ostim_id(scene: &Scene) -> String {
    if let Some(id) = scene
        .stages
        .iter()
        .find_map(|s| stage_ostim_id(s))
    {
        return sanitize_ostim_id(&id, &scene.id.0);
    }
    for tag in &scene.tags {
        if let Some(id) = tag.strip_prefix("ostim_id:") {
            return sanitize_ostim_id(id, &scene.id.0);
        }
    }
    let fallback = if scene.name.is_empty() {
        format!("Scene_{}", scene.id.0)
    } else {
        scene.name.clone()
    };
    let events: Vec<&str> = scene
        .stages
        .iter()
        .flat_map(|s| s.positions.iter())
        .filter_map(|p| p.event.first().map(|e| e.as_str()))
        .collect();
    let base = derive_anim_base(events, &sanitize_ostim_id(&fallback, &scene.id.0));
    sanitize_ostim_id(&base, &scene.id.0)
}

fn linear_stages(scene: &Scene) -> Result<Vec<&Stage>, String> {
    if scene.stages.is_empty() {
        return Err(format!("Scene '{}' has no stages", scene.name));
    }
    let branching = scene.graph.values().any(|n| n.dest.len() > 1);
    if branching {
        return Err("branching".into());
    }
    let mut ordered = Vec::new();
    let mut current = Some(scene.root.clone());
    let mut seen = HashSet::new();
    while let Some(id) = current {
        if !seen.insert(id.clone()) {
            break;
        }
        let stage = scene
            .stages
            .iter()
            .find(|s| s.id == id)
            .ok_or_else(|| format!("Missing stage {}", id.0))?;
        ordered.push(stage);
        current = scene.graph.get(&id).and_then(|n| {
            n.dest.first().and_then(|d| {
                if d.scene.0.is_empty() || d.scene == scene.id {
                    Some(d.stage.clone())
                } else {
                    None
                }
            })
        });
    }
    if ordered.len() != scene.stages.len() {
        return Err("disconnected".into());
    }
    Ok(ordered)
}

fn stages_share_anim_base(stages: &[&Stage]) -> Option<String> {
    let mut base: Option<String> = None;
    for stage in stages {
        for pos in &stage.positions {
            let Some(event) = pos.event.first() else {
                continue;
            };
            let Some(id) = animation_base_from_event(event) else {
                return None;
            };
            match &base {
                None => base = Some(id),
                Some(existing) if existing == &id => {}
                Some(_) => return None,
            }
        }
    }
    base
}

/// Export one SLSB scene to one or more OStim JSON documents: (scene_id, json).
pub fn scene_to_ostim_files(scene: &Scene, modpack: &str) -> Result<Vec<(String, Value)>, String> {
    if scene.has_warnings || scene.stages.is_empty() {
        return Ok(vec![]);
    }

    // Grouped OStim import: every stage has ostim_id → one JSON per stage (preserves graph)
    let all_have_ostim_id = scene.stages.iter().all(|s| stage_ostim_id(s).is_some());
    if all_have_ostim_id || scene.graph.values().any(|n| n.dest.len() > 1) {
        let stages: Vec<&Stage> = scene.stages.iter().collect();
        return export_stages_as_ostim_graph(scene, &stages, modpack);
    }

    match linear_stages(scene) {
        Ok(stages) => {
            if let Some(base) = stages_share_anim_base(&stages) {
                // Classic SexLab intensity chain → one OStim scene with speeds
                let id = extract_ostim_id(scene);
                let json = build_looping_ostim(&id, scene, &stages, &base, modpack, true)?;
                Ok(vec![(id, json)])
            } else {
                export_stages_as_ostim_graph(scene, &stages, modpack)
            }
        }
        Err(_) => {
            let stages: Vec<&Stage> = scene.stages.iter().collect();
            export_stages_as_ostim_graph(scene, &stages, modpack)
        }
    }
}

fn export_stages_as_ostim_graph(
    scene: &Scene,
    stages: &[&Stage],
    modpack: &str,
) -> Result<Vec<(String, Value)>, String> {
    let mut out = Vec::new();
    let mut id_for_stage: HashMap<NanoID, String> = HashMap::new();

    for (i, stage) in stages.iter().enumerate() {
        let sid = stage_ostim_id(stage).unwrap_or_else(|| {
            let base = stage
                .positions
                .first()
                .and_then(|p| p.event.first())
                .and_then(|e| animation_base_from_event(e))
                .unwrap_or_else(|| format!("Stage_{}", i + 1));
            sanitize_ostim_id(&base, &stage.id.0)
        });
        let anim = stage
            .positions
            .first()
            .and_then(|p| p.event.first())
            .and_then(|e| animation_base_from_event(e))
            .map(|b| sanitize_ostim_id(&b, &sid))
            .unwrap_or_else(|| sid.clone());
        id_for_stage.insert(stage.id.clone(), sid.clone());

        let speeds = speeds_for_stage(stage, &anim);
        let mut json = build_ostim_json(&sid, scene, stage, speeds, modpack)?;

        if stage_is_transition(stage) {
            // Prefer explicit ostim_dest, else first graph dest
            let dest = stage
                .tags
                .iter()
                .find_map(|t| t.strip_prefix("ostim_dest:").map(|s| s.to_string()))
                .or_else(|| {
                    scene
                        .graph
                        .get(&stage.id)
                        .and_then(|n| n.dest.first())
                        .and_then(|d| id_for_stage.get(&d.stage).cloned())
                });
            if let Some(dest) = dest {
                json["destination"] = Value::String(dest);
                let mut tags = json
                    .get("tags")
                    .and_then(|t| t.as_array())
                    .cloned()
                    .unwrap_or_default();
                if !tags.iter().any(|t| t.as_str() == Some("transition")) {
                    tags.push(Value::String("transition".into()));
                }
                json["tags"] = Value::Array(tags);
            }
        }

        out.push((sid, json));
    }

    // Second pass: ensure transition destinations resolve after all ids known
    for (sid, json) in &mut out {
        if json.get("destination").is_some() {
            continue;
        }
        let Some(stage) = stages.iter().find(|s| {
            stage_ostim_id(s).as_deref() == Some(sid.as_str())
                || (stage_ostim_id(s).is_none() && id_for_stage.get(&s.id).map(|x| x.as_str()) == Some(sid.as_str()))
        }) else {
            continue;
        };
        if !stage_is_transition(stage) {
            continue;
        }
        if let Some(dest_ref) = scene.graph.get(&stage.id).and_then(|n| n.dest.first()) {
            if dest_ref.scene.0.is_empty() || dest_ref.scene == scene.id {
                if let Some(dest_id) = id_for_stage.get(&dest_ref.stage) {
                    json["destination"] = Value::String(dest_id.clone());
                }
            }
        }
    }

    // Navigations for non-transition stages from graph + nav metadata (incl. external).
    for stage in stages {
        if stage_is_transition(stage) {
            continue;
        }
        let Some(from_id) = id_for_stage.get(&stage.id) else {
            continue;
        };
        let Some(node) = scene.graph.get(&stage.id) else {
            continue;
        };

        let mut navs_from_text = nav_meta_for_stage(stage);
        let mut used_dests = HashSet::new();
        let mut navs = Vec::new();

        // Inbound hooks from vanilla / external scenes (destination:null + origin).
        for meta in nav_origin_meta_for_stage(stage) {
            navs.push(nav_origin_to_json(&meta));
        }

        for dest in &node.dest {
            // OStim JSON navigations only cover same-scene / known ostim_id stages.
            if !dest.scene.0.is_empty() && dest.scene != scene.id {
                continue;
            }
            let Some(to_id) = id_for_stage.get(&dest.stage) else {
                continue;
            };
            used_dests.insert(to_id.clone());
            if let Some(meta) = navs_from_text
                .iter()
                .find(|m| m.dest == *to_id)
                .cloned()
            {
                navs.push(nav_to_json(&meta));
            } else {
                let dest_climax = stages.iter().any(|s| {
                    id_for_stage.get(&s.id).map(|x| x.as_str()) == Some(to_id.as_str())
                        && s.positions.iter().any(|p| p.climax)
                });
                navs.push(serde_json::json!({
                    "destination": to_id,
                    "description": to_id,
                    "priority": if dest_climax { 3000 } else { 1000 },
                }));
            }
        }
        // Keep nav entries whose dest wasn't in graph (external Return / cross-pack).
        for meta in navs_from_text.drain(..) {
            if used_dests.contains(&meta.dest) {
                continue;
            }
            navs.push(nav_to_json(&meta));
        }

        if navs.is_empty() {
            continue;
        }
        for (sid, json) in &mut out {
            if sid == from_id {
                json["navigations"] = Value::Array(navs);
                break;
            }
        }
    }

    Ok(out)
}

/// Promote in-project `ostim_nav:` / `ostim_dest:` targets in another scene into DestRef edges.
/// Returns how many cross-scene DestRefs were added.
fn promote_in_project_cross_scene_navs(scenes: &mut IndexMap<NanoID, Scene>) -> usize {
    let mut ostim_to_ref: HashMap<String, DestRef> = HashMap::new();
    for (scene_id, scene) in scenes.iter() {
        for stage in &scene.stages {
            if let Some(oid) = stage_ostim_id(stage) {
                ostim_to_ref.insert(
                    oid.to_string(),
                    DestRef::local(scene_id, stage.id.clone()),
                );
            }
        }
    }

    let mut promoted = 0usize;
    for (scene_id, scene) in scenes.iter_mut() {
        scene.prepare_for_encode();
        let stage_ids: Vec<NanoID> = scene.stages.iter().map(|s| s.id.clone()).collect();
        for stage_id in stage_ids {
            let Some(stage) = scene.stages.iter().find(|s| s.id == stage_id) else {
                continue;
            };

            // Pose / nav list tags.
            let navs = nav_meta_for_stage(stage);
            for meta in navs {
                let Some(target) = ostim_to_ref.get(&meta.dest) else {
                    continue;
                };
                if target.scene == *scene_id {
                    continue;
                }
                let secondary = looks_like_return(
                    meta.priority as i32,
                    &meta.description,
                    &meta.icon,
                );
                let edge = GraphEdge {
                    priority: meta.priority as i32,
                    flags: 0,
                    label: meta.description.clone(),
                }
                .with_secondary(secondary);
                let node = scene.graph.entry(stage_id.clone()).or_default();
                if !node.dest.iter().any(|d| d == target) {
                    node.push_dest(target.clone(), edge);
                    promoted += 1;
                }
            }

            // Transition destinations stored as ostim_dest: when the target is outside the component.
            let dest_oids: Vec<String> = stage
                .tags
                .iter()
                .filter_map(|t| t.strip_prefix("ostim_dest:").map(|s| s.to_string()))
                .collect();
            for dest_oid in dest_oids {
                let Some(target) = ostim_to_ref.get(&dest_oid) else {
                    continue;
                };
                if target.scene == *scene_id {
                    continue;
                }
                let node = scene.graph.entry(stage_id.clone()).or_default();
                if !node.dest.iter().any(|d| d == target) {
                    node.push_dest(target.clone(), GraphEdge::default());
                    promoted += 1;
                }
            }
        }
        scene.prepare_for_encode();
    }
    promoted
}

#[derive(Clone)]
struct NavMeta {
    dest: String,
    priority: i64,
    description: String,
    icon: String,
    border: String,
}

fn parse_nav_text(text: &str) -> Vec<NavMeta> {
    let mut out = Vec::new();
    let text = text.trim();
    if text.is_empty() {
        return out;
    }
    for part in text.split(';') {
        // prio:dest:desc[:icon:border]
        let bits: Vec<&str> = part.trim().splitn(5, ':').collect();
        if bits.len() < 2 {
            continue;
        }
        let priority = bits[0].parse::<i64>().unwrap_or(0);
        let dest = bits[1].to_string();
        if dest.is_empty() {
            continue;
        }
        let description = bits.get(2).unwrap_or(&"").to_string();
        let icon = bits.get(3).unwrap_or(&"").to_string();
        let border = bits.get(4).unwrap_or(&"").to_string();
        out.push(NavMeta {
            dest,
            priority,
            description,
            icon,
            border,
        });
    }
    out
}

/// OStim nav metadata: prefer `ostim_nav:*` tags (current import); fall back to
/// legacy encoded `extra.nav_text` from older projects.
fn nav_meta_for_stage(stage: &Stage) -> Vec<NavMeta> {
    let mut from_tags = Vec::new();
    for tag in &stage.tags {
        if let Some(enc) = tag.strip_prefix("ostim_nav:") {
            from_tags.extend(parse_nav_text(enc));
        }
    }
    if !from_tags.is_empty() {
        return from_tags;
    }
    parse_nav_text(&stage.extra.nav_text)
}

/// Inbound nav hooks from external/vanilla scenes (`origin` + no destination).
fn nav_origin_meta_for_stage(stage: &Stage) -> Vec<NavMeta> {
    let mut from_tags = Vec::new();
    for tag in &stage.tags {
        if let Some(enc) = tag.strip_prefix("ostim_nav_origin:") {
            from_tags.extend(parse_nav_text(enc));
        }
    }
    from_tags
}

fn nav_to_json(meta: &NavMeta) -> Value {
    let mut obj = serde_json::json!({
        "destination": meta.dest,
        "description": if meta.description.is_empty() { meta.dest.as_str() } else { meta.description.as_str() },
        "priority": meta.priority,
    });
    if !meta.icon.is_empty() {
        obj["icon"] = Value::String(meta.icon.clone());
    }
    if !meta.border.is_empty() {
        obj["border"] = Value::String(meta.border.clone());
    }
    obj
}

fn nav_origin_to_json(meta: &NavMeta) -> Value {
    let mut obj = serde_json::json!({
        "origin": meta.dest,
        "description": if meta.description.is_empty() { meta.dest.as_str() } else { meta.description.as_str() },
        "priority": meta.priority,
    });
    if !meta.icon.is_empty() {
        obj["icon"] = Value::String(meta.icon.clone());
    }
    if !meta.border.is_empty() {
        obj["border"] = Value::String(meta.border.clone());
    }
    obj
}

fn is_ostim_bookkeeping_actor_tag(tag: &str) -> bool {
    tag.starts_with("ostim_sos:")
        || tag.starts_with("ostim_lookUp:")
        || tag.starts_with("ostim_lookLeft:")
        || tag.starts_with("ostim_animIndex:")
        || tag.starts_with("ostim_expr:")
        || tag.starts_with("ostim_equip:")
        || tag.starts_with("ostim_feetOnGround:")
}

fn speeds_for_stage(stage: &Stage, default_anim: &str) -> Vec<Value> {
    let (pb, ds) = parse_playback_from_stage_name(&stage.name);
    let mut speeds = vec![serde_json::json!({
        "animation": default_anim,
        "playbackSpeed": pb,
        "displaySpeed": ds,
    })];
    for tag in &stage.tags {
        if let Some(rest) = tag.strip_prefix("ostim_speed:") {
            let parts: Vec<&str> = rest.split('|').collect();
            if parts.len() >= 3 {
                let anim = if parts[0].is_empty() {
                    default_anim
                } else {
                    parts[0]
                };
                let pb: f64 = parts[1].parse().unwrap_or(1.0);
                let ds: f64 = parts[2].parse().unwrap_or(1.0);
                speeds.push(serde_json::json!({
                    "animation": anim,
                    "playbackSpeed": pb,
                    "displaySpeed": ds,
                }));
            }
        }
    }
    speeds
}

fn build_looping_ostim(
    scene_id: &str,
    scene: &Scene,
    stages: &[&Stage],
    anim_base: &str,
    modpack: &str,
    encode_playback: bool,
) -> Result<Value, String> {
    let mut speeds = Vec::new();
    for (i, stage) in stages.iter().enumerate() {
        let (mut pb, mut ds) = parse_playback_from_stage_name(&stage.name);
        if !encode_playback || (pb == 1.0 && !stage.name.contains("pb:")) {
            pb = 1.0 + 0.2 * i as f64;
            ds = (i + 1) as f64;
        }
        speeds.push(serde_json::json!({
            "animation": anim_base,
            "playbackSpeed": pb,
            "displaySpeed": ds,
        }));
    }
    build_ostim_json(scene_id, scene, stages[0], speeds, modpack)
}

fn build_ostim_json(
    scene_id: &str,
    scene: &Scene,
    stage_for_actors: &Stage,
    speeds: Vec<Value>,
    modpack: &str,
) -> Result<Value, String> {
    let length_sec = if stage_for_actors.extra.fixed_len > 0.0 {
        stage_for_actors.extra.fixed_len / 1000.0
    } else {
        2.0
    };

    let display_name = stage_for_actors
        .name
        .split('|')
        .next()
        .filter(|s| !s.is_empty() && !s.starts_with("pb:"))
        .unwrap_or(scene_id);

    let mut actors = Vec::new();
    for (i, info) in scene.positions.iter().enumerate() {
        let pos = stage_for_actors.positions.get(i);
        let mut actor = serde_json::Map::new();
        actor.insert("type".into(), Value::String("npc".into()));
        if let Some(sex) = sex_to_intended(&info.sex) {
            actor.insert("intendedSex".into(), Value::String(sex.into()));
        }
        let schlong = pos.map(|p| p.schlong).unwrap_or(0);
        if schlong != 0 {
            actor.insert("sosBend".into(), serde_json::json!(schlong as i64));
        }
        if (info.scale - 1.0).abs() > f32::EPSILON {
            actor.insert("scale".into(), serde_json::json!(info.scale));
        }
        if let Some(p) = pos {
            if let Some(h) = p.scale_height {
                actor.insert("scaleHeight".into(), serde_json::json!(h));
            }
            if p.offset.x != 0.0 || p.offset.y != 0.0 || p.offset.z != 0.0 || p.offset.r != 0.0 {
                actor.insert("offset".into(), write_offset(&p.offset));
            }
            let actor_tags: Vec<String> = p
                .tags
                .iter()
                .filter(|t| !is_ostim_bookkeeping_actor_tag(t))
                .cloned()
                .collect();
            if !actor_tags.is_empty() {
                actor.insert(
                    "tags".into(),
                    Value::Array(actor_tags.into_iter().map(Value::String).collect()),
                );
            }
            if p.look_up != 0 {
                actor.insert("lookUp".into(), serde_json::json!(p.look_up));
            }
            if p.look_left != 0 {
                actor.insert("lookLeft".into(), serde_json::json!(p.look_left));
            }
            // Always emit — OStim packs treat this as required actor context.
            actor.insert("feetOnGround".into(), Value::Bool(p.feet_on_ground));
            if let Some(idx) = p.animation_index {
                actor.insert("animationIndex".into(), serde_json::json!(idx));
            }
            if !p.expression_override.trim().is_empty() {
                actor.insert(
                    "expressionOverride".into(),
                    Value::String(p.expression_override.trim().to_string()),
                );
            }
            if let Some(ea) = p.expression_action {
                actor.insert("expressionAction".into(), serde_json::json!(ea));
            }
            // Equip objects: prefer explicit field; fall back to anim_obj tokens as author hint
            let equip = if !p.equip_objects.trim().is_empty() {
                p.equip_objects.clone()
            } else if !p.anim_obj.trim().is_empty() {
                p.anim_obj.clone()
            } else {
                String::new()
            };
            if !equip.is_empty() {
                let mut map = serde_json::Map::new();
                for tok in equip.split(|c: char| c == ',' || c.is_whitespace()) {
                    let t = tok.trim();
                    if !t.is_empty() {
                        map.insert(t.to_string(), Value::Bool(true));
                    }
                }
                if !map.is_empty() {
                    actor.insert("equipObjects".into(), Value::Object(map));
                }
            }
            if p.strip_data.is_nothing() {
                actor.insert("noStrip".into(), Value::Bool(true));
            }
        }
        actors.push(Value::Object(actor));
    }

    let mut tags: Vec<String> = stage_for_actors
        .tags
        .iter()
        .filter(|t| {
            !t.starts_with("ostim_id:")
                && !t.starts_with("ostim_dest:")
                && !t.starts_with("ostim_speed:")
                && !t.starts_with("ostim_furniture:")
                && !t.starts_with("ostim_fadeOnEntry:")
                && !t.starts_with("ostim_scaleOffsetWithFurniture:")
                && !t.starts_with("ostim_noRandomSelection:")
                && !t.starts_with("ostim_nav:")
                && !t.starts_with("ostim_nav_origin:")
                && !t.starts_with("ostim_folder:")
                && !t.starts_with("nav:")
                && !t.starts_with("action:")
                && !t.starts_with("ostim_group:")
        })
        .cloned()
        .collect();
    if stage_for_actors.positions.iter().any(|p| p.climax)
        && !tags.iter().any(|t| t.eq_ignore_ascii_case("climax"))
    {
        tags.push("climax".into());
    }

    // Actions must come from this stage alone — scene.tags is a component-wide union.
    let mut actions = tags_to_actions(&stage_for_actors.tags, actors.len());
    if actions.is_empty() {
        actions = tags_to_actions(&tags, actors.len());
    }

    let furniture = if !scene.furniture.ostim_type.trim().is_empty() {
        scene.furniture.ostim_type.trim().to_ascii_lowercase()
    } else {
        slsb_furniture_to_ostim(&scene.furniture.furni_types, scene.furniture.allow_bed)
    };

    let mut root = serde_json::json!({
        "name": display_name,
        "modpack": modpack,
        "length": length_sec,
        "speeds": speeds,
        "actors": actors,
        "tags": tags,
        "actions": actions,
    });

    if furniture != "none" {
        root["furniture"] = Value::String(furniture);
    }
    let foff = &scene.furniture.offset;
    if foff.x != 0.0 || foff.y != 0.0 || foff.z != 0.0 || foff.r != 0.0 {
        root["offset"] = write_offset(foff);
    }

    let _ = scene_id;
    Ok(root)
}

/// Collect unique animations for animlist generation from exported JSON.
pub fn animations_from_ostim_json(json: &Value) -> Vec<(String, bool)> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let oneshot = json
        .get("destination")
        .and_then(|v| v.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false)
        || json
            .get("tags")
            .and_then(|t| t.as_array())
            .map(|a| a.iter().any(|x| x.as_str() == Some("transition")))
            .unwrap_or(false);
    if let Some(speeds) = json.get("speeds").and_then(|v| v.as_array()) {
        for speed in speeds {
            if let Some(anim) = speed.get("animation").and_then(|v| v.as_str()) {
                if seen.insert(anim.to_string()) {
                    out.push((anim.to_string(), oneshot));
                }
            }
        }
    }
    out
}

pub fn warn_dropped_ostim_fields(ostim_id: &str, value: &Value) {
    // Fields we deliberately leave out of SLSB IR (no safe slot / unused by SexLab++).
    for key in ["compatScenes", "sourceSound", "hudIcon"] {
        if value.get(key).is_some() {
            warn!("OStim scene '{ostim_id}': field '{key}' not represented in SLSB IR");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_transitions_become_graph_edges() {
        let mut raw = IndexMap::new();
        raw.insert(
            "Sex".into(),
            serde_json::json!({
                "name": "Sex", "length": 2,
                "speeds": [{ "animation": "SexAnim", "playbackSpeed": 1, "displaySpeed": 1 }],
                "actors": [{
                    "intendedSex": "male",
                    "autoTransitions": { "climax": "Climax" }
                }, { "intendedSex": "female" }],
                "actions": [],
                "navigations": []
            }),
        );
        raw.insert(
            "Climax".into(),
            serde_json::json!({
                "name": "Climax", "length": 2,
                "tags": ["climax"],
                "speeds": [{ "animation": "ClimaxAnim" }],
                "actors": [{ "intendedSex": "male" }, { "intendedSex": "female" }],
                "actions": []
            }),
        );
        let edges = {
            let mut e = collect_edges(&raw);
            let _ = append_auto_transition_edges(&raw, &mut e);
            e
        };
        assert!(
            edges.iter().any(|e| e.from == "Sex" && e.to == "Climax" && e.priority == 3000),
            "expected climax autoTransition edge: {edges:?}"
        );
        let scene = component_to_scene(&["Climax".into(), "Sex".into()], &raw, &edges, &HashMap::new(), 0).unwrap();
        let sex_stage = scene
            .stages
            .iter()
            .find(|s| s.tags.iter().any(|t| t == "ostim_id:Sex"))
            .unwrap();
        let climax_stage = scene
            .stages
            .iter()
            .find(|s| s.tags.iter().any(|t| t == "ostim_id:Climax"))
            .unwrap();
        assert!(scene
            .graph
            .get(&sex_stage.id)
            .unwrap()
            .dest
            .iter()
            .any(|d| d.stage == climax_stage.id));
    }

    #[test]
    fn single_node_still_imports() {
        let json: Value = serde_json::json!({
            "name": "Lovemaking: Bed Cowgirl",
            "modpack": "Moon Lovemaking Compendium",
            "length": 2,
            "speeds": [
                { "animation": "MLCBedCowgirl", "playbackSpeed": 1, "displaySpeed": 1 },
                { "animation": "MLCBedCowgirl", "playbackSpeed": 1.2, "displaySpeed": 2 }
            ],
            "furniture": "singlebed",
            "tags": ["cowgirl"],
            "actors": [
                { "intendedSex": "male", "sosBend": 6, "tags": ["lyingback"] },
                { "intendedSex": "female", "tags": ["kneeling"] }
            ],
            "actions": [
                { "type": "vaginalsex", "actor": 0, "target": 1, "performer": 1 }
            ],
            "navigations": [
                { "destination": "Other", "description": "Go", "priority": 1000 }
            ]
        });
        let scene = ostim_json_to_scene("MLCBedCowgirl", &json).unwrap();
        assert_eq!(scene.stages.len(), 1);
        assert!(scene.stages[0].tags.iter().any(|t| t.starts_with("ostim_speed:")));
        assert_eq!(scene.stages[0].positions[0].event[0], "MLCBedCowgirl_0");
        assert_eq!(scene.stages[0].positions[0].schlong, 6);
        assert!(scene.stages[0]
            .tags
            .iter()
            .any(|t| t == "action:vaginalsex:0:1:1"));
    }

    #[test]
    fn groups_connected_nav_graph() {
        let mut raw = IndexMap::new();
        raw.insert(
            "Idle".into(),
            serde_json::json!({
                "name": "Idle", "length": 2,
                "tags": ["idle"],
                "speeds": [{ "animation": "IdleAnim", "playbackSpeed": 1, "displaySpeed": 1 }],
                "actors": [{ "intendedSex": "male" }, { "intendedSex": "female" }],
                "actions": [],
                "navigations": [
                    { "destination": "GoSex", "description": "Start", "priority": 2000 }
                ]
            }),
        );
        raw.insert(
            "GoSex".into(),
            serde_json::json!({
                "name": "Go to Sex", "length": 1.5,
                "destination": "Sex",
                "tags": ["transition"],
                "speeds": [{ "animation": "GoSexAnim" }],
                "actors": [{ "intendedSex": "male" }, { "intendedSex": "female" }],
                "actions": []
            }),
        );
        raw.insert(
            "Sex".into(),
            serde_json::json!({
                "name": "Sex", "length": 2,
                "tags": ["cowgirl"],
                "speeds": [
                    { "animation": "SexAnim", "playbackSpeed": 1, "displaySpeed": 1 },
                    { "animation": "SexAnim", "playbackSpeed": 1.4, "displaySpeed": 2 }
                ],
                "actors": [{ "intendedSex": "male" }, { "intendedSex": "female" }],
                "actions": [{ "type": "vaginalsex", "actor": 0, "target": 1 }],
                "navigations": [
                    { "destination": "GoIdle", "description": "Return", "priority": -1000 }
                ]
            }),
        );
        raw.insert(
            "GoIdle".into(),
            serde_json::json!({
                "name": "Return", "length": 1,
                "destination": "Idle",
                "tags": ["transition"],
                "speeds": [{ "animation": "GoIdleAnim" }],
                "actors": [{ "intendedSex": "male" }, { "intendedSex": "female" }],
                "actions": []
            }),
        );
        // Unrelated singleton
        raw.insert(
            "Other".into(),
            serde_json::json!({
                "name": "Other", "length": 2,
                "speeds": [{ "animation": "OtherAnim" }],
                "actors": [{ "intendedSex": "female" }],
                "actions": []
            }),
        );

        let edges = collect_edges(&raw);
        let comps = connected_components(raw.keys().cloned().collect(), &edges);
        assert_eq!(comps.len(), 2);
        let big = comps.iter().find(|c| c.len() == 4).unwrap();
        let scene = component_to_scene(big, &raw, &edges, &HashMap::new(), 0).unwrap();
        assert_eq!(scene.stages.len(), 4);
        assert!(scene.graph.values().any(|n| n.dest.len() >= 1));
        // Idle should branch to GoSex
        let idle_stage = scene
            .stages
            .iter()
            .find(|s| stage_ostim_id(s).as_deref() == Some("Idle"))
            .unwrap();
        let idle_node = scene.graph.get(&idle_stage.id).unwrap();
        assert_eq!(idle_node.dest.len(), 1);

        let go_sex_stage = scene
            .stages
            .iter()
            .find(|s| stage_ostim_id(s).as_deref() == Some("GoSex"))
            .unwrap();
        assert_eq!(go_sex_stage.extra.nav_text, "Start");
        let go_idle_stage = scene
            .stages
            .iter()
            .find(|s| stage_ostim_id(s).as_deref() == Some("GoIdle"))
            .unwrap();
        assert_eq!(go_idle_stage.extra.nav_text, "Return");
        // Pose nav metadata lives in ostim_nav tags; nav_text stays empty for SexLab.
        assert_eq!(idle_stage.extra.nav_text, "");
        assert!(idle_stage
            .tags
            .iter()
            .any(|t| t.starts_with("ostim_nav:") && t.contains("GoSex") && t.contains("Start")));

        let files = scene_to_ostim_files(&scene, "Test").unwrap();
        assert_eq!(files.len(), 4);
        let go_sex = files.iter().find(|(id, _)| id == "GoSex").unwrap();
        assert_eq!(
            go_sex.1.get("destination").and_then(|v| v.as_str()),
            Some("Sex")
        );
        let idle = files.iter().find(|(id, _)| id == "Idle").unwrap();
        let navs = idle.1.get("navigations").and_then(|v| v.as_array()).unwrap();
        assert!(navs.iter().any(|n| n.get("destination").and_then(|d| d.as_str()) == Some("GoSex")));
    }

    #[test]
    fn transition_nav_text_prefers_forward_description_over_return() {
        let mut raw = IndexMap::new();
        raw.insert(
            "Pose2".into(),
            serde_json::json!({
                "name": "Pose 2", "length": 2,
                "speeds": [{ "animation": "Pose2Anim", "playbackSpeed": 1, "displaySpeed": 1 }],
                "actors": [{ "intendedSex": "male" }, { "intendedSex": "female" }],
                "actions": [],
                "navigations": [
                    {
                        "destination": "GoPose3",
                        "description": "Grab both {1}'s breasts and let her take over",
                        "icon": "OStim/detail/gropingbreast_behind_mf",
                        "border": "b969ed",
                        "priority": 3001
                    },
                    {
                        "destination": "GoPose2Rev",
                        "description": "Return",
                        "icon": "OStim/symbols/return",
                        "priority": -1000
                    }
                ]
            }),
        );
        raw.insert(
            "GoPose3".into(),
            serde_json::json!({
                "name": "Go to Pose 3", "length": 2,
                "destination": "Pose3",
                "tags": ["transition"],
                "speeds": [{ "animation": "GoPose3Anim" }],
                "actors": [{ "intendedSex": "male" }, { "intendedSex": "female" }],
                "actions": []
            }),
        );
        raw.insert(
            "Pose3".into(),
            serde_json::json!({
                "name": "Pose 3", "length": 2,
                "speeds": [{ "animation": "Pose3Anim", "playbackSpeed": 1, "displaySpeed": 1 }],
                "actors": [{ "intendedSex": "male" }, { "intendedSex": "female" }],
                "actions": []
            }),
        );
        raw.insert(
            "GoPose2Rev".into(),
            serde_json::json!({
                "name": "Return to Pose 2", "length": 2,
                "destination": "Pose2",
                "tags": ["transition"],
                "speeds": [{ "animation": "GoPose2RevAnim" }],
                "actors": [{ "intendedSex": "male" }, { "intendedSex": "female" }],
                "actions": []
            }),
        );

        let edges = collect_edges(&raw);
        let comps = connected_components(raw.keys().cloned().collect(), &edges);
        assert_eq!(comps.len(), 1);
        let scene = component_to_scene(&comps[0], &raw, &edges, &HashMap::new(), 0).unwrap();

        let go_pose3 = scene
            .stages
            .iter()
            .find(|s| stage_ostim_id(s).as_deref() == Some("GoPose3"))
            .unwrap();
        assert_eq!(
            go_pose3.extra.nav_text,
            "Grab both {1}'s breasts and let her take over"
        );
        let go_rev = scene
            .stages
            .iter()
            .find(|s| stage_ostim_id(s).as_deref() == Some("GoPose2Rev"))
            .unwrap();
        assert_eq!(go_rev.extra.nav_text, "Return");

        let pose2 = scene
            .stages
            .iter()
            .find(|s| stage_ostim_id(s).as_deref() == Some("Pose2"))
            .unwrap();
        assert_eq!(pose2.extra.nav_text, "");
        assert!(pose2
            .tags
            .iter()
            .any(|t| t.starts_with("ostim_nav:") && t.contains("GoPose3")));
        assert!(pose2
            .tags
            .iter()
            .any(|t| t.starts_with("ostim_nav:") && t.contains("GoPose2Rev")));

        let pose2_node = scene.graph.get(&pose2.id).unwrap();
        assert_eq!(pose2_node.dest.len(), 2);
        assert_eq!(pose2_node.edges.len(), 2);
        let fwd = pose2_node
            .edges
            .iter()
            .find(|e| e.label.contains("breasts"))
            .expect("forward edge");
        assert_eq!(fwd.priority, 3001);
        assert!(!fwd.is_secondary());
        let ret = pose2_node
            .edges
            .iter()
            .find(|e| e.label.eq_ignore_ascii_case("return"))
            .expect("return edge");
        assert!(ret.is_secondary());
        assert_eq!(ret.priority, -1000);
        assert_eq!(pose2.extra.fixed_len, 0.0);
        assert!(go_rev.extra.fixed_len > 0.0);
    }

    #[test]
    fn folder_scoped_split_promotes_cross_folder_links() {
        let mut raw = IndexMap::new();
        raw.insert(
            "AIdle".into(),
            serde_json::json!({
                "name": "A Idle", "length": 2,
                "tags": ["idle"],
                "speeds": [{ "animation": "AIdleAnim" }],
                "actors": [{ "intendedSex": "male" }, { "intendedSex": "female" }],
                "actions": [],
                "navigations": [
                    { "destination": "BPose", "description": "Cross", "priority": 1000 }
                ]
            }),
        );
        raw.insert(
            "BPose".into(),
            serde_json::json!({
                "name": "B Pose", "length": 2,
                "speeds": [{ "animation": "BPoseAnim" }],
                "actors": [{ "intendedSex": "male" }, { "intendedSex": "female" }],
                "actions": [],
                "navigations": []
            }),
        );
        let mut folders = HashMap::new();
        folders.insert("AIdle".into(), "FolderA".into());
        folders.insert("BPose".into(), "FolderB".into());
        let edges = collect_edges(&raw);
        let (comps, merges) = folder_scoped_connected_components(
            raw.keys().cloned().collect(),
            &edges,
            &folders,
            &raw,
        );
        assert_eq!(merges, 0, "same cast should not merge");
        assert_eq!(comps.len(), 2);

        let mut scenes = IndexMap::new();
        for (i, comp) in comps.into_iter().enumerate() {
            let scene = component_to_scene(&comp, &raw, &edges, &folders, i).unwrap();
            scenes.insert(scene.id.clone(), scene);
        }
        let promoted = promote_in_project_cross_scene_navs(&mut scenes);
        assert!(promoted >= 1, "expected DestRef across folders");
        let a_scene = scenes
            .values()
            .find(|s| s.stages.iter().any(|st| stage_ostim_id(st).as_deref() == Some("AIdle")))
            .unwrap();
        let b_scene = scenes
            .values()
            .find(|s| s.stages.iter().any(|st| stage_ostim_id(st).as_deref() == Some("BPose")))
            .unwrap();
        assert_ne!(a_scene.id, b_scene.id);
        let a_stage = a_scene
            .stages
            .iter()
            .find(|s| stage_ostim_id(s).as_deref() == Some("AIdle"))
            .unwrap();
        let b_stage = b_scene
            .stages
            .iter()
            .find(|s| stage_ostim_id(s).as_deref() == Some("BPose"))
            .unwrap();
        let dests = &a_scene.graph.get(&a_stage.id).unwrap().dest;
        assert!(
            dests.iter().any(|d| d.scene == b_scene.id && d.stage == b_stage.id),
            "AIdle should DestRef to BPose: {dests:?}"
        );
    }

    #[test]
    fn cast_mismatch_merges_cross_folder_components() {
        let mut raw = IndexMap::new();
        raw.insert(
            "Duo".into(),
            serde_json::json!({
                "name": "Duo", "length": 2,
                "speeds": [{ "animation": "DuoAnim" }],
                "actors": [{ "intendedSex": "male" }, { "intendedSex": "female" }],
                "actions": [],
                "navigations": [
                    { "destination": "Trio", "description": "Join", "priority": 1000 }
                ]
            }),
        );
        raw.insert(
            "Trio".into(),
            serde_json::json!({
                "name": "Trio", "length": 2,
                "speeds": [{ "animation": "TrioAnim" }],
                "actors": [
                    { "intendedSex": "male" },
                    { "intendedSex": "female" },
                    { "intendedSex": "female" }
                ],
                "actions": [],
                "navigations": []
            }),
        );
        let mut folders = HashMap::new();
        folders.insert("Duo".into(), "Two".into());
        folders.insert("Trio".into(), "Three".into());
        let edges = collect_edges(&raw);
        let (comps, merges) = folder_scoped_connected_components(
            raw.keys().cloned().collect(),
            &edges,
            &folders,
            &raw,
        );
        assert_eq!(merges, 1);
        assert_eq!(comps.len(), 1);
        assert_eq!(comps[0].len(), 2);
    }

    #[test]
    fn imports_real_mlc_pack_grouped() {
        let root = PathBuf::from(
            "/mnt/Data/Coding/Animations/OStim/Lovemaking Compendium for OStim Standalone",
        );
        if !root.exists() {
            return;
        }
        let (pack_name, _, scenes, summary) = import_ostim_scenes(&root).unwrap();
        assert!(
            summary.scenes_imported >= 10 && summary.scenes_imported < 80,
            "expected folder-scoped scenes, got {}",
            summary.scenes_imported
        );
        assert!(summary.nodes_grouped >= 300);
        assert!(summary.transitions_included > 100);
        assert!(
            summary.cross_scene_links > 0,
            "expected cross-folder DestRefs"
        );
        assert!(!pack_name.is_empty());
        let largest = scenes.values().max_by_key(|s| s.stages.len()).unwrap();
        assert!(largest.stages.len() > 5);
        assert!(
            largest.graph.values().any(|n| n.dest.len() > 1)
                || summary.cross_scene_links > 0,
            "expected branching or cross-scene links"
        );
        let max_stages = scenes.values().map(|s| s.stages.len()).max().unwrap_or(0);
        assert!(
            max_stages < 200,
            "folder split should avoid mega-scenes, largest={max_stages}"
        );
    }
}

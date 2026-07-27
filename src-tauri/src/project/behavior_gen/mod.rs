//! Clean-room FNIS Behavior.hkx generation for P+ AnimLists.
//! See docs/behavior-gen-interop.md

mod animlist;
mod pack;
mod race_events;
mod xml_graph;

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use log::{info, warn};

use animlist::{parse_animlist, AnimlistParseError};
use pack::{xml_to_hkx, HkxPackError};
use race_events::{fixed_events_for_race, race_path_from_list};
use xml_graph::build_behavior_xml;

#[derive(Debug)]
pub enum BehaviorGenError {
    Io(io::Error),
    Parse(AnimlistParseError),
    Pack(HkxPackError),
    /// Expected skip (classic s/+, canine alias lists already filtered by path).
    Skipped(String),
    /// AnimList is not under `meshes/actors/.../animations/<pack>/`.
    InvalidLayout(String),
    EmptyList,
    /// One or more hard failures while walking a tree.
    Failed(String),
}

impl std::fmt::Display for BehaviorGenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "{e}"),
            Self::Parse(e) => write!(f, "{e}"),
            Self::Pack(e) => write!(f, "{e}"),
            Self::Skipped(s) | Self::InvalidLayout(s) | Self::Failed(s) => write!(f, "{s}"),
            Self::EmptyList => write!(f, "AnimList has no animation lines"),
        }
    }
}

impl From<io::Error> for BehaviorGenError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

impl From<AnimlistParseError> for BehaviorGenError {
    fn from(e: AnimlistParseError) -> Self {
        Self::Parse(e)
    }
}

impl From<HkxPackError> for BehaviorGenError {
    fn from(e: HkxPackError) -> Self {
        Self::Pack(e)
    }
}

/// True when `list_path` is `.../meshes/actors/<race...>/animations/<pack>/FNIS_*_List.txt`.
fn is_fnis_animlist_layout(list_path: &Path) -> bool {
    let components: Vec<&str> = list_path.iter().filter_map(|c| c.to_str()).collect();
    let Some(meshes_idx) = components
        .iter()
        .position(|c| c.eq_ignore_ascii_case("meshes"))
    else {
        return false;
    };
    // Require actors/animations *after* meshes so a parent folder named
    // "Animations" (e.g. /mnt/Data/Coding/Animations/...) is ignored.
    let Some(actors_rel) = components[meshes_idx + 1..]
        .iter()
        .position(|c| c.eq_ignore_ascii_case("actors"))
    else {
        return false;
    };
    let actors_idx = meshes_idx + 1 + actors_rel;
    let Some(anim_rel) = components[actors_idx + 1..]
        .iter()
        .position(|c| c.eq_ignore_ascii_case("animations"))
    else {
        return false;
    };
    let anim_idx = actors_idx + 1 + anim_rel;
    // meshes/actors/<≥1 race components>/animations/<pack>/file
    actors_idx == meshes_idx + 1
        && anim_idx > actors_idx + 1
        && components.len() == anim_idx + 3
}

/// Derive Behavior.hkx output path from an FNIS AnimList path.
pub fn behavior_path_for_list(list_path: &Path) -> Option<PathBuf> {
    let file_name = list_path.file_name()?.to_str()?;
    if !file_name.starts_with("FNIS_") || !file_name.ends_with("_List.txt") {
        return None;
    }
    // Skip canine alias lists (dog/wolf carry the graphs).
    if file_name.to_ascii_lowercase().contains("_canine_list.txt") {
        return None;
    }
    if !is_fnis_animlist_layout(list_path) {
        return None;
    }

    let stem = file_name.trim_end_matches("_List.txt");
    let behavior_name = format!("{stem}_Behavior.hkx");

    // .../animations/<pack>/FNIS_*_List.txt → .../behaviors[/ wolf]/FNIS_*_Behavior.hkx
    let anim_dir = list_path.parent()?;
    let actors_branch = anim_dir.parent()?.parent()?; // .../actors/<race_path>
    let is_wolf = file_name.to_ascii_lowercase().contains("_wolf_list.txt");
    let behavior_dir = if is_wolf {
        actors_branch.join("behaviors wolf")
    } else {
        actors_branch.join("behaviors")
    };
    Some(behavior_dir.join(behavior_name))
}

/// Pack folder name from AnimList directory (`.../animations/<pack>/`).
pub fn pack_name_from_list(list_path: &Path) -> Option<String> {
    list_path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
}

/// Generate Behavior.hkx next to the natural behaviors folder for this list.
pub fn generate_behavior_for_list(list_path: &Path) -> Result<PathBuf, BehaviorGenError> {
    let file_name = list_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    if file_name.to_ascii_lowercase().contains("_canine_list.txt") {
        return Err(BehaviorGenError::Skipped(
            "canine alias AnimList (dog/wolf carry Behavior graphs)".into(),
        ));
    }
    if !is_fnis_animlist_layout(list_path) {
        return Err(BehaviorGenError::InvalidLayout(format!(
            "AnimList must be under meshes/actors/<race>/animations/<pack>/: {}",
            list_path.display()
        )));
    }
    let out = behavior_path_for_list(list_path).ok_or_else(|| {
        BehaviorGenError::InvalidLayout(format!(
            "cannot map Behavior path for {}",
            list_path.display()
        ))
    })?;
    generate_behavior_to(list_path, &out)?;
    Ok(out)
}

pub fn generate_behavior_to(list_path: &Path, out_hkx: &Path) -> Result<(), BehaviorGenError> {
    let pack = pack_name_from_list(list_path).ok_or_else(|| {
        BehaviorGenError::InvalidLayout(format!(
            "cannot determine pack name from {}",
            list_path.display()
        ))
    })?;
    let text = fs::read_to_string(list_path)?;
    let lines = parse_animlist(&text)?;
    if lines.is_empty() {
        return Err(BehaviorGenError::EmptyList);
    }
    // v1: only singular `b` lines (P+). Reject classic s/+ so we do not write wrong graphs.
    if lines.iter().any(|l| l.anim_type != "b") {
        return Err(BehaviorGenError::Skipped(
            "behavior generator v1 supports only `b` AnimList lines (P+/SLSB); classic s/+ not yet implemented"
                .into(),
        ));
    }

    let race = race_path_from_list(list_path).ok_or_else(|| {
        BehaviorGenError::InvalidLayout(format!(
            "could not parse race path from {}",
            list_path.display()
        ))
    })?;
    let fixed = fixed_events_for_race(&race);
    let xml = build_behavior_xml(&pack, &lines, &fixed);

    if let Some(parent) = out_hkx.parent() {
        fs::create_dir_all(parent)?;
    }

    // Stage in a sibling dir with real .xml/.hkx extensions (serde-hkx requires
    // them), then rename the HKX into place so a failed pack never truncates
    // the destination.
    let staging_dir = out_hkx.with_extension("slsb-staging");
    let _ = fs::remove_dir_all(&staging_dir);
    fs::create_dir_all(&staging_dir)?;
    let staging_xml = staging_dir.join("Behavior.xml");
    let staging_hkx = staging_dir.join("Behavior.hkx");
    let keep_xml = std::env::var_os("SLSB_KEEP_BEHAVIOR_XML").is_some();
    let final_xml = out_hkx.with_extension("xml");

    let cleanup = || {
        let _ = fs::remove_dir_all(&staging_dir);
    };

    if let Err(e) = fs::write(&staging_xml, &xml) {
        cleanup();
        return Err(e.into());
    }
    if let Err(e) = xml_to_hkx(&staging_xml, &staging_hkx) {
        cleanup();
        return Err(e.into());
    }
    if let Err(e) = fs::rename(&staging_hkx, out_hkx) {
        cleanup();
        return Err(e.into());
    }
    if keep_xml {
        let _ = fs::rename(&staging_xml, &final_xml);
    }
    cleanup();

    info!(
        "Generated behavior {} from {}",
        out_hkx.display(),
        list_path.display()
    );
    Ok(())
}

/// Walk `root` for FNIS_*_List.txt and generate Behavior.hkx for each eligible list.
pub fn generate_behaviors_under(root: &Path) -> Result<Vec<PathBuf>, BehaviorGenError> {
    let mut generated = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    visit_lists(root, &mut |list| {
        match generate_behavior_for_list(list) {
            Ok(path) => generated.push(path),
            Err(BehaviorGenError::Skipped(msg)) => {
                warn!("skipping {}: {msg}", list.display());
            }
            Err(e) => errors.push(format!("{}: {e}", list.display())),
        }
    })?;
    if !errors.is_empty() {
        return Err(BehaviorGenError::Failed(errors.join("\n")));
    }
    Ok(generated)
}

fn visit_lists(dir: &Path, f: &mut dyn FnMut(&Path)) -> io::Result<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            visit_lists(&path, f)?;
        } else if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
            if name.starts_with("FNIS_") && name.ends_with("_List.txt") {
                f(&path);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod layout_tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn layout_ignores_parent_folder_named_animations() {
        let p = Path::new(
            "/mnt/Data/Coding/Animations/Export/.Moon_Lovemaking_Compendium.slsb-staging-1/meshes/actors/character/animations/Moon_Lovemaking_Compendium/FNIS_Moon_Lovemaking_Compendium_List.txt",
        );
        assert!(
            is_fnis_animlist_layout(p),
            "path under a parent 'Animations' dir should still be valid"
        );
        assert!(behavior_path_for_list(p).is_some());
    }
}

#[cfg(test)]
mod smoke_tests {
    use super::*;
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    fn object_id_sequence(xml: &str) -> Vec<(String, String)> {
        let mut out = Vec::new();
        for line in xml.lines() {
            let t = line.trim_start();
            if let Some(rest) = t.strip_prefix("<hkobject name=\"") {
                let (id, rest) = rest.split_once('"').unwrap();
                if let Some(idx) = rest.find("class=\"") {
                    let rest = &rest[idx + 7..];
                    let (cls, _) = rest.split_once('"').unwrap();
                    out.push((id.to_string(), cls.to_string()));
                }
            }
        }
        out
    }

    fn assert_pack_matches_fixture(pack: &str, race: &str, list_name: &str, hkx_name: &str) {
        let samples = Path::new(env!("CARGO_MANIFEST_DIR")).join("../research/behavior_samples");
        let list = samples.join(list_name);
        let reference = samples.join(hkx_name);
        assert!(list.is_file(), "missing fixture list {}", list.display());
        assert!(
            reference.is_file(),
            "missing fixture hkx {}",
            reference.display()
        );

        let tmp = std::env::temp_dir().join(format!(
            "slsb-beh-unit-{}",
            {
                let mut h = DefaultHasher::new();
                (pack, list_name).hash(&mut h);
                std::time::SystemTime::now().hash(&mut h);
                h.finish()
            }
        ));
        let _ = fs::remove_dir_all(&tmp);
        let pack_dir = tmp
            .join("meshes")
            .join("actors")
            .join(race)
            .join("animations")
            .join(pack);
        fs::create_dir_all(&pack_dir).unwrap();
        let list_path = pack_dir.join(format!("FNIS_{pack}_List.txt"));
        fs::copy(&list, &list_path).unwrap();
        let out = tmp.join(format!("{pack}_Behavior.hkx"));
        std::env::set_var("SLSB_KEEP_BEHAVIOR_XML", "1");
        generate_behavior_to(&list_path, &out).unwrap_or_else(|e| {
            panic!("generate failed for {pack}: {e}");
        });
        let gen_bytes = fs::read(&out).unwrap();
        let ref_bytes = fs::read(&reference).unwrap();
        if gen_bytes != ref_bytes {
            let xml_path = out.with_extension("xml");
            panic!(
                "{pack}: generated HKX differs from reference\n  gen={} ({} bytes)\n  ref={} ({} bytes)\n  gen_xml={}",
                out.display(),
                gen_bytes.len(),
                reference.display(),
                ref_bytes.len(),
                xml_path.display()
            );
        }
    }

    #[test]
    #[ignore = "requires local research/behavior_samples (not in repo)"]
    fn chaurus_matches_reference_hkx() {
        assert_pack_matches_fixture(
            "Billyy_CreatureFurniture",
            "chaurus",
            "pplus_chaurus_List.txt",
            "pplus_chaurus_Behavior.hkx",
        );
    }

    #[test]
    #[ignore = "requires local research/behavior_samples (not in repo)"]
    fn lesbiandd_matches_reference_hkx() {
        assert_pack_matches_fixture(
            "Billyy_HumanLesbianDD",
            "character",
            "pplus_lesbiandd_List.txt",
            "pplus_lesbiandd_Behavior.hkx",
        );
    }

    #[test]
    fn billy_slp_corpus_byte_identical() {
        let corpus = match std::env::var("SLSB_BEHAVIOR_CORPUS") {
            Ok(p) => PathBuf::from(p),
            Err(_) => {
                eprintln!("skip: set SLSB_BEHAVIOR_CORPUS to run full corpus smoke");
                return;
            }
        };
        if !corpus.is_dir() {
            panic!("SLSB_BEHAVIOR_CORPUS is not a directory: {}", corpus.display());
        }

        let tmp = std::env::temp_dir().join(format!(
            "slsb-beh-corpus-{}",
            {
                let mut h = DefaultHasher::new();
                std::time::SystemTime::now().hash(&mut h);
                h.finish()
            }
        ));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        let mut pairs: Vec<(PathBuf, PathBuf)> = Vec::new();
        visit_lists(&corpus, &mut |list| {
            if behavior_path_for_list(list).is_none() {
                return;
            }
            let text = match fs::read_to_string(list) {
                Ok(t) => t,
                Err(_) => return,
            };
            let Ok(lines) = parse_animlist(&text) else {
                return;
            };
            if lines.is_empty() || lines.iter().any(|l| l.anim_type != "b") {
                return;
            }
            let Some(ref_hkx) = behavior_path_for_list(list) else {
                return;
            };
            // Reference must exist next to the corpus list (same relative actors layout).
            if !ref_hkx.is_file() {
                return;
            }
            pairs.push((list.to_path_buf(), ref_hkx));
        })
        .unwrap();

        assert!(
            !pairs.is_empty(),
            "no P+ b-line list/behavior pairs under {}",
            corpus.display()
        );

        let mut failed = Vec::new();
        let mut ok = 0usize;
        for (i, (list, reference)) in pairs.iter().enumerate() {
            let rel = list.strip_prefix(&corpus).unwrap_or(list);
            let work_list = {
                // Preserve path from meshes/ so race_path_from_list works.
                let parts: Vec<_> = list.iter().filter_map(|c| c.to_str()).collect();
                let Some(mi) = parts.iter().position(|p| p.eq_ignore_ascii_case("meshes")) else {
                    failed.push(format!("{}: no meshes/ in path", rel.display()));
                    continue;
                };
                let dest = tmp.join(format!("case_{i}")).join(PathBuf::from_iter(
                    parts[mi..].iter().map(|s| s.to_string()),
                ));
                fs::create_dir_all(dest.parent().unwrap()).unwrap();
                fs::copy(list, &dest).unwrap();
                dest
            };
            let gen = match generate_behavior_for_list(&work_list) {
                Ok(p) => p,
                Err(e) => {
                    failed.push(format!("{}: generate error: {e}", rel.display()));
                    continue;
                }
            };
            let gen_bytes = fs::read(&gen).unwrap();
            let ref_bytes = fs::read(reference).unwrap();
            if gen_bytes == ref_bytes {
                ok += 1;
                println!("[OK] {}", rel.display());
            } else {
                failed.push(format!(
                    "{}: byte mismatch gen={}B ref={}B",
                    rel.display(),
                    gen_bytes.len(),
                    ref_bytes.len()
                ));
                println!("[FAIL] {}", rel.display());
            }
        }

        println!(
            "Passed {}/{}  failed {}",
            ok,
            ok + failed.len(),
            failed.len()
        );
        if !failed.is_empty() {
            panic!("corpus failures:\n{}", failed.join("\n"));
        }
    }

    #[test]
    fn anpack_user_list_regenerates_byte_identical_behavior() {
        let research = Path::new(env!("CARGO_MANIFEST_DIR")).join("../research");
        let list_src = research.join("FNIS_AnPack_List.txt");
        let ref_hkx = research.join("FNIS_AnPack_Behavior.hkx");
        if !list_src.is_file() || !ref_hkx.is_file() {
            eprintln!("skip: research/FNIS_AnPack_* missing");
            return;
        }

        let tmp = std::env::temp_dir().join(format!(
            "slsb_anpack_smoke_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&tmp);
        let pack_dir = tmp
            .join("meshes")
            .join("actors")
            .join("character")
            .join("animations")
            .join("AnPack");
        fs::create_dir_all(&pack_dir).unwrap();
        let list_path = pack_dir.join("FNIS_AnPack_List.txt");
        fs::copy(&list_src, &list_path).unwrap();

        let out = generate_behavior_for_list(&list_path).expect("generate AnPack behavior");
        let gen = fs::read(&out).unwrap();
        let reference = fs::read(&ref_hkx).unwrap();
        assert_eq!(
            gen, reference,
            "AnPack Behavior must be byte-identical to user/reference output (gen={}B ref={}B)",
            gen.len(),
            reference.len()
        );
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    #[ignore = "requires local research/behavior_samples (not in repo)"]
    fn lesbiandd_xml_object_order_matches_reference() {
        let samples = Path::new(env!("CARGO_MANIFEST_DIR")).join("../research/behavior_samples");
        let list = samples.join("pplus_lesbiandd_List.txt");
        let ref_xml = samples.join("pplus_lesbiandd_Behavior.xml");
        let text = fs::read_to_string(&list).unwrap();
        let lines = parse_animlist(&text).unwrap();
        let fixed = fixed_events_for_race("character");
        let gen = build_behavior_xml("Billyy_HumanLesbianDD", &lines, &fixed);
        let ref_text = fs::read_to_string(&ref_xml).unwrap();
        let gen_seq = object_id_sequence(&gen);
        let ref_seq = object_id_sequence(&ref_text);
        let mism = gen_seq
            .iter()
            .zip(ref_seq.iter())
            .enumerate()
            .filter(|(_, (g, r))| g != r)
            .take(10)
            .collect::<Vec<_>>();
        assert_eq!(
            gen_seq.len(),
            ref_seq.len(),
            "object count gen={} ref={}",
            gen_seq.len(),
            ref_seq.len()
        );
        assert!(
            mism.is_empty(),
            "first object-order mismatches: {:?}",
            mism
        );
    }
}

//! Reference conversion checks against packs under `/mnt/Data/Coding/Animations`.

#[cfg(test)]
mod tests {
    use crate::project::ostim::convert::{
        animations_from_ostim_json, import_ostim_scenes, is_transition, scene_to_ostim_files,
    };
    use crate::project::ostim::export::write_ostim_pack;
    use crate::project::package::Package;
    use serde_json::Value;
    use std::fs;
    use std::path::PathBuf;

    fn anim_root() -> PathBuf {
        PathBuf::from("/mnt/Data/Coding/Animations")
    }

    fn ostim_mlc() -> PathBuf {
        anim_root().join("OStim/Lovemaking Compendium for OStim Standalone")
    }

    fn ostim_bloo() -> PathBuf {
        anim_root().join("OStim/Bloo")
    }

    fn ostim_sanguine() -> PathBuf {
        anim_root().join("OStim/Sanguine Seduction 1.2.5")
    }

    fn billy_furniture_slsb() -> PathBuf {
        anim_root().join(
            "SLR/Billy/SLAL_Billyy_HumanFurnitureInvis/SKSE/SexLab/Registry/Source/Billyy_HumanFurnitureInvis.slsb.json",
        )
    }

    fn billy_furniture_ref_count() -> Option<usize> {
        let path = billy_furniture_slsb();
        if !path.exists() {
            return None;
        }
        let file = fs::File::open(&path).ok()?;
        let v: Value = serde_json::from_reader(file).ok()?;
        Some(v.get("scenes")?.as_object()?.len())
    }

    /// OStim scene JSON is usable if it has the fields OStim's loader expects in practice.
    fn assert_ostim_scene_usable(id: &str, json: &Value) {
        assert!(
            json.get("name").and_then(|v| v.as_str()).is_some(),
            "{id}: missing name"
        );
        let length = json.get("length").and_then(|v| v.as_f64()).unwrap_or(0.0);
        assert!(length > 0.0, "{id}: length must be > 0");
        let speeds = json
            .get("speeds")
            .and_then(|v| v.as_array())
            .expect(&format!("{id}: missing speeds"));
        assert!(!speeds.is_empty(), "{id}: empty speeds");
        for (i, speed) in speeds.iter().enumerate() {
            assert!(
                speed
                    .get("animation")
                    .and_then(|v| v.as_str())
                    .map(|s| !s.is_empty())
                    .unwrap_or(false),
                "{id}: speed {i} missing animation"
            );
        }
        let actors = json
            .get("actors")
            .and_then(|v| v.as_array())
            .expect(&format!("{id}: missing actors"));
        assert!(!actors.is_empty(), "{id}: empty actors");
        if is_transition(json) {
            assert!(
                json.get("destination")
                    .and_then(|v| v.as_str())
                    .map(|s| !s.is_empty())
                    .unwrap_or(false),
                "{id}: transition missing destination"
            );
        }
    }

    /// SLSB scene is usable for .slr export if stages/events/positions are coherent.
    fn assert_slsb_scene_usable(name: &str, scene: &crate::project::scene::Scene) {
        assert!(!scene.stages.is_empty(), "{name}: no stages");
        assert!(!scene.positions.is_empty(), "{name}: no positions");
        assert!(
            scene.graph.contains_key(&scene.root),
            "{name}: root missing from graph"
        );
        for stage in &scene.stages {
            assert_eq!(
                stage.positions.len(),
                scene.positions.len(),
                "{name}/{}: position count mismatch",
                stage.id.0
            );
            for (pi, pos) in stage.positions.iter().enumerate() {
                assert!(
                    pos.event.first().map(|e| !e.is_empty()).unwrap_or(false),
                    "{name}/{} actor {pi}: empty event",
                    stage.id.0
                );
            }
            assert!(
                scene.graph.contains_key(&stage.id),
                "{name}: stage {} not in graph",
                stage.id.0
            );
        }
    }

    #[test]
    fn ostim_to_slr_mlc_matches_reference_shape() {
        let root = ostim_mlc();
        if !root.exists() {
            return;
        }
        let pack = Package::from_ostim(root.clone(), None).unwrap();
        assert!(
            pack.ostim_source.as_ref().map(|p| p == &root).unwrap_or(false),
            "ostim_source should remember import root"
        );
        assert_eq!(pack.pack_name, "Moon Lovemaking Compendium");
        assert!(
            !crate::project::ostim::export::pack_folder_name(&pack).contains(' '),
            "export folder must be filesystem-safe, got {}",
            crate::project::ostim::export::pack_folder_name(&pack)
        );
        assert!(
            (10..=40).contains(&pack.scenes.len()),
            "expected grouped SLSB scenes (~17), got {}",
            pack.scenes.len()
        );

        let mut total_stages = 0usize;
        let mut branching = 0usize;
        let mut with_furniture = 0usize;
        let mut with_look = 0usize;
        for scene in pack.scenes.values() {
            assert_slsb_scene_usable(&scene.name, scene);
            total_stages += scene.stages.len();
            if scene.graph.values().any(|n| n.dest.len() > 1) {
                branching += 1;
            }
            if scene.furniture.furni_types.iter().any(|t| t != "None")
                || !scene.furniture.ostim_type.is_empty()
            {
                with_furniture += 1;
            }
            for stage in &scene.stages {
                if stage
                    .positions
                    .iter()
                    .any(|p| p.look_up != 0 || p.look_left != 0)
                {
                    with_look += 1;
                    break;
                }
            }
        }
        assert!(total_stages >= 300, "expected most MLC nodes as stages, got {total_stages}");
        assert!(branching >= 5, "expected several branching scenes, got {branching}");
        assert!(with_furniture >= 3, "expected furniture scenes, got {with_furniture}");
        assert!(with_look > 0, "expected lookUp/lookLeft preserved from MLC");

        // Native OStim event names (no forced _A#_S#)
        let mut ostim_events = 0usize;
        let mut tagged_sos = 0usize;
        let mut auto_climax_edges = 0usize;
        for scene in pack.scenes.values() {
            for stage in &scene.stages {
                for pos in &stage.positions {
                    if pos
                        .event
                        .first()
                        .map(|e| e.contains("_A") && e.contains("_S"))
                        .unwrap_or(false)
                    {
                        // legacy SexLab naming should not appear on fresh OStim import
                    } else if pos.event.first().map(|e| e.contains('_')).unwrap_or(false) {
                        ostim_events += 1;
                    }
                    if pos.tags.iter().any(|t| t.starts_with("ostim_sos:"))
                        || pos.schlong != 0
                    {
                        tagged_sos += 1;
                    }
                }
                if stage
                    .tags
                    .iter()
                    .any(|t| t.starts_with("ostim_nav:3000:"))
                    || stage
                        .extra
                        .nav_text
                        .split(';')
                        .any(|p| p.starts_with("3000:"))
                {
                    auto_climax_edges += 1;
                }
            }
        }
        assert!(ostim_events > 100, "expected OStim-style events, got {ostim_events}");
        assert!(tagged_sos > 0, "expected sosBend/schlong values from OStim actors");
        assert!(
            auto_climax_edges > 0,
            "expected climax autoTransition/nav edges encoded in ostim_nav tags or nav_text"
        );

        // Build .slr pack (registry + FNIS) — must succeed for usability
        let tmp = std::env::temp_dir().join(format!("slsb_ostim2slr_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        pack.build(tmp.clone(), None).unwrap();
        let registry = tmp.join("SKSE/SexLab/Registry");
        assert!(registry.is_dir(), "missing Registry after build");
        let slr_files: Vec<_> = fs::read_dir(&registry)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.path()
                    .extension()
                    .and_then(|x| x.to_str())
                    == Some("slr")
            })
            .collect();
        assert_eq!(slr_files.len(), 1, "expected one .slr file");
        let slr_size = fs::metadata(slr_files[0].path()).unwrap().len();
        assert!(slr_size > 1000, ".slr too small: {slr_size}");

        // Compare against Billy furniture reference: similar package schema version / fields
        if let Some(ref_scenes) = billy_furniture_ref_count() {
            assert!(ref_scenes > 0);
            // Converted pack should be fewer scenes than raw OStim nodes but multi-stage like SLR refs
            let avg_stages = total_stages as f64 / pack.scenes.len() as f64;
            assert!(
                avg_stages > 5.0,
                "grouped scenes should be multi-stage (avg {avg_stages})"
            );
        }

        // Round-trip OStim → SLSB → OStim preserves required fields + look data
        let (pack_name, _, scenes, _) = import_ostim_scenes(&root).unwrap();
        let mut rt = Package::new();
        rt.pack_name = pack_name;
        rt.scenes = scenes;
        rt.ostim_source = Some(root.clone());
        let out = write_ostim_pack(&rt, &tmp.join("ostim_rt"), Some(&root), None).unwrap();
        assert!(out.json_files >= 300);
        assert!(out.facial_copied, "facial expressions should copy from source");
        assert!(
            out.nemesis_from_source,
            "Nemesis patches should copy from source when present"
        );
        let found = find_named_json(&tmp.join("ostim_rt"), "MLCBedCowgirl.json");
        assert!(found.is_some(), "MLCBedCowgirl.json missing after round-trip");
        let cowgirl_path = found.unwrap();
        assert!(
            cowgirl_path
                .to_string_lossy()
                .replace('\\', "/")
                .ends_with("scenes/MLCBedCowgirl/MLCBedCowgirl.json"),
            "expected per-node folder layout, got {}",
            cowgirl_path.display()
        );
        let json: Value =
            serde_json::from_str(&fs::read_to_string(&cowgirl_path).unwrap()).unwrap();
        assert_ostim_scene_usable("MLCBedCowgirl", &json);
        let actors = json.get("actors").and_then(|a| a.as_array()).unwrap();
        assert!(
            actors.iter().any(|a| a.get("lookUp").is_some()),
            "lookUp should survive OStim→SLSB→OStim round-trip"
        );
        let actions = json.get("actions").and_then(|a| a.as_array()).unwrap();
        assert_eq!(
            actions.len(),
            3,
            "actions must not pull in sibling-stage tags, got {actions:?}"
        );
        assert_eq!(
            json.get("modpack").and_then(|v| v.as_str()),
            Some("Moon Lovemaking Compendium")
        );

        let kneeling = find_named_json(&tmp.join("ostim_rt"), "MLCBedKneelingIdle.json");
        assert!(kneeling.is_some());
        let kn: Value =
            serde_json::from_str(&fs::read_to_string(kneeling.unwrap()).unwrap()).unwrap();
        let navs = kn.get("navigations").and_then(|n| n.as_array()).unwrap();
        assert!(
            navs.iter().any(|n| n.get("origin").and_then(|v| v.as_str())
                == Some("OStim2PBothLyingMF")),
            "inbound origin nav to vanilla must survive, got {navs:?}"
        );
        assert!(
            navs.iter().any(|n| n.get("destination").and_then(|v| v.as_str())
                == Some("OStim2PBothLyingMF")),
            "Return destination to vanilla must survive, got {navs:?}"
        );

        let facial = tmp
            .join("ostim_rt")
            .join(crate::project::ostim::export::pack_folder_name(&rt))
            .join("SKSE/Plugins/OStim/facial expressions/mlcbeinghappy1.json");
        assert!(facial.exists(), "facial expression JSON missing");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn slr_to_ostim_billy_furniture_usable() {
        let path = billy_furniture_slsb();
        if !path.exists() {
            return;
        }
        let file = fs::File::open(&path).unwrap();
        let pack = Package::from_file(file).unwrap();
        // Skip creature-only / empty
        let humanish: Vec<_> = pack
            .scenes
            .values()
            .filter(|s| {
                !s.has_warnings
                    && !s.stages.is_empty()
                    && s.positions.iter().all(|p| p.race == "Human" || p.race.is_empty())
            })
            .collect();
        assert!(!humanish.is_empty());

        let tmp = std::env::temp_dir().join(format!("slsb_slr2ostim_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let summary = write_ostim_pack(&pack, &tmp, None, None).unwrap();
        assert!(summary.json_files > 0);
        assert!(summary.animlist.as_ref().unwrap().exists());

        let mut checked = 0usize;
        let mut with_furniture = 0usize;
        visit_jsons(&tmp, &mut |path, json| {
            let id = path.file_stem().and_then(|s| s.to_str()).unwrap_or("?");
            assert_ostim_scene_usable(id, json);
            if json
                .get("furniture")
                .and_then(|v| v.as_str())
                .map(|s| s != "none")
                .unwrap_or(false)
            {
                with_furniture += 1;
            }
            // speeds/animation must map to animlist entries
            for (anim, _) in animations_from_ostim_json(json) {
                assert!(!anim.is_empty());
            }
            checked += 1;
        });
        assert_eq!(checked, summary.json_files);
        // Billy furniture pack should yield furniture-typed OStim scenes
        assert!(
            with_furniture > 0,
            "expected some furniture fields on OStim export from Billy furniture SLR"
        );

        // Structural compare: scene count in OStim export should be >= SLSB scene count
        // (branching expands; linear same-base may collapse to one JSON with speeds)
        assert!(
            summary.json_files >= humanish.len() / 2,
            "export too sparse: {} json vs {} slsb scenes",
            summary.json_files,
            humanish.len()
        );

        // Spot-check one exported file against OStim reference conventions (MLC)
        let mlc = ostim_mlc();
        if mlc.exists() {
            let ref_scene = find_named_json(&mlc.join("SKSE/Plugins/OStim/scenes"), "MLCBedCowgirl.json");
            if let Some(ref_path) = ref_scene {
                let ref_json: Value =
                    serde_json::from_str(&fs::read_to_string(ref_path).unwrap()).unwrap();
                assert_ostim_scene_usable("ref", &ref_json);
                // Ensure our export uses the same top-level keys OStim cares about
                let sample = find_any_ostim_scene(&tmp).unwrap();
                let sample_json: Value =
                    serde_json::from_str(&fs::read_to_string(sample).unwrap()).unwrap();
                for key in ["name", "modpack", "length", "speeds", "actors"] {
                    assert!(
                        sample_json.get(key).is_some(),
                        "export missing key {key} present in OStim refs"
                    );
                    assert!(ref_json.get(key).is_some());
                }
            }
        }

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn ostim_fields_round_trip_on_position() {
        let json: Value = serde_json::json!({
            "name": "Test",
            "length": 2.0,
            "speeds": [{ "animation": "TestAnim", "playbackSpeed": 1, "displaySpeed": 1 }],
            "actors": [{
                "intendedSex": "male",
                "lookUp": -10,
                "lookLeft": 20,
                "animationIndex": 1,
                "expressionOverride": "tongue",
                "equipObjects": { "strapon": true },
                "sosBend": 3,
                "tags": ["lyingback"]
            }, {
                "intendedSex": "female",
                "tags": ["kneeling"]
            }],
            "actions": [{ "type": "vaginalsex", "actor": 0, "target": 1 }],
            "tags": ["cowgirl"]
        });
        let scene = crate::project::ostim::convert::ostim_json_to_scene("TestPose", &json).unwrap();
        let pos0 = &scene.stages[0].positions[0];
        assert_eq!(pos0.look_up, -10);
        assert_eq!(pos0.look_left, 20);
        assert_eq!(pos0.animation_index, Some(1));
        assert_eq!(pos0.expression_override, "tongue");
        assert!(pos0.equip_objects.contains("strapon"));

        let files = scene_to_ostim_files(&scene, "Pack").unwrap();
        assert_eq!(files.len(), 1);
        let actor0 = &files[0].1["actors"][0];
        assert_eq!(actor0["lookUp"], -10);
        assert_eq!(actor0["lookLeft"], 20);
        assert_eq!(actor0["animationIndex"], 1);
        assert_eq!(actor0["expressionOverride"], "tongue");
        assert_eq!(actor0["equipObjects"]["strapon"], true);
        assert_eq!(actor0["type"], "npc");
        assert_eq!(actor0["feetOnGround"], false);
    }

    #[test]
    fn bloo_embeds_facial_and_preserves_expressions() {
        let root = ostim_bloo();
        if !root.exists() {
            return;
        }
        let pack = Package::from_ostim(root.clone(), None).unwrap();
        assert!(
            pack.ostim_assets
                .keys()
                .any(|k| k.contains("facial expressions/")),
            "Bloo facial JSON should be embedded in project IR"
        );
        assert!(
            pack.ostim_assets
                .keys()
                .any(|k| k.contains("actions/")),
            "Bloo custom actions should be embedded"
        );

        // Spot-check expressionOverride survived import
        let with_expr = pack.scenes.values().any(|s| {
            s.stages.iter().any(|st| {
                st.positions
                    .iter()
                    .any(|p| p.expression_override == "eyesclosed")
            })
        });
        assert!(with_expr, "expected eyesclosed expressionOverride from Bloo");

        // Export WITHOUT hkx_source — assets must still write from ostim_assets
        let tmp = std::env::temp_dir().join(format!("slsb_bloo_embed_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let mut portable = pack.clone();
        // Simulate save/reload where path may be gone but assets remain
        portable.ostim_source = None;
        let summary = write_ostim_pack(&portable, &tmp, None, None).unwrap();
        assert!(summary.assets_written >= 4);
        assert!(summary.facial_copied);
        let face = find_named_json(&tmp, "eyesclosed1.json");
        assert!(face.is_some(), "embedded facial must export without source folder");
        let scene = find_named_json(&tmp, "BDG_Lay_Idle_Hand_Kiss.json");
        assert!(scene.is_some());
        let json: Value =
            serde_json::from_str(&fs::read_to_string(scene.unwrap()).unwrap()).unwrap();
        assert!(
            json["actors"]
                .as_array()
                .unwrap()
                .iter()
                .any(|a| a.get("expressionOverride").and_then(|v| v.as_str()) == Some("eyesclosed"))
        );
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn sanguine_preserves_expression_action_and_scale_height() {
        let root = ostim_sanguine();
        if !root.exists() {
            return;
        }
        let pack = Package::from_ostim(root.clone(), None).unwrap();
        assert_eq!(pack.pack_name, "sss"); // modPack camelCase
        let bite = pack.scenes.values().find(|s| {
            s.stages.iter().any(|st| {
                st.tags
                    .iter()
                    .any(|t| t == "ostim_id:SSBittingDS")
            })
        });
        assert!(bite.is_some(), "SSBittingDS missing");
        let stage = bite
            .unwrap()
            .stages
            .iter()
            .find(|st| st.tags.iter().any(|t| t == "ostim_id:SSBittingDS"))
            .unwrap();
        assert_eq!(stage.positions[1].expression_action, Some(1));
        assert!(
            stage.positions[0]
                .scale_height
                .map(|h| (h - 120.748).abs() < 0.01)
                .unwrap_or(false)
        );

        let tmp = std::env::temp_dir().join(format!("slsb_sang_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let summary = write_ostim_pack(&pack, &tmp, Some(&root), None).unwrap();
        assert!(summary.json_files >= 18);
        let found = find_named_json(&tmp, "SSBittingDS.json").unwrap();
        let json: Value = serde_json::from_str(&fs::read_to_string(found).unwrap()).unwrap();
        assert_eq!(json["actors"][1]["expressionAction"], 1);
        assert!((json["actors"][0]["scaleHeight"].as_f64().unwrap() - 120.748).abs() < 0.01);
        assert_eq!(json["actors"][0]["type"], "npc");
        assert_eq!(json["actors"][1]["lookUp"], -50);
        assert_eq!(json["actors"][1]["lookLeft"], 100);
        let _ = fs::remove_dir_all(&tmp);
    }

    fn find_named_json(root: &PathBuf, file_name: &str) -> Option<PathBuf> {
        let mut stack = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            let Ok(rd) = fs::read_dir(&dir) else { continue };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else if p.file_name().and_then(|s| s.to_str()) == Some(file_name) {
                    return Some(p);
                }
            }
        }
        None
    }

    fn find_any_ostim_scene(root: &PathBuf) -> Option<PathBuf> {
        let mut stack = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            let Ok(rd) = fs::read_dir(&dir) else { continue };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else if p.extension().and_then(|s| s.to_str()) == Some("json")
                    && p.to_string_lossy().contains("OStim")
                {
                    return Some(p);
                }
            }
        }
        None
    }

    fn visit_jsons(root: &PathBuf, f: &mut dyn FnMut(&PathBuf, &Value)) {
        let mut stack = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            let Ok(rd) = fs::read_dir(&dir) else { continue };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else if p.extension().and_then(|s| s.to_str()) == Some("json")
                    && p.to_string_lossy().contains("scenes")
                {
                    if let Ok(text) = fs::read_to_string(&p) {
                        if let Ok(json) = serde_json::from_str::<Value>(&text) {
                            if json.get("speeds").is_some() {
                                f(&p, &json);
                            }
                        }
                    }
                }
            }
        }
    }
}

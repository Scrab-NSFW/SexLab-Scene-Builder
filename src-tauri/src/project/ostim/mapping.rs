//! Furniture and tag↔action vocabulary bridges between SLSB/SLR and OStim.

/// Map an OStim furniture type string to SLSB `furni_types` (+ allow_bed).
pub fn ostim_furniture_to_slsb(furniture: &str) -> (Vec<String>, bool) {
    let key = furniture.trim().to_ascii_lowercase();
    if key.is_empty() || key == "none" {
        return (vec!["None".into()], false);
    }
    let (types, allow_bed) = match key.as_str() {
        "bed" => (vec!["BedSingle", "BedDouble", "BedRoll"], true),
        "singlebed" => (vec!["BedSingle"], true),
        "doublebed" => (vec!["BedDouble"], true),
        "bedroll" => (vec!["BedRoll"], true),
        "wall" => (vec!["Wall"], false),
        "table" => (vec!["Table"], false),
        "tableleanmarker" | "tableleanmarkerbbls" | "counter" | "tablecounter" => {
            (vec!["Table", "TableCounter"], false)
        }
        "bench" | "couch" | "sofa" => (vec!["Bench", "BenchMisc"], false),
        "chair" | "stool" => (vec!["Chair", "ChairCommon", "ChairMisc"], false),
        "shelf" | "wardrobe" | "wardrobethick" | "wardrobethin" | "railing" => {
            (vec!["Railing"], false)
        }
        "cookingpot" => (vec!["CraftCookingPot"], false),
        "alchemytable" => (vec!["CraftAlchemy"], false),
        "enchantingtable" => (vec!["CraftEnchanting"], false),
        "throne" => (vec!["Throne", "ThroneNordic"], false),
        "xcross" | "cross" => (vec!["XCross"], false),
        unknown if !unknown.is_empty() && unknown != "none" => {
            // Keep ostim_type on the scene; SexLab gets None until mapped.
            (vec!["None"], false)
        }
        _ => (vec!["None"], false),
    };
    (
        types.into_iter().map(str::to_string).collect(),
        allow_bed,
    )
}

/// Map SLSB `furni_types` to a single OStim furniture id (best effort).
pub fn slsb_furniture_to_ostim(furni_types: &[String], allow_bed: bool) -> String {
    let lower: Vec<String> = furni_types
        .iter()
        .map(|t| t.to_ascii_lowercase())
        .collect();
    let has = |keys: &[&str]| lower.iter().any(|t| keys.iter().any(|k| t == k));

    if has(&["beddouble"]) {
        return "doublebed".into();
    }
    if has(&["bedsingle"]) {
        return "singlebed".into();
    }
    if has(&["bedroll"]) {
        return "bedroll".into();
    }
    if allow_bed || has(&["bedsingle", "beddouble", "bedroll"]) {
        return "bed".into();
    }
    if has(&["wall"]) {
        return "wall".into();
    }
    if has(&["tablecounter"]) {
        return "tableleanmarker".into();
    }
    if has(&["table"]) {
        return "table".into();
    }
    if has(&["bench", "benchnoble", "benchmisc"]) {
        return "bench".into();
    }
    if has(&[
        "chair",
        "chaircommon",
        "chairwood",
        "chairbar",
        "chairnoble",
        "chairmisc",
        "throne",
        "throneriften",
        "thronenordic",
    ]) {
        return "chair".into();
    }
    if has(&["craftcookingpot"]) {
        return "cookingpot".into();
    }
    if has(&["craftalchemy"]) {
        return "alchemytable".into();
    }
    if has(&["craftenchanting"]) {
        return "enchantingtable".into();
    }
    if has(&["railing"]) {
        return "shelf".into();
    }
    "none".into()
}

/// OStim action type → SexLab-style tags to add on import.
pub fn action_to_tags(action_type: &str) -> Vec<&'static str> {
    match action_type.trim().to_ascii_lowercase().as_str() {
        "vaginalsex" => vec!["Vaginal", "Sex"],
        "analsex" | "analtailsex" => vec!["Anal", "Sex"],
        "blowjob" | "deepthroating" => vec!["Oral", "Blowjob", "Sex"],
        "handjob" => vec!["Handjob", "Sex"],
        "boobjob" | "breastsliding" => vec!["Boobjob", "Sex"],
        "footjob" => vec!["Footjob", "Sex"],
        "buttjob" => vec!["Buttjob", "Sex"],
        "cunnilingus" | "clitoraleating" | "clitorallicking" | "clitoralrubbing" => {
            vec!["Cunnilingus", "Oral", "Sex"]
        }
        "anallicking" => vec!["Anal", "Oral", "Sex"],
        "kissing" | "frenchkissing" | "kissingneck" | "kissingcheek" => vec!["Kissing"],
        "hugging" | "cuddling" | "holdingbody" | "holdinghip" | "holdinghand" => {
            vec!["Loving"]
        }
        "malemasturbation" | "femalemasturbation" => vec!["Masturbation"],
        "grindingpenis" | "grindingthigh" | "grindingobject" | "grindingfoot" => {
            vec!["Grinding", "Sex"]
        }
        "facial" | "cumonchest" | "cumonbutt" | "cumonvulva" => vec!["Cumshot"],
        "mounting" => vec![],
        other if !other.is_empty() => vec![],
        _ => vec![],
    }
}

/// SexLab-style tag → OStim action type (best effort).
pub fn tag_to_action(tag: &str) -> Option<&'static str> {
    match tag.trim().to_ascii_lowercase().as_str() {
        "vaginal" | "pvaginal" | "avaginal" => Some("vaginalsex"),
        "anal" | "panal" | "aanal" => Some("analsex"),
        "blowjob" | "oral" | "bj" => Some("blowjob"),
        "handjob" | "hj" => Some("handjob"),
        "boobjob" | "titjob" => Some("boobjob"),
        "footjob" | "fj" => Some("footjob"),
        "cunnilingus" => Some("clitorallicking"),
        "kissing" | "kiss" => Some("kissing"),
        "loving" | "hugging" => Some("hugging"),
        "masturbation" => Some("femalemasturbation"),
        "grinding" => Some("grindingpenis"),
        "cumshot" | "facial" => Some("facial"),
        _ => None,
    }
}

/// Build OStim `actions` from SLSB scene/stage tags (prefers `action:type:a:t:p`).
pub fn tags_to_actions(tags: &[String], actor_count: usize) -> Vec<serde_json::Value> {
    let mut seen = std::collections::HashSet::new();
    let mut from_explicit = Vec::new();
    let mut from_soft = Vec::new();
    for tag in tags {
        if let Some(rest) = tag.strip_prefix("action:") {
            let parts: Vec<&str> = rest.split(':').collect();
            if parts.is_empty() || parts[0].is_empty() {
                continue;
            }
            let action_type = parts[0];
            if !seen.insert(action_type.to_string()) {
                continue;
            }
            let (actor, target, performer) = if parts.len() >= 4 {
                (
                    parts[1].parse().unwrap_or(0),
                    parts[2].parse().unwrap_or(0),
                    parts[3].parse().unwrap_or(0),
                )
            } else {
                default_action_roles(action_type, actor_count)
            };
            let mut obj = serde_json::json!({
                "type": action_type,
                "actor": actor,
            });
            if target != actor {
                obj["target"] = serde_json::json!(target);
            }
            if performer != actor {
                obj["performer"] = serde_json::json!(performer);
            }
            from_explicit.push(obj);
            continue;
        }
        let Some(action_type) = tag_to_action(tag) else {
            continue;
        };
        // Soft SexLab tags (e.g. Loving ← holdingbody) only apply when no
        // explicit action: records exist — otherwise they invent duplicates.
        from_soft.push((action_type, tag.clone()));
    }

    if !from_explicit.is_empty() {
        return from_explicit;
    }

    seen.clear();
    let mut actions = Vec::new();
    for (action_type, _) in from_soft {
        if !seen.insert(action_type.to_string()) {
            continue;
        }
        let (actor, target, performer) = default_action_roles(action_type, actor_count);
        let mut obj = serde_json::json!({
            "type": action_type,
            "actor": actor,
        });
        if target != actor {
            obj["target"] = serde_json::json!(target);
        }
        if performer != actor {
            obj["performer"] = serde_json::json!(performer);
        }
        actions.push(obj);
    }
    actions
}

/// Infer SexLab race key from OStim actor / scene hints.
pub fn infer_race_key(actor: &serde_json::Value, scene_tags: &[String]) -> String {
    for key in ["race", "raceKey", "racekey"] {
        if let Some(r) = actor.get(key).and_then(|v| v.as_str()) {
            let mapped = normalize_race_hint(r);
            if !mapped.is_empty() {
                return mapped;
            }
        }
    }
    let mut hints: Vec<String> = actor
        .get("tags")
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| t.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    hints.extend(scene_tags.iter().cloned());
    for hint in &hints {
        let mapped = normalize_race_hint(hint);
        if mapped != "Human" && !mapped.is_empty() {
            return mapped;
        }
    }
    "Human".into()
}

fn normalize_race_hint(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "" | "human" | "humans" | "npc" => "Human".into(),
        "wolf" | "wolves" => "Wolf".into(),
        "dog" | "dogs" | "canine" => "Dog".into(),
        "horse" | "horses" => "Horse".into(),
        "draugr" => "Draugr".into(),
        "falmer" => "Falmer".into(),
        "spider" | "frostbitespider" => "Spider".into(),
        "chaurus" => "Chaurus".into(),
        "bear" => "Bear".into(),
        "troll" => "Troll".into(),
        "giant" => "Giant".into(),
        _ => {
            // Accept already-canonical SexLab race keys case-insensitively.
            for key in crate::racekeys::get_race_keys_string() {
                if key.eq_ignore_ascii_case(raw.trim()) {
                    return key;
                }
            }
            "Human".into()
        }
    }
}

fn default_action_roles(action_type: &str, actor_count: usize) -> (usize, usize, usize) {
    if actor_count < 2 {
        return (0, 0, 0);
    }
    match action_type {
        "vaginalsex" | "analsex" | "analtailsex" => (0, 1, 1),
        "blowjob" | "deepthroating" | "handjob" | "boobjob" | "footjob" | "buttjob" => {
            (1, 0, 1)
        }
        "clitorallicking" | "clitoraleating" | "cunnilingus" => (0, 1, 0),
        "hugging" | "kissing" | "cuddling" => (0, 1, 0),
        "facial" | "cumonchest" | "cumonbutt" | "cumonvulva" => (0, 1, 0),
        _ => (0, 1, 0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn furniture_round_trip_common() {
        let (types, allow) = ostim_furniture_to_slsb("singlebed");
        assert!(allow);
        assert_eq!(slsb_furniture_to_ostim(&types, allow), "singlebed");

        let (types, allow) = ostim_furniture_to_slsb("wall");
        assert_eq!(slsb_furniture_to_ostim(&types, allow), "wall");
    }

    #[test]
    fn action_tag_bridge() {
        assert!(action_to_tags("vaginalsex").contains(&"Vaginal"));
        assert_eq!(tag_to_action("Vaginal"), Some("vaginalsex"));
        let actions = tags_to_actions(
            &["action:vaginalsex:0:1:1".into(), "Blowjob".into()],
            2,
        );
        // Explicit action: wins; soft tags must not invent extras (Loving→hugging etc.).
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0]["type"], "vaginalsex");
        assert_eq!(actions[0]["actor"], 0);
        assert_eq!(actions[0]["target"], 1);
        assert_eq!(actions[0]["performer"], 1);

        let soft_only = tags_to_actions(&["Blowjob".into(), "Loving".into()], 2);
        assert_eq!(soft_only.len(), 2);
        assert_eq!(soft_only[0]["type"], "blowjob");
        assert_eq!(soft_only[1]["type"], "hugging");
    }

    #[test]
    fn race_inference() {
        let actor = serde_json::json!({ "tags": ["wolf"] });
        assert_eq!(infer_race_key(&actor, &[]), "Wolf");
        let human = serde_json::json!({ "intendedSex": "female" });
        assert_eq!(infer_race_key(&human, &[]), "Human");
    }
}

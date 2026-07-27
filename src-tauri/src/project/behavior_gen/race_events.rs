//! Race-specific FNIS fixed event names (indices 0–10).
//!
//! Observed from shipped `FNIS_*_Behavior.hkx` under SLAL Packs (Billy SLP).
//! Events 2–10 are identical across races; 0 (and rarely 1) come from the
//! vanilla race behavior default/unequip event names FNIS embeds.

const EVENTS_2_TO_10: &[&str] = &[
    "AnimObjLoad",
    "AnimObjDraw",
    "HeadTrackingOff",
    "HeadTrackingOn",
    "StartAnimatedCamera",
    "EndAnimatedCamera",
    "IdleChairSitting",
    "IdleChairGetUp",
    "FNISreserve1",
];

/// Build the 11 fixed event names for a race folder under `meshes/actors/`.
///
/// `race_path` uses forward slashes, e.g. `character`, `chaurus`, `dlc02/scrib`.
pub fn fixed_events_for_race(race_path: &str) -> [&'static str; 11] {
    let (e0, e1) = event0_and_unequip(race_path);
    [
        e0,
        e1,
        EVENTS_2_TO_10[0],
        EVENTS_2_TO_10[1],
        EVENTS_2_TO_10[2],
        EVENTS_2_TO_10[3],
        EVENTS_2_TO_10[4],
        EVENTS_2_TO_10[5],
        EVENTS_2_TO_10[6],
        EVENTS_2_TO_10[7],
        EVENTS_2_TO_10[8],
    ]
}

fn event0_and_unequip(race_path: &str) -> (&'static str, &'static str) {
    let race = race_path.trim_matches('/').to_ascii_lowercase();
    // Event 1 is AnimObjectUnequip except draugr/falmer (FNIS embeds "1").
    let unequip = match race.as_str() {
        "draugr" | "falmer" => "1",
        _ => "AnimObjectUnequip",
    };
    let e0 = match race.as_str() {
        "character" => "IdleForceDefaultState",
        "chaurus" | "dwarvenspider" => "FNISDefault",
        "dragon" => "Reset",
        "frostbitespider" => "ReturnToDefault",
        "ambient/hare" | "slaughterfish" => "ReturnDefaultState",
        "vampirelord" | "werewolfbeast" => "idleReturnToDefault",
        // Furniture / centurion-style
        "draugr"
        | "dlc02/dwarvenballistacenturion"
        | "dwarvenspherecenturion"
        | "dwarvensteamcenturion"
        | "dlc02/hmdaedra" => "forceFurnExit",
        // Default for the majority of creature races in the Billy corpus
        _ => "returnToDefault",
    };
    (e0, unequip)
}

/// Derive `actors/<race_path>` from an AnimList path.
pub fn race_path_from_list(list_path: &std::path::Path) -> Option<String> {
    // .../meshes/actors/<race_path>/animations/<pack>/FNIS_*_List.txt
    let components: Vec<&str> = list_path.iter().filter_map(|c| c.to_str()).collect();
    let meshes_idx = components
        .iter()
        .position(|c| c.eq_ignore_ascii_case("meshes"))?;
    let actors_rel = components[meshes_idx + 1..]
        .iter()
        .position(|c| c.eq_ignore_ascii_case("actors"))?;
    let actors_idx = meshes_idx + 1 + actors_rel;
    let anim_rel = components[actors_idx + 1..]
        .iter()
        .position(|c| c.eq_ignore_ascii_case("animations"))?;
    let anim_idx = actors_idx + 1 + anim_rel;
    if actors_idx != meshes_idx + 1 || anim_idx <= actors_idx + 1 {
        return None;
    }
    Some(components[actors_idx + 1..anim_idx].join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn character_and_chaurus_event0() {
        assert_eq!(fixed_events_for_race("character")[0], "IdleForceDefaultState");
        assert_eq!(fixed_events_for_race("chaurus")[0], "FNISDefault");
        assert_eq!(fixed_events_for_race("bear")[0], "returnToDefault");
        assert_eq!(fixed_events_for_race("draugr")[1], "1");
    }

    #[test]
    fn race_path_extraction() {
        let p = Path::new(
            "/x/meshes/actors/dlc02/scrib/animations/Pack/FNIS_Pack_scrib_List.txt",
        );
        assert_eq!(race_path_from_list(p).as_deref(), Some("dlc02/scrib"));
        // Parent folder named "Animations" must not steal the match.
        let p2 = Path::new(
            "/mnt/Data/Coding/Animations/Export/pack/meshes/actors/character/animations/Pack/FNIS_Pack_List.txt",
        );
        assert_eq!(race_path_from_list(p2).as_deref(), Some("character"));
    }
}

use log::warn;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::{
    define::{FurnitureData, Node},
    position_info::PositionInfo,
    serialize::EncodeBinary,
    stage::Stage,
    NanoID,
};

fn normalize_graph_scenes(graph: &mut HashMap<NanoID, Node>, scene_id: &NanoID) {
    for node in graph.values_mut() {
        node.normalize_scenes(scene_id);
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Scene {
    pub id: NanoID,
    pub name: String,

    pub stages: Vec<Stage>,
    pub root: NanoID,
    pub graph: HashMap<NanoID, Node>,
    pub furniture: FurnitureData,
    pub private: bool,

    #[serde(default)] // addition 2.0
    pub tags: Vec<String>,
    #[serde(default)] // addition 2.0
    pub positions: Vec<PositionInfo>,
    #[serde(default)] // addition 1.1
    pub has_warnings: bool,
}

impl Scene {
    pub fn get_stage(&self, id: &NanoID) -> Option<&Stage> {
        for it in &self.stages {
            if &it.id == id {
                return Some(it);
            }
        }

        None
    }

    pub fn get_stage_mut(&mut self, id: &NanoID) -> Option<&mut Stage> {
        for it in &mut self.stages {
            if &it.id == id {
                return Some(it);
            }
        }

        None
    }

    pub fn import_offset(&mut self, yaml_obj: &serde_yaml::Mapping) -> Result<(), String> {
        let self_id = self.id.0.clone();
        for (scene_id_v, scene_obj) in yaml_obj {
            let scene_id = scene_id_v
                .as_str()
                .ok_or(format!("Expected Stage id for Scene {}", self.id.0))?
                .to_string();
            let stage = self.get_stage_mut(&NanoID(scene_id.clone()));
            if stage.is_none() {
                warn!("Scene {} has no stage with id {}", self.id.0, scene_id);
                continue;
            }
            stage
                .unwrap()
                .import_offset(scene_obj.as_sequence().ok_or(format!(
                    "Expecting sequence in scene {} for stage {}",
                    self_id, scene_id
                ))?)?;
        }
        Ok(())
    }

    pub fn update_to_latest_version(&mut self, old_version: u8) -> Result<&mut Self, String> {
        for stage in &mut self.stages {
            stage.update_to_latest_version(old_version)?;
        }
        if old_version <= 3 {
            // Addition 2.0 (v4): PositionInfo are explicitly stored in Scene
            self.positions = self
                .stages
                .first()
                .ok_or("No stages found in Scene")?
                .positions
                .iter()
                .map(|pos| pos.extract_position_info())
                .collect();
        }
        normalize_graph_scenes(&mut self.graph, &self.id);
        Ok(self)
    }

    pub fn prepare_for_encode(&mut self) {
        normalize_graph_scenes(&mut self.graph, &self.id);
    }
}

impl Default for Scene {
    fn default() -> Self {
        Self {
            id: NanoID::new_nanoid(),
            name: Default::default(),
            stages: Default::default(),
            root: Default::default(),
            graph: Default::default(),
            furniture: Default::default(),
            private: Default::default(),
            tags: Default::default(),
            positions: Default::default(),
            has_warnings: false,
        }
    }
}

impl EncodeBinary for Scene {
    fn get_byte_size(&self) -> usize {
        self.id.get_byte_size()
            + self.name.get_byte_size()
            + self.positions.get_byte_size()
            + self.stages.get_byte_size()
            + self.root.get_byte_size()
            + self.furniture.get_byte_size()
            + self.private.get_byte_size()
            + self.graph.get_byte_size()
    }

    fn write_byte(&self, buf: &mut Vec<u8>) -> () {
        let mut graph = self.graph.clone();
        normalize_graph_scenes(&mut graph, &self.id);
        self.id.write_byte(buf);
        self.name.write_byte(buf);
        self.positions.write_byte(buf);
        self.stages.write_byte(buf);
        graph.write_byte(buf);
        self.furniture.write_byte(buf);
        self.private.write_byte(buf);
    }
}

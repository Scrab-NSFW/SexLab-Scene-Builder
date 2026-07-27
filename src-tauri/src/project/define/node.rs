use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::mem::size_of;

use crate::project::{serialize::EncodeBinary, NanoID};

/// bit0: secondary / Return — deprioritized for auto-advance.
pub const EDGE_FLAG_SECONDARY: u8 = 1 << 0;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct DestRef {
    pub scene: NanoID,
    pub stage: NanoID,
}

impl DestRef {
    pub fn new(scene: NanoID, stage: NanoID) -> Self {
        Self { scene, stage }
    }

    pub fn local(scene: &NanoID, stage: NanoID) -> Self {
        Self {
            scene: scene.clone(),
            stage,
        }
    }
}

impl Serialize for DestRef {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("DestRef", 2)?;
        s.serialize_field("scene", &self.scene)?;
        s.serialize_field("stage", &self.stage)?;
        s.end()
    }
}

impl<'de> Deserialize<'de> for DestRef {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Legacy(NanoID),
            Absolute { scene: NanoID, stage: NanoID },
        }
        match Raw::deserialize(deserializer)? {
            Raw::Legacy(stage) => Ok(Self {
                scene: NanoID(String::new()),
                stage,
            }),
            Raw::Absolute { scene, stage } => Ok(Self { scene, stage }),
        }
    }
}

impl EncodeBinary for DestRef {
    fn get_byte_size(&self) -> usize {
        self.scene.get_byte_size() + self.stage.get_byte_size()
    }

    fn write_byte(&self, buf: &mut Vec<u8>) {
        self.scene.write_byte(buf);
        self.stage.write_byte(buf);
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq, Eq)]
pub struct GraphEdge {
    #[serde(default)]
    pub priority: i32,
    #[serde(default)]
    pub flags: u8,
    #[serde(default)]
    pub label: String,
}

impl GraphEdge {
    pub fn is_secondary(&self) -> bool {
        self.flags & EDGE_FLAG_SECONDARY != 0
    }

    pub fn with_secondary(mut self, secondary: bool) -> Self {
        if secondary {
            self.flags |= EDGE_FLAG_SECONDARY;
        } else {
            self.flags &= !EDGE_FLAG_SECONDARY;
        }
        self
    }
}

pub fn looks_like_return(priority: i32, description: &str, icon: &str) -> bool {
    if priority <= -999 {
        return true;
    }
    if icon.to_ascii_lowercase().contains("return") {
        return true;
    }
    let desc = description.trim();
    desc.eq_ignore_ascii_case("return")
        || desc.to_ascii_lowercase().starts_with("return ")
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Node {
    pub dest: Vec<DestRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub edges: Vec<GraphEdge>,
    pub x: f32,
    pub y: f32,
}

impl Default for Node {
    fn default() -> Self {
        Self {
            dest: Default::default(),
            edges: Default::default(),
            x: 40.0,
            y: 40.0,
        }
    }
}

impl Node {
    pub fn sync_edges(&mut self) {
        while self.edges.len() < self.dest.len() {
            self.edges.push(GraphEdge::default());
        }
        if self.edges.len() > self.dest.len() {
            self.edges.truncate(self.dest.len());
        }
    }

    fn edge_at(&self, idx: usize) -> GraphEdge {
        self.edges.get(idx).cloned().unwrap_or_default()
    }

    pub fn normalize_scenes(&mut self, owning_scene: &NanoID) {
        for d in &mut self.dest {
            if d.scene.0.is_empty() {
                d.scene = owning_scene.clone();
            }
        }
    }

    pub fn push_dest(&mut self, dest: DestRef, edge: GraphEdge) -> bool {
        if let Some(idx) = self.dest.iter().position(|d| d == &dest) {
            self.sync_edges();
            let cur = &mut self.edges[idx];
            if cur.label.is_empty() && !edge.label.is_empty() {
                *cur = edge;
            } else {
                if cur.priority == 0 && edge.priority != 0 {
                    cur.priority = edge.priority;
                }
                cur.flags |= edge.flags;
                if cur.label.is_empty() {
                    cur.label = edge.label;
                }
            }
            return false;
        }
        self.sync_edges();
        self.dest.push(dest);
        self.edges.push(edge);
        true
    }
}

impl EncodeBinary for GraphEdge {
    fn get_byte_size(&self) -> usize {
        size_of::<i32>() + size_of::<u8>() + self.label.get_byte_size()
    }

    fn write_byte(&self, buf: &mut Vec<u8>) {
        buf.extend_from_slice(&self.priority.to_be_bytes());
        buf.push(self.flags);
        self.label.write_byte(buf);
    }
}

impl EncodeBinary for Node {
    fn get_byte_size(&self) -> usize {
        let mut size = size_of::<u64>();
        for i in 0..self.dest.len() {
            size += self.dest[i].get_byte_size();
            size += self.edge_at(i).get_byte_size();
        }
        size
    }

    fn write_byte(&self, buf: &mut Vec<u8>) {
        buf.extend_from_slice(&(self.dest.len() as u64).to_be_bytes());
        for i in 0..self.dest.len() {
            self.dest[i].write_byte(buf);
            self.edge_at(i).write_byte(buf);
        }
    }
}

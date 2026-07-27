use serde::{Deserialize, Serialize};
use crate::project::{define::Offset, serialize::EncodeBinary};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FurnitureData {
    pub furni_types: Vec<String>,
    pub allow_bed: bool,
    pub offset: Offset,
    /// Optional OStim furniture type string override (project JSON only).
    /// When set, OStim export uses this instead of the SLR→OStim table.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub ostim_type: String,
}

impl Default for FurnitureData {
  fn default() -> Self {
      Self {
          furni_types: vec!["None".into()],
          allow_bed: Default::default(),
          offset: Default::default(),
          ostim_type: String::new(),
      }
  }
}

impl EncodeBinary for FurnitureData {
  fn get_byte_size(&self) -> usize {
    self.furni_types.get_byte_size() +
    self.allow_bed.get_byte_size() +
    self.offset.get_byte_size()
  }

  fn write_byte(&self, buf: &mut Vec<u8>) -> () {
    let furni_bytes = crate::furniture::as_furnitre(&self.furni_types);
    buf.extend_from_slice(&furni_bytes.bits().to_be_bytes());
    self.allow_bed.write_byte(buf);
    self.offset.write_byte(buf);
  }
}

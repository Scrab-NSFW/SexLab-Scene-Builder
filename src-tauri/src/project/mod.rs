use crate::project::serialize::EncodeBinary;
use serde::{Deserialize, Serialize};

// A collection of scenes and various meta data, such as author of the project
pub mod package;

// A directed, tree-like graph connecting stages into one large dynamic animation
pub mod scene;

// A set of n actors being animated by a single animation under specified constraints
pub mod stage;

// A single position representing some actor to animate
pub mod position;

pub mod position_info;

pub mod define;

pub mod slanim_source;

pub mod fnis_list;

pub mod behavior_gen;

pub mod ostim;

pub mod progress;

mod serialize;

#[derive(Default, Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct NanoID(pub String);

impl NanoID {
    const NANOID_ALPHABET: [char; 36] = [
        'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r',
        's', 't', 'u', 'v', 'w', 'x', 'y', 'z', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
    ];
    const PREFIX_HASH_LEN: usize = 4;
    const NANOID_LENGTH: usize = 8;

    pub fn new_prefix() -> Self {
        Self::new(Self::PREFIX_HASH_LEN)
    }

    pub fn new_nanoid() -> Self {
        Self::new(Self::NANOID_LENGTH)
    }

    fn new(len: usize) -> Self {
        assert!(
            len == Self::NANOID_LENGTH || len == Self::PREFIX_HASH_LEN,
            "NanoID length must be either {} or {}",
            Self::NANOID_LENGTH,
            Self::PREFIX_HASH_LEN
        );
        NanoID(nanoid::nanoid!(len, &Self::NANOID_ALPHABET))
    }
}

impl EncodeBinary for NanoID {
    fn get_byte_size(&self) -> usize {
        assert!(
            self.0.len() == Self::NANOID_LENGTH || self.0.len() == Self::PREFIX_HASH_LEN,
            "NanoID length must be either {} or {}",
            Self::NANOID_LENGTH,
            Self::PREFIX_HASH_LEN
        );
        self.0.len()
    }

    fn write_byte(&self, buf: &mut Vec<u8>) -> () {
        buf.extend_from_slice(self.0.as_bytes());
    }
}

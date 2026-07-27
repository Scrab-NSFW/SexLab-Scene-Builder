use crate::project::serialize::EncodeBinary;
use serde::{Deserialize, Serialize};
use std::mem::size_of;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Stripping {
    default: bool,

    everything: bool,
    nothing: bool,
    helmet: bool,
    gloves: bool,
    boots: bool,
}

impl EncodeBinary for Stripping {
    fn get_byte_size(&self) -> usize {
        size_of::<u8>()
    }

    fn write_byte(&self, buf: &mut Vec<u8>) -> () {
        if self.default {
            buf.push(1 << 7);
        } else if self.everything {
            buf.push(u8::MAX);
        } else if self.nothing {
            buf.push(u8::MIN);
        } else {
            buf.push(self.helmet as u8 + 2 * self.gloves as u8 + 4 * self.boots as u8);
        }
    }
}

impl Stripping {
    pub fn nothing() -> Self {
        Self {
            default: false,
            everything: false,
            nothing: true,
            helmet: false,
            gloves: false,
            boots: false,
        }
    }

    pub fn is_nothing(&self) -> bool {
        self.nothing && !self.default && !self.everything
    }
}

impl Default for Stripping {
    fn default() -> Self {
        Self {
            default: true,
            everything: false,
            nothing: false,
            helmet: false,
            gloves: false,
            boots: false,
        }
    }
}

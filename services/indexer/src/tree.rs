use crate::{Bytes32, Error, Result};
use ark_bn254::Fr;
use ark_ff::AdditiveGroup;
use std::collections::BTreeMap;

/// Sparse, original-Poseidon tree. Removed/Pending leaves are zero, IDs never recycle.
#[derive(Clone, Debug)]
pub struct Tree {
    nodes: BTreeMap<(u8, u32), Fr>,
    zeros: [Fr; 33],
}
impl Default for Tree {
    fn default() -> Self {
        Self::new()
    }
}
impl Tree {
    pub fn new() -> Self {
        let mut zeros = [Fr::ZERO; 33];
        for level in 0..32 {
            zeros[level + 1] = zkapi_poseidon::node(zeros[level], zeros[level]);
        }
        Self {
            nodes: BTreeMap::new(),
            zeros,
        }
    }
    fn node(&self, level: u8, index: u32) -> Fr {
        self.nodes
            .get(&(level, index))
            .copied()
            .unwrap_or(self.zeros[level as usize])
    }
    pub fn root(&self) -> Bytes32 {
        zkapi_poseidon::bytes(self.node(32, 0))
    }
    pub fn leaf(&self, id: u32) -> Bytes32 {
        zkapi_poseidon::bytes(self.node(0, id))
    }
    pub fn path(&self, id: u32) -> [Bytes32; 32] {
        std::array::from_fn(|level| {
            zkapi_poseidon::bytes(self.node(level as u8, (id >> level) ^ 1))
        })
    }
    pub fn update(&mut self, id: u32, value: Bytes32) -> Result<()> {
        let mut value = zkapi_poseidon::parse(&value).ok_or(Error::State)?;
        let mut index = id;
        for level in 0..=32u8 {
            if value == self.zeros[level as usize] {
                self.nodes.remove(&(level, index));
            } else {
                self.nodes.insert((level, index), value);
            }
            if level == 32 {
                break;
            }
            let sibling = self.node(level, index ^ 1);
            value = if index & 1 == 0 {
                zkapi_poseidon::node(value, sibling)
            } else {
                zkapi_poseidon::node(sibling, value)
            };
            index >>= 1;
        }
        Ok(())
    }
}

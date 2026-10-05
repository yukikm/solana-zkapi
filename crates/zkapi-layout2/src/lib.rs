//! Allocation-free layout 2 wire and semantic bindings, shared by host and SBF.
//! Callers must authenticate accounts and verify proofs before applying a transition.
#![no_std]
pub mod binding;
mod compact;
pub mod framing;
pub use compact::{
    compress_deposit_compact_v1, expand_deposit_compact_v1, DEPOSIT_COMPACT_V1_BYTES,
};
pub type Field = [u8; 32];
pub type Proof = [u8; 256];
pub const ZERO: Field = [0; 32];
pub const FR_MODULUS: Field = [
    48, 100, 78, 114, 225, 49, 160, 41, 184, 80, 69, 182, 129, 129, 88, 93, 40, 51, 232, 72, 121,
    185, 112, 145, 67, 225, 245, 147, 240, 0, 0, 1,
];
pub const TREE_BYTES: usize = 608;
pub const MAX_AMOUNT: u64 = 9_007_199_254_740_991;
pub const NAMESPACE: u64 = 0x534f4c;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum Error {
    Encoding = 20,
    Field = 21,
    Binding = 22,
    Range = 23,
    State = 24,
    Time = 25,
    TreeFull = 26,
    Nullifier = 27,
}
pub fn canonical(f: &Field) -> Result<(), Error> {
    if f < &FR_MODULUS {
        Ok(())
    } else {
        Err(Error::Field)
    }
}
pub fn integer(n: u64) -> Field {
    let mut f = ZERO;
    f[24..].copy_from_slice(&n.to_be_bytes());
    f
}
pub fn to_u64(f: &Field) -> Result<u64, Error> {
    if f[..24].iter().any(|b| *b != 0) {
        return Err(Error::Range);
    }
    Ok(u64::from_be_bytes(f[24..].try_into().unwrap()))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Operation {
    Deposit = 0,
    Close = 1,
    Escape = 2,
    Challenge = 3,
    Expiry = 4,
}
impl Operation {
    pub fn from_byte(b: u8) -> Result<Self, Error> {
        match b {
            0 => Ok(Self::Deposit),
            1 => Ok(Self::Close),
            2 => Ok(Self::Escape),
            3 => Ok(Self::Challenge),
            4 => Ok(Self::Expiry),
            _ => Err(Error::Encoding),
        }
    }
    pub const fn tree_op(self) -> u64 {
        match self {
            Self::Deposit => 0,
            Self::Challenge => 2,
            _ => 1,
        }
    }
    pub const fn payload_len(self) -> usize {
        match self {
            Self::Deposit => 692,
            Self::Close | Self::Escape => 1312,
            Self::Challenge => 1252,
            Self::Expiry => 612,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TreeUpdate {
    pub public: [Field; 11],
    pub proof: Proof,
}
impl TreeUpdate {
    pub fn encode(&self, out: &mut [u8]) -> Result<(), Error> {
        if out.len() != TREE_BYTES {
            return Err(Error::Encoding);
        }
        for (f, bytes) in self.public.iter().zip(out[..352].chunks_exact_mut(32)) {
            canonical(f)?;
            bytes.copy_from_slice(f);
        }
        out[352..].copy_from_slice(&self.proof);
        Ok(())
    }
    pub fn decode(bytes: &[u8]) -> Result<Self, Error> {
        let r = TreeRef::decode(bytes)?;
        Ok(Self {
            public: core::array::from_fn(|i| *r.public.get(i)),
            proof: *r.proof,
        })
    }
}
#[derive(Clone, Copy, Debug)]
pub struct Inputs<'a> {
    bytes: &'a [u8],
}
impl<'a> Inputs<'a> {
    pub fn decode(bytes: &'a [u8], n: usize) -> Result<Self, Error> {
        if bytes.len() != n.checked_mul(32).ok_or(Error::Encoding)? {
            return Err(Error::Encoding);
        }
        for f in bytes.chunks_exact(32) {
            canonical(f.try_into().unwrap())?;
        }
        Ok(Self { bytes })
    }
    /// Index is fixed by the decoded layout; an out-of-range index is a caller bug.
    pub fn get(self, i: usize) -> &'a Field {
        self.bytes[i * 32..(i + 1) * 32].try_into().unwrap()
    }
    pub fn len(self) -> usize {
        self.bytes.len() / 32
    }
    pub fn is_empty(self) -> bool {
        self.bytes.is_empty()
    }
}
#[derive(Clone, Copy, Debug)]
pub struct TreeRef<'a> {
    pub public: Inputs<'a>,
    pub proof: &'a Proof,
}
impl<'a> TreeRef<'a> {
    pub fn decode(bytes: &'a [u8]) -> Result<Self, Error> {
        if bytes.len() != TREE_BYTES {
            return Err(Error::Encoding);
        }
        Ok(Self {
            public: Inputs::decode(&bytes[..352], 11)?,
            proof: bytes[352..].try_into().unwrap(),
        })
    }
}
#[derive(Clone, Copy, Debug)]
pub struct Authorization<'a> {
    pub public: Inputs<'a>,
    pub proof: &'a Proof,
}
#[derive(Clone, Copy, Debug)]
pub struct Deposit {
    pub expected_id: u32,
    pub expected_root: Field,
    pub expiry: u64,
    pub commitment: Field,
    pub amount: u64,
}
#[derive(Clone, Copy, Debug)]
pub struct Command<'a> {
    pub op: Operation,
    pub tree: TreeRef<'a>,
    pub authorization: Option<Authorization<'a>>,
    pub deposit: Option<Deposit>,
    pub note_id: Option<u32>,
}
impl<'a> Command<'a> {
    pub fn decode(op: Operation, bytes: &'a [u8]) -> Result<Self, Error> {
        if bytes.len() != op.payload_len() {
            return Err(Error::Encoding);
        }
        let start = bytes.len() - TREE_BYTES;
        let mut c = Self {
            op,
            tree: TreeRef::decode(&bytes[start..])?,
            authorization: None,
            deposit: None,
            note_id: None,
        };
        match op {
            Operation::Deposit => {
                let expected_root = bytes[4..36].try_into().unwrap();
                let commitment = bytes[44..76].try_into().unwrap();
                canonical(&expected_root)?;
                canonical(&commitment)?;
                c.deposit = Some(Deposit {
                    expected_id: u32::from_le_bytes(bytes[..4].try_into().unwrap()),
                    expected_root,
                    expiry: u64::from_le_bytes(bytes[36..44].try_into().unwrap()),
                    commitment,
                    amount: u64::from_le_bytes(bytes[76..84].try_into().unwrap()),
                });
            }
            Operation::Close | Operation::Escape => {
                c.authorization = Some(Authorization {
                    public: Inputs::decode(&bytes[..448], 14)?,
                    proof: bytes[448..704].try_into().unwrap(),
                })
            }
            Operation::Challenge => {
                c.note_id = Some(u32::from_le_bytes(bytes[..4].try_into().unwrap()));
                c.authorization = Some(Authorization {
                    public: Inputs::decode(&bytes[4..388], 12)?,
                    proof: bytes[388..644].try_into().unwrap(),
                });
            }
            Operation::Expiry => {
                c.note_id = Some(u32::from_le_bytes(bytes[..4].try_into().unwrap()))
            }
        }
        Ok(c)
    }
}

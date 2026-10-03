//! Authenticated measurement snapshot only, NOT the I03 Vault account layout.
use zkapi_layout2::{Error, Field};
pub const LEN: usize = 523;
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct State {
    pub layout: u8,
    pub backend: u8,
    pub policy: u8,
    pub paused: u8,
    pub profile: Field,
    pub genesis: Field,
    pub mint: Field,
    pub treasury: Field,
    pub root: Field,
    pub keys: [Field; 4],
    pub next_id: u64,
    pub sequence: u64,
    pub ttl: u64,
    pub status: u8,
    pub id: u32,
    pub commitment: Field,
    pub deposit: u64,
    pub expiry: u64,
    pub pending: u8,
    pub pending_n: Field,
    pub deadline: u64,
    pub old_root: Field,
    pub consumed: u8,
    pub exit_n: Field,
    pub balance: u64,
    pub destination: Field,
}
struct Read<'a>(&'a [u8]);
impl Read<'_> {
    fn take<const N: usize>(&mut self) -> [u8; N] {
        let (a, b) = self.0.split_at(N);
        self.0 = b;
        a.try_into().unwrap()
    }
    fn byte(&mut self) -> u8 {
        self.take::<1>()[0]
    }
    fn u64(&mut self) -> u64 {
        u64::from_le_bytes(self.take())
    }
}
impl State {
    pub fn decode(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() != LEN || &bytes[..8] != b"I02BSTAT" {
            return Err(Error::Encoding);
        }
        let mut r = Read(&bytes[8..]);
        Ok(Self {
            layout: r.byte(),
            backend: r.byte(),
            policy: r.byte(),
            paused: r.byte(),
            profile: r.take(),
            genesis: r.take(),
            mint: r.take(),
            treasury: r.take(),
            root: r.take(),
            keys: core::array::from_fn(|_| r.take()),
            next_id: r.u64(),
            sequence: r.u64(),
            ttl: r.u64(),
            status: r.byte(),
            id: u32::from_le_bytes(r.take()),
            commitment: r.take(),
            deposit: r.u64(),
            expiry: r.u64(),
            pending: r.byte(),
            pending_n: r.take(),
            deadline: r.u64(),
            old_root: r.take(),
            consumed: r.byte(),
            exit_n: r.take(),
            balance: r.u64(),
            destination: r.take(),
        })
    }
    pub fn encode(&self) -> [u8; LEN] {
        let mut out = [0; LEN];
        let mut i = 0;
        macro_rules! put {
            ($x:expr) => {
                let b = $x;
                out[i..i + b.len()].copy_from_slice(b);
                i += b.len();
            };
        }
        put!(b"I02BSTAT");
        put!(&[self.layout, self.backend, self.policy, self.paused]);
        for f in [
            &self.profile,
            &self.genesis,
            &self.mint,
            &self.treasury,
            &self.root,
        ] {
            put!(f);
        }
        for k in &self.keys {
            put!(k);
        }
        for n in [self.next_id, self.sequence, self.ttl] {
            put!(&n.to_le_bytes());
        }
        put!(&[self.status]);
        put!(&self.id.to_le_bytes());
        put!(&self.commitment);
        put!(&self.deposit.to_le_bytes());
        put!(&self.expiry.to_le_bytes());
        put!(&[self.pending]);
        put!(&self.pending_n);
        put!(&self.deadline.to_le_bytes());
        put!(&self.old_root);
        put!(&[self.consumed]);
        put!(&self.exit_n);
        put!(&self.balance.to_le_bytes());
        put!(&self.destination);
        debug_assert_eq!(i, LEN);
        out
    }
}

use crate::{integer, to_u64, Command, Error, Field, Operation, MAX_AMOUNT, NAMESPACE, ZERO};
#[derive(Clone, Copy, Debug)]
pub struct Note {
    pub id: u32,
    pub commitment: Field,
    pub deposit: u64,
    pub expiry: u64,
    pub status: u8,
}
#[derive(Clone, Copy, Debug)]
pub struct Pending {
    pub exists: bool,
    pub nullifier: Field,
    pub deadline: u64,
}
/// Values must come from authenticated config/state accounts, never the proof.
#[derive(Clone, Copy, Debug)]
pub struct Context {
    pub vault: Field,
    pub state_key: [Field; 2],
    pub clearance_key: [Field; 2],
    pub root: Field,
    pub next_id: u64,
    pub note: Option<Note>,
    pub pending: Option<Pending>,
    pub now: u64,
    pub ttl: u64,
    pub paused: bool,
    pub exit_consumed: bool,
    pub destination: Field,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Transition {
    pub root: Field,
    pub id: u32,
    pub deposit: u64,
    pub payout: u64,
    pub treasury: u64,
    pub exit_nullifier: Option<Field>,
}
fn require(b: bool, e: Error) -> Result<(), Error> {
    if b {
        Ok(())
    } else {
        Err(e)
    }
}
/// Semantic checks only: caller MUST also verify every attached Groth16 proof.
#[inline(never)]
pub fn validate(c: &Command<'_>, ctx: &Context) -> Result<Transition, Error> {
    let p = c.tree.public;
    require(p.len() == 11, Error::Encoding)?;
    let auth_len = match c.op {
        Operation::Close | Operation::Escape => 14,
        Operation::Challenge => 12,
        _ => 0,
    };
    require(
        c.authorization.map_or(0, |a| a.public.len()) == auth_len,
        Error::Encoding,
    )?;
    require(
        *p.get(0) == ctx.vault && *p.get(1) == ctx.root && *p.get(9) == integer(c.op.tree_op()),
        Error::Binding,
    )?;
    require(
        !ctx.paused || matches!(c.op, Operation::Challenge | Operation::Expiry),
        Error::State,
    )?;
    let n = if c.op == Operation::Deposit {
        let d = c.deposit.ok_or(Error::Encoding)?;
        require(ctx.next_id < 1u64 << 32, Error::TreeFull)?;
        require(ctx.note.is_none(), Error::State)?;
        require(
            u64::from(d.expected_id) == ctx.next_id && d.expected_root == ctx.root,
            Error::Binding,
        )?;
        require(
            d.amount > 0 && d.amount <= MAX_AMOUNT && d.commitment != ZERO,
            Error::Range,
        )?;
        require(ctx.ttl > 0, Error::Range)?;
        let expected = ctx
            .now
            .checked_add(ctx.ttl)
            .and_then(|x| x.checked_add(86399))
            .and_then(|x| (x / 86400).checked_mul(86400))
            .ok_or(Error::Range)?;
        require(d.expiry == expected, Error::Time)?;
        Note {
            id: d.expected_id,
            commitment: d.commitment,
            deposit: d.amount,
            expiry: d.expiry,
            status: 1,
        }
    } else {
        ctx.note.ok_or(Error::State)?
    };
    require(
        *p.get(3) == integer(n.id as u64)
            && *p.get(6) == n.commitment
            && *p.get(7) == integer(n.deposit)
            && *p.get(8) == integer(n.expiry),
        Error::Binding,
    )?;
    require(
        n.deposit > 0 && n.deposit <= MAX_AMOUNT && n.commitment != ZERO,
        Error::Range,
    )?;
    require(
        *p.get(if c.op.tree_op() == 1 { 5 } else { 4 }) == ZERO,
        Error::Binding,
    )?;
    let mut out = Transition {
        root: *p.get(2),
        id: n.id,
        deposit: n.deposit,
        payout: 0,
        treasury: 0,
        exit_nullifier: None,
    };
    match c.op {
        Operation::Deposit => {}
        Operation::Close | Operation::Escape => {
            require(n.status == 1, Error::State)?;
            require(!ctx.exit_consumed, Error::Nullifier)?;
            let w = c.authorization.ok_or(Error::Encoding)?.public;
            require(
                *w.get(0) == integer(2)
                    && *w.get(1) == integer(NAMESPACE)
                    && *w.get(2) == ctx.vault
                    && *w.get(3) == ctx.root
                    && *w.get(8) == integer(n.id as u64),
                Error::Binding,
            )?;
            require(
                *w.get(4) == ctx.state_key[0]
                    && *w.get(5) == ctx.state_key[1]
                    && *w.get(6) == ctx.clearance_key[0]
                    && *w.get(7) == ctx.clearance_key[1],
                Error::Binding,
            )?;
            require(
                *w.get(10) == ctx.destination
                    && *w.get(12) == integer(u64::from(c.op == Operation::Close)),
                Error::Binding,
            )?;
            let balance = to_u64(w.get(9))?;
            require(balance <= n.deposit, Error::Range)?;
            out.exit_nullifier = Some(*w.get(11));
            if c.op == Operation::Close {
                out.payout = balance;
                out.treasury = n.deposit - balance;
            }
        }
        Operation::Challenge => {
            require(c.note_id == Some(n.id), Error::Binding)?;
            let pending = ctx.pending.ok_or(Error::State)?;
            require(n.status == 2 && pending.exists, Error::State)?;
            require(ctx.now < pending.deadline, Error::Time)?;
            let r = c.authorization.ok_or(Error::Encoding)?.public;
            require(
                *r.get(0) == integer(2)
                    && *r.get(1) == integer(NAMESPACE)
                    && *r.get(2) == ctx.vault
                    && *r.get(4) == ctx.state_key[0]
                    && *r.get(5) == ctx.state_key[1],
                Error::Binding,
            )?;
            require(*r.get(8) == pending.nullifier, Error::Nullifier)?;
            // r[3] remains the historical root, NOT current or Pending.old_root.
        }
        Operation::Expiry => {
            require(c.note_id == Some(n.id), Error::Binding)?;
            require(n.status == 1, Error::State)?;
            require(ctx.now >= n.expiry, Error::Time)?;
            out.treasury = n.deposit;
        }
    }
    Ok(out)
}

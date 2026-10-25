//! Semantic-policy tests only. Real proof/SBF coverage lives in the Vault harness.
use zkapi_layout2::{
    binding::{self, Context, Note, Pending, Transition, NON_EXPIRING_NOTE_EXPIRY},
    integer, Command, Error, Operation, TreeUpdate, NAMESPACE, ZERO,
};

fn context(ttl: u64, now: u64) -> Context {
    Context {
        vault: integer(1),
        state_key: [integer(2), integer(3)],
        clearance_key: [integer(4), integer(5)],
        root: integer(6),
        next_id: 0,
        note: None,
        pending: None,
        now,
        ttl,
        paused: false,
        exit_consumed: false,
        destination: integer(7),
    }
}

fn note(expiry: u64, status: u8) -> Note {
    Note {
        id: 0,
        commitment: integer(8),
        deposit: 1_000_000,
        expiry,
        status,
    }
}

fn validate(op: Operation, ctx: &Context, n: Note) -> Result<Transition, Error> {
    let mut bytes = vec![0; op.payload_len()];
    let mut public = [ZERO; 11];
    public[0] = ctx.vault;
    public[1] = ctx.root;
    public[2] = integer(9);
    public[3] = integer(n.id.into());
    public[if op.tree_op() == 1 { 4 } else { 5 }] = integer(10);
    public[6] = n.commitment;
    public[7] = integer(n.deposit);
    public[8] = integer(n.expiry);
    public[9] = integer(op.tree_op());
    let tree_start = bytes.len() - 608;
    TreeUpdate {
        public,
        proof: [0; 256],
    }
    .encode(&mut bytes[tree_start..])
    .unwrap();
    match op {
        Operation::Deposit => {
            bytes[..4].copy_from_slice(&n.id.to_le_bytes());
            bytes[4..36].copy_from_slice(&ctx.root);
            bytes[36..44].copy_from_slice(&n.expiry.to_le_bytes());
            bytes[44..76].copy_from_slice(&n.commitment);
            bytes[76..84].copy_from_slice(&n.deposit.to_le_bytes());
        }
        Operation::Close | Operation::Escape => {
            let auth = [
                integer(2),
                integer(NAMESPACE),
                ctx.vault,
                ctx.root,
                ctx.state_key[0],
                ctx.state_key[1],
                ctx.clearance_key[0],
                ctx.clearance_key[1],
                integer(n.id.into()),
                integer(900_000),
                ctx.destination,
                integer(11),
                integer(u64::from(op == Operation::Close)),
                ZERO,
            ];
            for (out, field) in bytes[..448].chunks_exact_mut(32).zip(auth) {
                out.copy_from_slice(&field);
            }
        }
        Operation::Challenge => {
            bytes[..4].copy_from_slice(&n.id.to_le_bytes());
            let mut auth = [ZERO; 12];
            auth[0] = integer(2);
            auth[1] = integer(NAMESPACE);
            auth[2] = ctx.vault;
            auth[3] = integer(12); // historical request root is deliberately different
            auth[4] = ctx.state_key[0];
            auth[5] = ctx.state_key[1];
            auth[8] = ctx.pending.unwrap().nullifier;
            for (out, field) in bytes[4..388].chunks_exact_mut(32).zip(auth) {
                out.copy_from_slice(&field);
            }
        }
        Operation::Expiry => bytes[..4].copy_from_slice(&n.id.to_le_bytes()),
    }
    binding::validate(&Command::decode(op, &bytes).unwrap(), ctx)
}

#[test]
fn no_expiry_policy_has_one_canonical_note_value_without_clock_arithmetic() {
    for now in [0, 1_792_886_400, i64::MAX as u64, u64::MAX] {
        let ctx = context(0, now);
        assert_eq!(
            binding::deposit_expiry(now, 0),
            Ok(NON_EXPIRING_NOTE_EXPIRY)
        );
        assert!(validate(Operation::Deposit, &ctx, note(NON_EXPIRING_NOTE_EXPIRY, 1)).is_ok());
        for expiry in [0, 86_400, u64::MAX - 1] {
            assert_eq!(
                validate(Operation::Deposit, &ctx, note(expiry, 1)),
                Err(Error::Time)
            );
        }
    }
}

#[test]
fn finite_deposits_keep_the_original_utc_rounding_and_overflow_rejection() {
    for (now, ttl, expiry) in [
        (0, 86_400, 86_400),
        (1, 86_400, 172_800),
        (86_400, 86_400, 172_800),
    ] {
        let ctx = context(ttl, now);
        assert_eq!(binding::deposit_expiry(now, ttl), Ok(expiry));
        assert!(validate(Operation::Deposit, &ctx, note(expiry, 1)).is_ok());
        assert_eq!(
            validate(Operation::Deposit, &ctx, note(u64::MAX, 1)),
            Err(Error::Time)
        );
    }
    assert_eq!(binding::deposit_expiry(u64::MAX, 1), Err(Error::Range));
    assert_eq!(binding::deposit_expiry(u64::MAX - 1, 1), Err(Error::Range));
}

#[test]
fn expiry_cannot_claim_a_non_expiring_pool_even_at_the_sentinel() {
    for expiry in [86_400, NON_EXPIRING_NOTE_EXPIRY] {
        let n = note(expiry, 1);
        for now in [expiry, u64::MAX] {
            let mut ctx = context(0, now);
            ctx.note = Some(n);
            assert_eq!(validate(Operation::Expiry, &ctx, n), Err(Error::Time));
            ctx.paused = true;
            assert_eq!(validate(Operation::Expiry, &ctx, n), Err(Error::Time));
        }
    }
}

#[test]
fn finite_expiry_keeps_active_only_equality_and_full_principal_behavior() {
    let n = note(172_800, 1);
    let mut ctx = context(86_400, n.expiry - 1);
    ctx.note = Some(n);
    assert_eq!(validate(Operation::Expiry, &ctx, n), Err(Error::Time));
    ctx.now = n.expiry;
    let claim = validate(Operation::Expiry, &ctx, n).unwrap();
    assert_eq!((claim.payout, claim.treasury), (0, n.deposit));
    ctx.note = Some(note(n.expiry, 2));
    assert_eq!(
        validate(Operation::Expiry, &ctx, ctx.note.unwrap()),
        Err(Error::State)
    );
}

#[test]
fn no_expiry_policy_keeps_withdrawal_authorization_and_challenge_deadlines() {
    for ttl in [0, 86_400] {
        let n = note(binding::deposit_expiry(1, ttl).unwrap(), 1);
        let mut ctx = context(ttl, 180_000);
        ctx.note = Some(n);
        let close = validate(Operation::Close, &ctx, n).unwrap();
        assert_eq!((close.payout, close.treasury), (900_000, 100_000));
        assert!(validate(Operation::Escape, &ctx, n).is_ok());
        ctx.exit_consumed = true;
        assert_eq!(validate(Operation::Escape, &ctx, n), Err(Error::Nullifier));
        let pending_note = note(n.expiry, 2);
        ctx.note = Some(pending_note);
        ctx.pending = Some(Pending {
            exists: true,
            nullifier: integer(11),
            deadline: ctx.now + 1800,
        });
        ctx.now = ctx.pending.unwrap().deadline - 1;
        assert!(validate(Operation::Challenge, &ctx, pending_note).is_ok());
        ctx.now += 1;
        assert_eq!(
            validate(Operation::Challenge, &ctx, pending_note),
            Err(Error::Time)
        );
    }
}

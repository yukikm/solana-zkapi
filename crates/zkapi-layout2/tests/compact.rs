use zkapi_layout2::{
    compress_deposit_compact_v1, expand_deposit_compact_v1, integer, to_u64, Command, Error, Field,
    Operation, TreeUpdate, DEPOSIT_COMPACT_V1_BYTES, FR_MODULUS, ZERO,
};

fn fixture(source: &str) -> ([u8; 692], Field) {
    let value: serde_json::Value = serde_json::from_str(source).unwrap();
    let tree = &value["trees"][0];
    let public: [Field; 11] = core::array::from_fn(|i| {
        hex::decode(
            tree["public_inputs"][i]
                .as_str()
                .unwrap()
                .trim_start_matches("0x"),
        )
        .unwrap()
        .try_into()
        .unwrap()
    });
    let mut canonical = [0; 692];
    canonical[..4].copy_from_slice(&(to_u64(&public[3]).unwrap() as u32).to_le_bytes());
    canonical[4..36].copy_from_slice(&public[1]);
    canonical[36..44].copy_from_slice(&to_u64(&public[8]).unwrap().to_le_bytes());
    canonical[44..76].copy_from_slice(&public[6]);
    canonical[76..84].copy_from_slice(&to_u64(&public[7]).unwrap().to_le_bytes());
    TreeUpdate {
        public,
        proof: hex::decode(tree["proof_wire_hex"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap(),
    }
    .encode(&mut canonical[84..])
    .unwrap();
    (canonical, public[0])
}

#[test]
fn generated_proof_fixtures_roundtrip_without_changing_any_public_input_or_proof_byte() {
    for source in [
        include_str!("../../../tests/fixtures/vault/a.json"),
        include_str!("../../../tests/fixtures/vault/max-id.json"),
        include_str!("../../../tests/fixtures/vault/other-vault.json"),
    ] {
        let (canonical, binding) = fixture(source);
        let compact = compress_deposit_compact_v1(&canonical, &binding).unwrap();
        assert_eq!(compact.len(), DEPOSIT_COMPACT_V1_BYTES);
        assert_eq!(
            expand_deposit_compact_v1(&compact, &binding).unwrap(),
            canonical
        );
        assert_eq!(&compact[..84], &canonical[..84]);
        assert_eq!(&compact[180..], &canonical[436..]);
        assert_eq!(&compact[84..116], &canonical[148..180]);
        assert_eq!(&compact[116..148], &canonical[244..276]);
        assert_eq!(&compact[148..180], &canonical[404..436]);
    }
}

#[test]
fn all_omitted_duplicates_constants_and_binding_must_match_before_compression() {
    let (canonical, binding) = fixture(include_str!("../../../tests/fixtures/vault/a.json"));
    for index in [0, 1, 3, 4, 6, 7, 8, 9] {
        let mut changed = canonical;
        changed[84 + index * 32 + 31] ^= 1;
        assert_eq!(
            compress_deposit_compact_v1(&changed, &binding),
            Err(Error::Binding)
        );
    }
    for offset in [0, 4, 36, 44, 76] {
        let mut changed = canonical;
        changed[offset] ^= 1;
        assert_eq!(
            compress_deposit_compact_v1(&changed, &binding),
            Err(Error::Binding)
        );
    }
    let mut wrong_binding = binding;
    wrong_binding[31] ^= 1;
    assert_eq!(
        compress_deposit_compact_v1(&canonical, &wrong_binding),
        Err(Error::Binding)
    );
    // A canonical Fr above u64/u32 must not silently truncate into its wire integer.
    for index in [3, 7, 8] {
        let mut changed = canonical;
        changed[84 + index * 32 + 20] = 1;
        assert_eq!(
            compress_deposit_compact_v1(&changed, &binding),
            Err(Error::Binding)
        );
    }
}

#[test]
fn expansion_and_compression_reject_noncanonical_fields_without_reduction() {
    let (canonical, binding) = fixture(include_str!("../../../tests/fixtures/vault/a.json"));
    let compact = compress_deposit_compact_v1(&canonical, &binding).unwrap();
    for invalid in [FR_MODULUS, [255; 32]] {
        for offset in [4, 44, 84, 116, 148] {
            let mut changed = compact;
            changed[offset..offset + 32].copy_from_slice(&invalid);
            assert_eq!(
                expand_deposit_compact_v1(&changed, &binding),
                Err(Error::Field)
            );
        }
        for offset in [4, 44].into_iter().chain((0..11).map(|i| 84 + 32 * i)) {
            let mut changed = canonical;
            changed[offset..offset + 32].copy_from_slice(&invalid);
            assert_eq!(
                compress_deposit_compact_v1(&changed, &binding),
                Err(Error::Field)
            );
        }
        assert_eq!(
            expand_deposit_compact_v1(&compact, &invalid),
            Err(Error::Field)
        );
        assert_eq!(
            compress_deposit_compact_v1(&canonical, &invalid),
            Err(Error::Field)
        );
    }
}

#[test]
fn exact_length_rejects_every_truncation_trailing_bytes_and_legacy_wire() {
    let (canonical, binding) = fixture(include_str!("../../../tests/fixtures/vault/a.json"));
    let compact = compress_deposit_compact_v1(&canonical, &binding).unwrap();
    for length in 0..compact.len() {
        assert_eq!(
            expand_deposit_compact_v1(&compact[..length], &binding),
            Err(Error::Encoding)
        );
    }
    for length in 0..canonical.len() {
        assert_eq!(
            compress_deposit_compact_v1(&canonical[..length], &binding),
            Err(Error::Encoding)
        );
    }
    let mut trailing = compact.to_vec();
    trailing.push(0);
    assert_eq!(
        expand_deposit_compact_v1(&trailing, &binding),
        Err(Error::Encoding)
    );
    assert_eq!(
        expand_deposit_compact_v1(&canonical, &binding),
        Err(Error::Encoding)
    );
    let mut trailing = canonical.to_vec();
    trailing.push(0);
    assert_eq!(
        compress_deposit_compact_v1(&trailing, &binding),
        Err(Error::Encoding)
    );
}

#[test]
fn integer_boundaries_are_zero_extended_and_semantic_checks_remain_with_the_handler() {
    let mut compact = [0; DEPOSIT_COMPACT_V1_BYTES];
    for (id, amount, expiry) in [(0, 0, 0), (u32::MAX, u64::MAX, u64::MAX)] {
        compact[..4].copy_from_slice(&id.to_le_bytes());
        compact[36..44].copy_from_slice(&expiry.to_le_bytes());
        compact[76..84].copy_from_slice(&amount.to_le_bytes());
        let expanded = expand_deposit_compact_v1(&compact, &ZERO).unwrap();
        let command = Command::decode(Operation::Deposit, &expanded).unwrap();
        assert_eq!(command.tree.public.get(3), &integer(u64::from(id)));
        assert_eq!(command.tree.public.get(7), &integer(amount));
        assert_eq!(command.tree.public.get(8), &integer(expiry));
        assert_eq!(command.tree.public.get(4), &ZERO);
        assert_eq!(command.tree.public.get(9), &ZERO);
        assert_eq!(
            compress_deposit_compact_v1(&expanded, &ZERO).unwrap(),
            compact
        );
    }
}

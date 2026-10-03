use groth16_solana::groth16::{Groth16Verifier, Groth16Verifyingkey};
use solana_program::{entrypoint::ProgramResult, program_error::ProgramError};
const FQ: [u8; 32] = [
    48, 100, 78, 114, 225, 49, 160, 41, 184, 80, 69, 182, 129, 129, 88, 93, 151, 129, 106, 145,
    104, 113, 202, 141, 60, 32, 140, 22, 216, 124, 253, 71,
];
fn invalid() -> ProgramError {
    ProgramError::InvalidInstructionData
}
fn negate(y: &[u8]) -> [u8; 32] {
    let mut out = [0; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let v = i16::from(FQ[i]) - i16::from(y[i]) - borrow;
        out[i] = v as u8;
        borrow = i16::from(v < 0);
    }
    if y.iter().all(|x| *x == 0) {
        [0; 32]
    } else {
        out
    }
}
#[inline(never)]
pub fn verify<const N: usize>(
    raw: &[u8; 256],
    public: zkapi_layout2::Inputs<'_>,
    key: &Groth16Verifyingkey,
) -> ProgramResult {
    if public.len() != N {
        return Err(invalid());
    }
    for c in raw.chunks_exact(32) {
        if c >= FQ.as_slice() {
            return Err(invalid());
        }
    }
    // Do not accept infinity, including Solana's (0,0) sentinel.
    for point in [&raw[..64], &raw[64..192], &raw[192..]] {
        if point.iter().all(|x| *x == 0) {
            return Err(invalid());
        }
    }
    let mut a = [0; 64];
    a[..32].copy_from_slice(&raw[..32]);
    a[32..].copy_from_slice(&negate(&raw[32..64]));
    let mut b = [0; 128];
    b[..32].copy_from_slice(&raw[96..128]);
    b[32..64].copy_from_slice(&raw[64..96]);
    b[64..96].copy_from_slice(&raw[160..192]);
    b[96..].copy_from_slice(&raw[128..160]);
    let c: &[u8; 64] = raw[192..].try_into().unwrap();
    let mut inputs = [[0; 32]; N];
    for (i, input) in inputs.iter_mut().enumerate() {
        input.copy_from_slice(public.get(i));
        if zkapi_layout2::canonical(input).is_err() {
            return Err(invalid());
        }
    }
    #[cfg(feature = "wrong-vk")]
    let key = &Groth16Verifyingkey {
        vk_alpha_g1: {
            let mut alpha = key.vk_alpha_g1;
            alpha[32..].copy_from_slice(&negate(&key.vk_alpha_g1[32..]));
            alpha
        },
        ..*key
    };
    Groth16Verifier::new(&a, &b, c, &inputs, key)
        .map_err(|_| ProgramError::Custom(1))?
        .verify()
        .map_err(|_| ProgramError::Custom(1))
}

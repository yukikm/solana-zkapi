//! Signed quote binding and exact, integer-only accounting.
use crate::wire::*;
use ark_bn254::Fr;
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use num_bigint::BigUint;
use num_rational::Ratio;
use num_traits::{ToPrimitive, Zero};
use serde::{Deserialize, Serialize};
use zkapi_solana_types::{FieldElement, MicroUsdc};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BindingConfig {
    pub deployment_id: String,
    pub pool: String,
    pub vault_binding: FieldElement,
    pub state_key: [FieldElement; 2],
    pub cap: MicroUsdc,
    pub control_api_origin: String,
    pub inference_api_origin: String,
    pub quote_key: [u8; 32],
}
#[derive(Clone, Debug)]
pub struct ValidatedRequest {
    pub request_id: uuid::Uuid,
    pub nullifier: FieldElement,
    pub digest: [u8; 32],
    pub transcript: Vec<u8>,
    pub control_hash: [u8; 32],
    pub proxy_hash: Option<[u8; 32]>,
    pub quote_body: Vec<u8>,
    pub quote_hash: [u8; 32],
    pub proof: [u8; 256],
}

pub fn sign_hash<T: Serialize>(body: &T, key: &SigningKey) -> Result<(String, String)> {
    let digest = digest(body)?;
    Ok((
        hex::encode(digest),
        STANDARD.encode(key.sign(&digest).to_bytes()),
    ))
}
pub fn verify_hash_signature<T: Serialize>(
    body: &T,
    expected_hash: &str,
    signature: &str,
    key: &[u8; 32],
) -> Result<()> {
    let digest = digest(body)?;
    if digest != hash(expected_hash)? {
        return Err(invalid("signed body hash"));
    }
    let signature = Signature::from_bytes(&base64_exact(signature)?);
    VerifyingKey::from_bytes(key)
        .map_err(|_| invalid("Ed25519 key"))?
        .verify_strict(&digest, &signature)
        .map_err(|_| invalid("Ed25519 signature"))
}
pub fn quote_body_valid(body: &QuoteBody) -> Result<()> {
    uuid(&body.quote_id)?;
    pubkey(&body.pool)?;
    hash(&body.tariff_hash)?;
    scope_valid(&body.mode, &body.provider, &body.models, body.api.as_ref())?;
    origin(&body.control_api_origin)?;
    origin(&body.inference_api_origin)?;
    let issued = uint(&body.issued_at)?;
    if uint(&body.expires_at)?
        != issued
            .checked_add(120)
            .ok_or(invalid("quote time overflow"))?
        || !(1..=300).contains(&uint(&body.session_ttl_seconds)?)
        || uint(&body.max_concurrency)? != 4
        || body.cap_micro_usdc == MicroUsdc::ZERO
        || body.deployment_id.is_empty()
    {
        return Err(invalid("quote limits"));
    }
    Ok(())
}
pub fn issue_quote(
    request: &QuoteRequest,
    tariff: &Tariff,
    cfg: &BindingConfig,
    now: u64,
    key: &SigningKey,
) -> Result<Quote> {
    scope_valid(
        &request.mode,
        &request.provider,
        &request.models,
        request.api.as_ref(),
    )?;
    validate_tariff(tariff)?;
    if tariff.provider != request.provider
        || tariff.api != request.api
        || (tariff.provider != Provider::Generic && request.models != [tariff.model.clone()])
        || !tariff_valid_at(tariff, now)?
    {
        return Err(invalid("tariff selection"));
    }
    let ttl = uint(request.session_ttl_seconds.as_deref().unwrap_or("60"))?;
    if !(1..=300).contains(&ttl) || key.verifying_key().to_bytes() != cfg.quote_key {
        return Err(invalid("quote configuration"));
    }
    let body = QuoteBody {
        quote_id: uuid::Uuid::new_v4().to_string(),
        deployment_id: cfg.deployment_id.clone(),
        pool: cfg.pool.clone(),
        mode: request.mode.clone(),
        provider: request.provider.clone(),
        models: request.models.clone(),
        api: request.api.clone(),
        tariff_hash: tariff.tariff_hash.clone(),
        cap_micro_usdc: cfg.cap,
        issued_at: now.to_string(),
        expires_at: now
            .checked_add(120)
            .ok_or(invalid("quote time overflow"))?
            .to_string(),
        session_ttl_seconds: ttl.to_string(),
        max_concurrency: "4".into(),
        control_api_origin: cfg.control_api_origin.clone(),
        inference_api_origin: cfg.inference_api_origin.clone(),
    };
    quote_body_valid(&body)?;
    let (quote_hash, signature) = sign_hash(&body, key)?;
    Ok(Quote {
        body,
        quote_hash,
        signature,
    })
}
pub fn tariff_valid_at(tariff: &Tariff, now: u64) -> Result<bool> {
    Ok(uint(&tariff.valid_from)? <= now && now < uint(&tariff.valid_until)?)
}
/// Stable binding checks are safe on both first acceptance and recovery. Quote
/// expiry, current root and consumed state intentionally belong to new admission.
pub fn validate_binding(
    request: &SessionCreate,
    credential: &ControlCredential,
    cfg: &BindingConfig,
) -> Result<ValidatedRequest> {
    let a = &request.authorization;
    let q = &request.quote;
    let b = &q.body;
    let p = &request.public_inputs;
    quote_body_valid(b)?;
    verify_hash_signature(b, &q.quote_hash, &q.signature, &cfg.quote_key)?;
    if a.version != "1"
        || a.deployment_id != cfg.deployment_id
        || b.deployment_id != cfg.deployment_id
        || a.pool != cfg.pool
        || b.pool != cfg.pool
        || a.quote_hash != q.quote_hash
        || a.mode != b.mode
        || b.cap_micro_usdc != cfg.cap
        || b.control_api_origin != cfg.control_api_origin
        || b.inference_api_origin != cfg.inference_api_origin
    {
        return Err(invalid("authorization/quote deployment binding"));
    }
    let request_id = uuid(&a.request_id)?;
    credential_matches(credential, &a.request_id, &a.control_secret_hash)?;
    let proxy_hash = a.proxy_secret_hash.as_deref().map(hash).transpose()?;
    if (a.mode == Mode::Proxy) != proxy_hash.is_some() {
        return Err(invalid("proxy credential binding"));
    }
    let context = zkapi_solana_types::binding::authorization_context(&jcs(a)?)
        .map_err(|_| invalid("authorization context"))?;
    let tag: FieldElement =
        zkapi_proof::groth16::authorization_tag(p[8].to_field(), context.to_field()).into();
    if p[0] != Fr::from(2u64).into()
        || p[1] != Fr::from(zkapi_solana_types::CHAIN_NAMESPACE).into()
        || p[2] != cfg.vault_binding
        || p[4..6] != cfg.state_key
        || p[6] != Fr::from(uint(&b.issued_at)?).into()
        || p[7] != Fr::from(cfg.cap.get()).into()
        || p[9] != tag
    {
        return Err(invalid("request public input binding"));
    }
    crate::crypto::validate_point([p[10], p[11]])?;
    let transcript = jcs(request)?;
    Ok(ValidatedRequest {
        request_id,
        nullifier: p[8],
        digest: sha256(&transcript),
        transcript,
        control_hash: hash(&a.control_secret_hash)?,
        proxy_hash,
        quote_body: jcs(b)?,
        quote_hash: hash(&q.quote_hash)?,
        proof: request.proof.bytes()?,
    })
}
pub fn validate_new(
    request: &SessionCreate,
    tariff: &Tariff,
    now: u64,
    root: FieldElement,
) -> Result<()> {
    let b = &request.quote.body;
    validate_tariff(tariff)?;
    if b.tariff_hash != tariff.tariff_hash
        || !quote_matches_tariff(b, tariff)
        || uint(&b.issued_at)? < uint(&tariff.valid_from)?
        || uint(&b.issued_at)? >= uint(&tariff.valid_until)?
    {
        return Err(invalid("quote tariff"));
    }
    if now < uint(&b.issued_at)? || now >= uint(&b.expires_at)? {
        return Err(ValidationError::Conflict("quote expired"));
    }
    if request.public_inputs[3] != root {
        return Err(ValidationError::Conflict("stale root"));
    }
    Ok(())
}

/// Compare the complete frozen API scope, including generic operation terms.
pub fn quote_matches_tariff(body: &QuoteBody, tariff: &Tariff) -> bool {
    body.provider == tariff.provider
        && body.api == tariff.api
        && if tariff.provider == Provider::Generic {
            body.models.is_empty() && tariff.model.is_empty()
        } else {
            body.models == [tariff.model.clone()]
        }
}

pub fn tariff_body(tariff: &Tariff) -> Result<serde_json::Value> {
    let mut value = serde_json::to_value(tariff).map_err(|_| invalid("tariff"))?;
    value
        .as_object_mut()
        .ok_or(invalid("tariff"))?
        .remove("tariff_hash");
    Ok(value)
}
pub fn tariff_hash(tariff: &Tariff) -> Result<String> {
    Ok(hex::encode(digest(&tariff_body(tariff)?)?))
}
pub fn validate_tariff(tariff: &Tariff) -> Result<()> {
    hash(&tariff.tariff_hash)?;
    if tariff.tariff_hash != tariff_hash(tariff)?
        || uint(&tariff.version)? == 0
        || uint(&tariff.valid_from)? >= uint(&tariff.valid_until)?
        || tariff.operator_fee_micro_usdc != "0"
        || tariff.rates.len() > 6
    {
        return Err(invalid("tariff body"));
    }
    if tariff.pricing_basis == "fixed_request" {
        if tariff.provider != Provider::Generic
            || tariff.version != "2"
            || !tariff.model.is_empty()
            || tariff.rates.len() != 1
            || tariff.rates[0].unit != "requests"
            || tariff.rates[0].unit_denominator != "1"
            || uint(&tariff.rates[0].nano_usdc_numerator)? == 0
        {
            return Err(invalid("fixed request tariff"));
        }
        validate_api_binding(tariff.api.as_ref().ok_or(invalid("missing API binding"))?)?;
    } else {
        if tariff.provider == Provider::Generic || tariff.api.is_some() {
            return Err(invalid("unexpected API binding"));
        }
        units(tariff.rates.iter().map(|r| r.unit.as_str()))?;
    }
    for r in &tariff.rates {
        if uint(&r.nano_usdc_numerator)? > i64::MAX as u64
            || !(1..=i64::MAX as u64).contains(&uint(&r.unit_denominator)?)
        {
            return Err(invalid("tariff rate bounds"));
        }
    }
    match tariff.pricing_basis.as_str() {
        "provider_reported_usd" => {
            if !matches!(tariff.provider, Provider::Oa | Provider::Openrouter)
                || tariff.model != "*"
                || !tariff.rates.is_empty()
            {
                return Err(invalid("direct tariff"));
            }
        }
        "fixed_usage_rates" => {
            if matches!(tariff.provider, Provider::Oa)
                || tariff.model.is_empty()
                || !tariff.model.is_ascii()
                || tariff.model == "*"
                || !["input_tokens", "output_tokens"]
                    .iter()
                    .all(|u| tariff.rates.iter().any(|r| r.unit == *u))
            {
                return Err(invalid("proxy tariff"));
            }
        }
        "fixed_request" => {}
        _ => return Err(invalid("pricing basis")),
    }
    Ok(())
}
fn checked_ceil(value: Ratio<BigUint>) -> Result<u128> {
    let (q, r) = (value.numer() / value.denom(), value.numer() % value.denom());
    let rounded = q + BigUint::from(!r.is_zero() as u8);
    let value = rounded.to_u128().ok_or(invalid("NUMERIC(38,0) overflow"))?;
    if value >= 10u128.pow(38) {
        return Err(invalid("NUMERIC(38,0) overflow"));
    }
    Ok(value)
}
pub fn calculate_charge(tariff: &Tariff, usage: &[Usage]) -> Result<u128> {
    validate_tariff(tariff)?;
    if tariff.pricing_basis == "fixed_request" {
        if usage.len() != 1
            || usage[0].unit != "requests"
            || !matches!(usage[0].count.as_str(), "0" | "1")
        {
            return Err(invalid("fixed request usage"));
        }
        return Ok(u128::from(uint(&tariff.rates[0].nano_usdc_numerator)?)
            * u128::from(uint(&usage[0].count)?));
    }
    if tariff.pricing_basis != "fixed_usage_rates" {
        return Err(invalid("proxy tariff required"));
    }
    units(usage.iter().map(|u| u.unit.as_str()))?;
    if usage.len() != tariff.rates.len() {
        return Err(invalid("missing usage"));
    }
    let mut total = Ratio::<BigUint>::zero();
    for (u, r) in usage.iter().zip(&tariff.rates) {
        let count = uint(&u.count)?;
        if u.unit != r.unit || count > i64::MAX as u64 {
            return Err(invalid("usage mismatch/range"));
        }
        total += Ratio::new(
            BigUint::from(count) * BigUint::from(uint(&r.nano_usdc_numerator)?),
            BigUint::from(uint(&r.unit_denominator)?),
        );
    }
    checked_ceil(total)
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DirectCharge {
    pub normalized_usd: String,
    pub observed_nano: u128,
    pub charged_nano: u128,
    pub operator_loss_nano: u128,
}
/// Parse a JSON number lexeme exactly. Bound digit/exponent lengths before
/// constructing big integers to prevent unbounded work on provider responses.
fn usd_lexeme(text: &str) -> Result<(BigUint, u32)> {
    if text.is_empty() || text.len() > 128 || text.starts_with('-') || text.starts_with('+') {
        return Err(invalid("USD lexeme"));
    }
    let (mantissa, exponent) = if let Some(at) = text.find(['e', 'E']) {
        let (m, e) = text.split_at(at);
        let exponent = e[1..].parse::<i32>().map_err(|_| invalid("USD exponent"))?;
        if !(-128..=128).contains(&exponent) {
            return Err(invalid("USD exponent bound"));
        }
        (m, exponent)
    } else {
        (text, 0)
    };
    let mut parts = mantissa.split('.');
    let integer = parts.next().unwrap();
    let fraction = parts.next();
    if parts.next().is_some()
        || integer.is_empty()
        || !integer.bytes().all(|x| x.is_ascii_digit())
        || (integer.len() > 1 && integer.starts_with('0'))
        || fraction.is_some_and(|f| f.is_empty() || !f.bytes().all(|x| x.is_ascii_digit()))
    {
        return Err(invalid("USD decimal"));
    }
    let fraction = fraction.unwrap_or("");
    let digits = format!("{integer}{fraction}");
    let mut number = BigUint::parse_bytes(digits.as_bytes(), 10).ok_or(invalid("USD decimal"))?;
    let scale = fraction.len() as i32 - exponent;
    if scale < 0 {
        number *= BigUint::from(10u8).pow((-scale) as u32);
        Ok((number, 0))
    } else {
        Ok((number, scale as u32))
    }
}
pub fn direct_charge(values: &[&str], cap: MicroUsdc) -> Result<DirectCharge> {
    if values.is_empty() || values.len() > 1024 {
        return Err(invalid("missing or excessive direct usage"));
    }
    let parts = values
        .iter()
        .map(|s| usd_lexeme(s))
        .collect::<Result<Vec<_>>>()?;
    let scale = parts.iter().map(|p| p.1).max().unwrap();
    let total = parts.into_iter().fold(BigUint::zero(), |a, (n, s)| {
        a + n * BigUint::from(10u8).pow(scale - s)
    });
    let mut digits = total.to_str_radix(10);
    let normalized_usd = if total.is_zero() {
        "0".to_string()
    } else if scale == 0 {
        digits
    } else {
        if digits.len() <= scale as usize {
            digits = format!(
                "{}{}",
                "0".repeat(scale as usize + 1 - digits.len()),
                digits
            )
        }
        digits.insert(digits.len() - scale as usize, '.');
        digits
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_owned()
    };
    if normalized_usd.len() > 128 {
        return Err(invalid("USD receipt length"));
    }
    let observed_nano = checked_ceil(Ratio::new(
        total * BigUint::from(1_000_000_000u64),
        BigUint::from(10u8).pow(scale),
    ))?;
    let charged_nano = observed_nano.min(cap.as_nano());
    Ok(DirectCharge {
        normalized_usd,
        observed_nano,
        charged_nano,
        operator_loss_nano: observed_nano - charged_nano,
    })
}

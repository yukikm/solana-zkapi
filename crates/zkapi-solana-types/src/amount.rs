use crate::Error;
use serde::{de::Error as _, Deserialize, Deserializer, Serialize, Serializer};
use std::str::FromStr;

pub const MAX_MICRO_USDC: u64 = 9_007_199_254_740_991;
pub const NANOS_PER_MICRO: u128 = 1_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct MicroUsdc(u64);

impl MicroUsdc {
    pub const ZERO: Self = Self(0);

    pub fn new(value: u64) -> Result<Self, Error> {
        if value > MAX_MICRO_USDC {
            return Err(Error::OutOfRange);
        }
        Ok(Self(value))
    }

    pub fn get(self) -> u64 {
        self.0
    }
    pub fn as_nano(self) -> u128 {
        u128::from(self.0) * NANOS_PER_MICRO
    }

    pub fn checked_add(self, other: Self) -> Result<Self, Error> {
        let sum = u128::from(self.0) + u128::from(other.0);
        if sum > u128::from(MAX_MICRO_USDC) {
            return Err(Error::OutOfRange);
        }
        Self::new(sum as u64)
    }

    pub fn checked_sub(self, other: Self) -> Result<Self, Error> {
        self.0
            .checked_sub(other.0)
            .ok_or(Error::OutOfRange)
            .and_then(Self::new)
    }
}

impl FromStr for MicroUsdc {
    type Err = Error;
    fn from_str(text: &str) -> Result<Self, Error> {
        if text.is_empty()
            || !text.bytes().all(|b| b.is_ascii_digit())
            || (text.len() > 1 && text.starts_with('0'))
        {
            return Err(Error::InvalidEncoding);
        }
        Self::new(text.parse().map_err(|_| Error::OutOfRange)?)
    }
}

impl Serialize for MicroUsdc {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for MicroUsdc {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        String::deserialize(deserializer)?
            .parse()
            .map_err(D::Error::custom)
    }
}

/// Accumulate all operation nano charges before the session's single rounding.
pub fn settle_session(
    charges: impl IntoIterator<Item = u128>,
    cap: MicroUsdc,
) -> Result<MicroUsdc, Error> {
    let total = charges
        .into_iter()
        .try_fold(0u128, |sum, n| sum.checked_add(n).ok_or(Error::Overflow))?;
    if total > cap.as_nano() {
        return Err(Error::BudgetExceeded);
    }
    let micro = total / NANOS_PER_MICRO + u128::from(total % NANOS_PER_MICRO != 0);
    MicroUsdc::new(u64::try_from(micro).map_err(|_| Error::Overflow)?)
}

/// Pure arithmetic helper; the ledger must hold the session row lock around use.
pub fn check_reservation(
    charged: u128,
    reserved: u128,
    requested: u128,
    cap: MicroUsdc,
) -> Result<(), Error> {
    let total = charged
        .checked_add(reserved)
        .and_then(|n| n.checked_add(requested))
        .ok_or(Error::Overflow)?;
    if total > cap.as_nano() {
        return Err(Error::BudgetExceeded);
    }
    Ok(())
}

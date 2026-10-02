use ark_ff::{BigInteger, PrimeField};
use serde::{de::Error as _, Deserialize, Deserializer, Serialize, Serializer};
use std::str::FromStr;

use crate::Error;

pub fn field_bytes<F: PrimeField>(value: F) -> [u8; 32] {
    let raw = value.into_bigint().to_bytes_be();
    let mut bytes = [0; 32];
    bytes[32 - raw.len()..].copy_from_slice(&raw);
    bytes
}

macro_rules! canonical_field {
    ($name:ident, $field:ty) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub struct $name([u8; 32]);

        impl $name {
            pub const ZERO: Self = Self([0; 32]);

            pub fn from_bytes(bytes: [u8; 32]) -> Result<Self, Error> {
                let value = <$field>::from_be_bytes_mod_order(&bytes);
                if field_bytes(value) != bytes {
                    return Err(Error::OutOfRange);
                }
                Ok(Self(bytes))
            }

            pub fn as_bytes(&self) -> &[u8; 32] {
                &self.0
            }

            pub fn to_field(self) -> $field {
                <$field>::from_be_bytes_mod_order(&self.0)
            }
        }

        impl From<$field> for $name {
            fn from(value: $field) -> Self {
                Self(field_bytes(value))
            }
        }

        impl FromStr for $name {
            type Err = Error;
            fn from_str(text: &str) -> Result<Self, Error> {
                if text.len() != 66
                    || !text.starts_with("0x")
                    || !text.as_bytes()[2..]
                        .iter()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
                {
                    return Err(Error::InvalidEncoding);
                }
                let mut bytes = [0; 32];
                hex::decode_to_slice(&text[2..], &mut bytes).map_err(|_| Error::InvalidEncoding)?;
                Self::from_bytes(bytes)
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "0x{}", hex::encode(self.0))
            }
        }

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.collect_str(self)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                String::deserialize(deserializer)?
                    .parse()
                    .map_err(D::Error::custom)
            }
        }
    };
}

canonical_field!(FieldElement, ark_bn254::Fr);
canonical_field!(Scalar, ark_ed_on_bn254::Fr);

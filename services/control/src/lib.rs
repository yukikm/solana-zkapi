//! Prompt-free control plane and persistent, single-writer financial ledger.
pub mod api;
pub mod chain;
pub mod config;
pub mod crypto;
pub mod direct;
pub mod dispatcher;
pub mod faults;
pub mod inference;
mod inference_diagnostics;
pub mod ledger;
pub mod provider_runtime;
pub mod proxy;
pub mod quote;
pub mod receipts;
pub mod signer;
pub mod signer_client;
pub mod wire;

pub mod egress;
pub mod operations;

pub mod custody;
pub mod monitoring;
pub mod mtls;

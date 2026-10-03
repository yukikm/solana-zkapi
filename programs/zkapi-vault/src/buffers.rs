//! Authenticated, rent-funded layout-2 transport. Uploads never mutate the Vault.
use crate::{handlers, *};
use solana_program::hash::hash;

pub const MAX_PAYLOAD: usize = 4096;
pub const MAX_LIFETIME: u64 = 3600;

fn load(account: &AccountInfo, pool: &AccountInfo) -> Result<PayloadBuffer> {
    handlers::pool(pool)?;
    let buffer: PayloadBuffer =
        handlers::decode(account).map_err(|_| error!(VaultError::InvalidBuffer))?;
    let op = Operation::from_byte(buffer.op).map_err(|_| error!(VaultError::InvalidBuffer))?;
    require!(
        buffer.layout_version == 2
            && buffer.payload_len as usize == op.payload_len()
            && buffer.payload.len() == buffer.payload_len as usize
            && buffer.payload.len() <= MAX_PAYLOAD
            && buffer.next_offset <= buffer.payload_len
            && (!buffer.sealed || buffer.next_offset == buffer.payload_len)
            && account.data_len() == PayloadBuffer::HEADER_SPACE + buffer.payload.len(),
        VaultError::InvalidBuffer
    );
    let (key, bump) = Pubkey::find_program_address(
        &[
            b"payload",
            pool.key.as_ref(),
            buffer.uploader.as_ref(),
            &buffer.nonce,
        ],
        &crate::ID,
    );
    require!(
        key == *account.key && bump == buffer.bump,
        VaultError::InvalidBuffer
    );
    Ok(buffer)
}

pub fn create(
    a: &CreatePayload,
    op: u8,
    len: u32,
    digest: [u8; 32],
    nonce: [u8; 32],
    expires: u64,
) -> Result<()> {
    handlers::pool(&a.pool)?;
    let operation = Operation::from_byte(op).map_err(|_| error!(VaultError::InvalidBuffer))?;
    require!(
        len as usize == operation.payload_len() && len as usize <= MAX_PAYLOAD,
        VaultError::InvalidBuffer
    );
    let now = handlers::now()?;
    let latest = handlers::add(now, MAX_LIFETIME)?;
    require!(
        now < expires && expires <= latest,
        VaultError::InvalidBuffer
    );
    require!(
        a.payload.key() != a.rent_payer.key(),
        VaultError::InvalidBuffer
    );
    let pool = a.pool.key();
    let uploader = a.uploader.key();
    let bump = handlers::create(
        &a.payload,
        &a.rent_payer,
        &a.system_program,
        &[b"payload", pool.as_ref(), uploader.as_ref(), &nonce],
        PayloadBuffer::HEADER_SPACE + len as usize,
    )?;
    handlers::save(
        &a.payload,
        &PayloadBuffer {
            layout_version: 2,
            bump,
            uploader,
            op,
            payload_len: len,
            digest,
            next_offset: 0,
            sealed: false,
            expires,
            rent_payer: a.rent_payer.key(),
            payload: vec![0; len as usize],
            nonce,
        },
    )
}

pub fn append(a: &UploadPayload, offset: u32, bytes: &[u8]) -> Result<()> {
    let mut buffer = load(&a.payload, &a.pool)?;
    require!(
        buffer.uploader == a.uploader.key()
            && !buffer.sealed
            && handlers::now()? < buffer.expires
            && offset == buffer.next_offset,
        VaultError::InvalidBuffer
    );
    let end = (offset as usize)
        .checked_add(bytes.len())
        .filter(|end| *end <= buffer.payload.len())
        .ok_or_else(|| error!(VaultError::InvalidBuffer))?;
    buffer.payload[offset as usize..end].copy_from_slice(bytes);
    buffer.next_offset = end as u32;
    handlers::save(&a.payload, &buffer)
}

pub fn seal(a: &UploadPayload) -> Result<()> {
    let mut buffer = load(&a.payload, &a.pool)?;
    require!(
        buffer.uploader == a.uploader.key()
            && !buffer.sealed
            && handlers::now()? < buffer.expires
            && buffer.next_offset == buffer.payload_len
            && hash(&buffer.payload).to_bytes() == buffer.digest,
        VaultError::InvalidBuffer
    );
    buffer.sealed = true;
    handlers::save(&a.payload, &buffer)
}

pub fn close(a: &ClosePayload) -> Result<()> {
    let buffer = load(&a.payload, &a.pool)?;
    require!(
        a.closer.key() == buffer.uploader || handlers::now()? >= buffer.expires,
        VaultError::InvalidBuffer
    );
    require!(
        a.rent_payer.key() == buffer.rent_payer && a.payload.key() != a.rent_payer.key(),
        VaultError::InvalidBuffer
    );
    let refund = handlers::add(a.rent_payer.lamports(), a.payload.lamports())?;
    **a.rent_payer.try_borrow_mut_lamports()? = refund;
    **a.payload.try_borrow_mut_lamports()? = 0;
    a.payload.assign(&System::id());
    a.payload.realloc(0, false)?;
    Ok(())
}

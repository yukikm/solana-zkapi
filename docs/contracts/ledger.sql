-- Design contract, PostgreSQL. Not applied to a database in this design task.
-- Only the fenced pool writer may mutate financial tables.
-- Session FOR UPDATE + transaction is required for admission/reservation/settlement.
BEGIN;

CREATE DOMAIN bytes32 AS bytea CHECK (octet_length(VALUE) = 32);
CREATE DOMAIN amount_micro AS bigint CHECK (VALUE BETWEEN 0 AND 9007199254740991);
CREATE DOMAIN amount_nano AS numeric(38,0) CHECK (VALUE >= 0);

CREATE TABLE pools (
    pool bytes32 PRIMARY KEY,
    deployment_id text NOT NULL UNIQUE,
    manifest_hash bytes32 NOT NULL,
    writer_epoch bigint NOT NULL DEFAULT 0 CHECK (writer_epoch >= 0),
    accepting boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tariffs (
    tariff_hash bytes32 PRIMARY KEY,
    canonical_body bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quotes (
    pool bytes32 NOT NULL REFERENCES pools,
    quote_id uuid NOT NULL,
    quote_hash bytes32 NOT NULL,
    canonical_body bytea NOT NULL,
    signature bytea NOT NULL CHECK (octet_length(signature) = 64),
    tariff_hash bytes32 NOT NULL REFERENCES tariffs,
    expires_at bigint NOT NULL CHECK (expires_at >= 0),
    PRIMARY KEY (pool, quote_id),
    UNIQUE (pool, quote_hash)
);

CREATE TABLE nullifier_reservations (
    pool bytes32 NOT NULL REFERENCES pools,
    nullifier bytes32 NOT NULL,
    kind text NOT NULL CHECK (kind IN ('AUTH','CLEARANCE')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (pool, nullifier),
    UNIQUE (pool, nullifier, kind)
);

CREATE TABLE sessions (
    pool bytes32 NOT NULL,
    request_id uuid NOT NULL,
    nullifier bytes32 NOT NULL,
    reservation_kind text NOT NULL DEFAULT 'AUTH' CHECK (reservation_kind = 'AUTH'),
    quote_id uuid NOT NULL,
    request_digest bytes32 NOT NULL,
    request_transcript bytea NOT NULL, -- canonical prompt-free body, public inputs and proof
    control_secret_hash bytes32 NOT NULL,
    proxy_secret_hash bytes32,
    mode text NOT NULL CHECK (mode IN ('proxy','direct_openrouter','direct_oa')),
    provider text NOT NULL,
    state text NOT NULL CHECK (state IN ('RESERVED','ISSUING','ISSUANCE_UNKNOWN','ACTIVE',
        'DRAINING','RECONCILING','SIGN_PENDING','SETTLED')),
    close_requested boolean NOT NULL DEFAULT false,
    cap_micro amount_micro NOT NULL CHECK (cap_micro > 0),
    charged_nano amount_nano NOT NULL DEFAULT 0,
    reserved_nano amount_nano NOT NULL DEFAULT 0,
    max_concurrency smallint NOT NULL CHECK (max_concurrency BETWEEN 1 AND 4),
    active_operations smallint NOT NULL DEFAULT 0 CHECK (active_operations >= 0),
    activated_at bigint,
    expires_at bigint,
    provider_key_ref text, -- upstream management identifier, never plaintext key
    writer_epoch bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (pool, request_id),
    UNIQUE (pool, nullifier),
    UNIQUE (pool, quote_id),
    FOREIGN KEY (pool, nullifier, reservation_kind)
        REFERENCES nullifier_reservations(pool, nullifier, kind),
    FOREIGN KEY (pool, quote_id) REFERENCES quotes,
    CHECK ((mode = 'proxy') = (proxy_secret_hash IS NOT NULL)),
    CHECK (charged_nano + reserved_nano <= cap_micro::numeric * 1000),
    CHECK (active_operations <= max_concurrency),
    CHECK (expires_at IS NULL OR expires_at >= activated_at)
);

CREATE TABLE operations (
    pool bytes32 NOT NULL,
    request_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    request_hmac bytes32 NOT NULL,
    endpoint text NOT NULL,
    model text NOT NULL,
    state text NOT NULL CHECK (state IN ('RESERVED','DISPATCHING','STREAMING',
        'USAGE_UNKNOWN','METERED','DONE','WAIVED_OPERATOR_LOSS')),
    reservation_nano amount_nano NOT NULL,
    charged_nano amount_nano NOT NULL DEFAULT 0,
    observed_cost_nano amount_nano,
    operator_loss_nano amount_nano NOT NULL DEFAULT 0,
    provider_request_id text,
    usage_metadata jsonb, -- token counts and evidence only, no prompts/responses
    dispatched_at bigint,
    reconcile_deadline bigint,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (pool, request_id, operation_id),
    FOREIGN KEY (pool, request_id) REFERENCES sessions,
    CHECK (charged_nano <= reservation_nano),
    CHECK (state <> 'WAIVED_OPERATOR_LOSS' OR charged_nano = 0)
);

CREATE TABLE settlements (
    pool bytes32 NOT NULL,
    request_id uuid NOT NULL,
    charge_micro amount_micro NOT NULL,
    next_anchor bytes32 NOT NULL,
    next_commitment_x bytes32 NOT NULL,
    next_commitment_y bytes32 NOT NULL,
    blind_delta bytes32 NOT NULL,
    signature_message bytea NOT NULL,
    message_digest bytes32 NOT NULL,
    state_signature bytea,
    created_at timestamptz NOT NULL DEFAULT now(),
    signed_at timestamptz,
    PRIMARY KEY (pool, request_id),
    FOREIGN KEY (pool, request_id) REFERENCES sessions
);

CREATE TABLE clearances (
    pool bytes32 NOT NULL,
    nullifier bytes32 NOT NULL,
    reservation_kind text NOT NULL DEFAULT 'CLEARANCE' CHECK (reservation_kind = 'CLEARANCE'),
    message_digest bytes32 NOT NULL,
    signature bytea,
    PRIMARY KEY (pool, nullifier),
    FOREIGN KEY (pool, nullifier, reservation_kind)
        REFERENCES nullifier_reservations(pool, nullifier, kind)
);

CREATE TABLE provider_evidence (
    evidence_id uuid PRIMARY KEY,
    pool bytes32 NOT NULL,
    request_id uuid NOT NULL,
    operation_id uuid,
    kind text NOT NULL CHECK (kind IN ('OA_SIGNED_RECEIPT','OPENROUTER_USAGE',
        'PROXY_USAGE','UNKNOWN_OPERATOR_LOSS')),
    digest bytes32 NOT NULL,
    encrypted_record bytea NOT NULL,
    observed_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (pool, request_id) REFERENCES sessions
);

CREATE TABLE chain_checkpoints (
    pool bytes32 PRIMARY KEY REFERENCES pools,
    finalized_slot bigint NOT NULL CHECK (finalized_slot >= 0),
    blockhash bytes32 NOT NULL,
    tree_sequence numeric(20,0) NOT NULL CHECK (tree_sequence >= 0),
    root bytes32 NOT NULL,
    snapshot_hash bytes32 NOT NULL
);

CREATE TABLE chain_events (
    pool bytes32 NOT NULL REFERENCES pools,
    signature bytea NOT NULL CHECK (octet_length(signature) = 64),
    instruction_index integer NOT NULL CHECK (instruction_index >= 0),
    event_index integer NOT NULL CHECK (event_index >= 0),
    slot bigint NOT NULL,
    event_body jsonb NOT NULL,
    PRIMARY KEY (pool, signature, instruction_index, event_index)
);

CREATE TABLE chain_transactions (
    pool bytes32 NOT NULL REFERENCES pools,
    operation_id uuid NOT NULL,
    payload_hash bytes32 NOT NULL,
    transaction_signature bytea,
    blockhash bytes32,
    last_valid_block_height bigint,
    state text NOT NULL CHECK (state IN ('PREPARED','SENT','UNKNOWN','CONFIRMED','FINALIZED','EXPIRED','FAILED')),
    PRIMARY KEY (pool, operation_id)
);

CREATE TABLE outbox (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    pool bytes32 NOT NULL REFERENCES pools,
    dedup_key text NOT NULL,
    event_type text NOT NULL,
    metadata jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    UNIQUE (pool, dedup_key)
);

CREATE INDEX pending_sessions ON sessions(pool,state) WHERE state <> 'SETTLED';
CREATE INDEX pending_operations ON operations(pool,state,reconcile_deadline)
    WHERE state NOT IN ('DONE','WAIVED_OPERATOR_LOSS');
CREATE INDEX unpublished_outbox ON outbox(id) WHERE completed_at IS NULL;

-- Preserve sign-once content even if the signing response is lost.
CREATE FUNCTION protect_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'settlement deletion forbidden'; END IF;
    IF ROW(NEW.pool,NEW.request_id,NEW.charge_micro,NEW.next_anchor,
           NEW.next_commitment_x,NEW.next_commitment_y,NEW.blind_delta,
           NEW.signature_message,NEW.message_digest)
       IS DISTINCT FROM
       ROW(OLD.pool,OLD.request_id,OLD.charge_micro,OLD.next_anchor,
           OLD.next_commitment_x,OLD.next_commitment_y,OLD.blind_delta,
           OLD.signature_message,OLD.message_digest) THEN
        RAISE EXCEPTION 'settlement content is immutable';
    END IF;
    IF OLD.state_signature IS NOT NULL AND NEW.state_signature IS DISTINCT FROM OLD.state_signature THEN
        RAISE EXCEPTION 'settlement signature is immutable';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER settlement_immutable BEFORE UPDATE OR DELETE ON settlements
    FOR EACH ROW EXECUTE FUNCTION protect_settlement();

-- Runtime roles must not DELETE/TRUNCATE reservations, sessions or sign journals.
-- Migration role is separate. This schema alone does not enforce every transition:
-- worker fencing, state CAS, credential checks and row-lock operations are mandatory.
COMMIT;

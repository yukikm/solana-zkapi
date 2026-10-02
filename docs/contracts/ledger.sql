-- Design contract, PostgreSQL. Not applied to a database in this design task.
-- Only the fenced pool writer may mutate financial tables.
-- Session FOR UPDATE + transaction is required for admission/reservation/settlement.
BEGIN;

CREATE DOMAIN bytes32 AS bytea CHECK (octet_length(VALUE) = 32);
CREATE DOMAIN amount_micro AS bigint CHECK (VALUE BETWEEN 0 AND 9007199254740991);
CREATE DOMAIN amount_nano AS numeric(38,0) CHECK (VALUE >= 0 AND VALUE <> 'NaN'::numeric);

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
    writer_epoch bigint NOT NULL CHECK (writer_epoch >= 0),
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
    CHECK ((activated_at IS NULL AND expires_at IS NULL) OR
           (activated_at IS NOT NULL AND expires_at IS NOT NULL AND activated_at >= 0 AND expires_at >= activated_at))
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

-- Immutable ownership: never reassign an uncertain external call to another owner.
CREATE TABLE dispatch_attempts (
    attempt_id uuid PRIMARY KEY,
    pool bytes32 NOT NULL,
    request_id uuid NOT NULL,
    operation_id uuid,
    kind text NOT NULL CHECK (kind IN ('DIRECT_ISSUANCE','PROXY_INFERENCE')),
    writer_epoch bigint NOT NULL CHECK (writer_epoch >= 0),
    owner_instance uuid NOT NULL,
    committed_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    fenced_at timestamptz,
    fence_evidence_digest bytes32,
    FOREIGN KEY (pool, request_id) REFERENCES sessions,
    FOREIGN KEY (pool, request_id, operation_id) REFERENCES operations,
    CHECK ((kind = 'DIRECT_ISSUANCE') = (operation_id IS NULL)),
    CHECK ((fenced_at IS NULL) = (fence_evidence_digest IS NULL)),
    CHECK (finished_at IS NULL OR finished_at >= committed_at),
    CHECK (fenced_at IS NULL OR fenced_at >= committed_at)
);
CREATE UNIQUE INDEX one_direct_attempt ON dispatch_attempts(pool,request_id)
    WHERE kind = 'DIRECT_ISSUANCE';
CREATE UNIQUE INDEX one_proxy_attempt ON dispatch_attempts(pool,request_id,operation_id)
    WHERE kind = 'PROXY_INFERENCE';

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

-- Public, prompt-free receipt bytes. Hash/signature verification is a service obligation.
CREATE TABLE receipts (
    sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    receipt_id uuid PRIMARY KEY,
    pool bytes32 NOT NULL,
    request_id uuid NOT NULL,
    operation_id uuid,
    billing_effect text NOT NULL CHECK (billing_effect IN ('charge','late_loss_observation')),
    canonical_body bytea NOT NULL,
    receipt_hash bytes32 NOT NULL UNIQUE,
    signature bytea CHECK (octet_length(signature) = 64),
    FOREIGN KEY (pool, request_id) REFERENCES sessions,
    FOREIGN KEY (pool, request_id, operation_id) REFERENCES operations
);
CREATE UNIQUE INDEX one_operation_charge_receipt ON receipts(pool,request_id,operation_id)
    WHERE billing_effect = 'charge' AND operation_id IS NOT NULL;
CREATE UNIQUE INDEX one_direct_charge_receipt ON receipts(pool,request_id)
    WHERE billing_effect = 'charge' AND operation_id IS NULL;

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
    IF TG_OP = 'INSERT' THEN
        PERFORM 1 FROM sessions s WHERE s.pool = NEW.pool AND s.request_id = NEW.request_id
            AND s.state = 'RECONCILING' AND s.reserved_nano = 0 AND s.active_operations = 0
            AND NEW.charge_micro = ceil(s.charged_nano / 1000) AND NEW.charge_micro <= s.cap_micro
            FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'session is not ready for settlement'; END IF;
        IF EXISTS (SELECT 1 FROM operations o WHERE o.pool = NEW.pool AND o.request_id = NEW.request_id
                   AND o.state NOT IN ('DONE','WAIVED_OPERATOR_LOSS')) OR
           EXISTS (SELECT 1 FROM dispatch_attempts d WHERE d.pool = NEW.pool AND d.request_id = NEW.request_id
                   AND d.finished_at IS NULL AND d.fenced_at IS NULL) THEN
            RAISE EXCEPTION 'outstanding operation or unfenced dispatch';
        END IF;
        RETURN NEW;
    END IF;
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
CREATE TRIGGER settlement_immutable BEFORE INSERT OR UPDATE OR DELETE ON settlements
    FOR EACH ROW EXECUTE FUNCTION protect_settlement();

CREATE FUNCTION protect_dispatch_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'dispatch attempt deletion forbidden'; END IF;
    IF ROW(NEW.attempt_id,NEW.pool,NEW.request_id,NEW.operation_id,NEW.kind,
           NEW.writer_epoch,NEW.owner_instance,NEW.committed_at) IS DISTINCT FROM
       ROW(OLD.attempt_id,OLD.pool,OLD.request_id,OLD.operation_id,OLD.kind,
           OLD.writer_epoch,OLD.owner_instance,OLD.committed_at) THEN
        RAISE EXCEPTION 'dispatch ownership is immutable';
    END IF;
    IF (OLD.finished_at IS NOT NULL AND NEW.finished_at IS DISTINCT FROM OLD.finished_at) OR
       (OLD.fenced_at IS NOT NULL AND ROW(NEW.fenced_at,NEW.fence_evidence_digest) IS DISTINCT FROM
                                      ROW(OLD.fenced_at,OLD.fence_evidence_digest)) THEN
        RAISE EXCEPTION 'dispatch completion evidence is immutable';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER dispatch_immutable BEFORE UPDATE OR DELETE ON dispatch_attempts
    FOR EACH ROW EXECUTE FUNCTION protect_dispatch_attempt();

-- Canonical receipt content never changes; signature may only be filled once.
CREATE FUNCTION protect_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'receipt deletion forbidden'; END IF;
    IF ROW(NEW.sequence,NEW.receipt_id,NEW.pool,NEW.request_id,NEW.operation_id,
           NEW.billing_effect,NEW.canonical_body,NEW.receipt_hash) IS DISTINCT FROM
       ROW(OLD.sequence,OLD.receipt_id,OLD.pool,OLD.request_id,OLD.operation_id,
           OLD.billing_effect,OLD.canonical_body,OLD.receipt_hash) THEN
        RAISE EXCEPTION 'receipt content is immutable';
    END IF;
    IF OLD.signature IS NOT NULL AND NEW.signature IS DISTINCT FROM OLD.signature THEN
        RAISE EXCEPTION 'receipt signature is immutable';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER receipt_immutable BEFORE UPDATE OR DELETE ON receipts
    FOR EACH ROW EXECUTE FUNCTION protect_receipt();

-- Runtime roles must not DELETE/TRUNCATE reservations, sessions or sign journals.
-- Migration role is separate. This schema alone does not enforce every transition:
-- worker/egress fencing, immutable attempt ownership, state CAS, credential checks and row-lock operations are mandatory.
-- Signer rechecks quiesced attempts, terminal operations, signed receipt totals and immutable settlement bytes.
-- A database timestamp alone is not evidence of external egress fencing.
COMMIT;

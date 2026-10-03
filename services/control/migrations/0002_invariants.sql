-- A separate migration owner applies this file. Runtime roles own no schema objects.
ALTER TABLE pools ADD COLUMN authorization_config jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE sessions ADD COLUMN direct_stop_evidence bytes32;
ALTER TABLE settlements ADD COLUMN anchor_randomness bytes32 NOT NULL;
ALTER TABLE clearances ADD COLUMN signature_message bytea NOT NULL CHECK (octet_length(signature_message)=32);
ALTER TABLE dispatch_attempts ADD COLUMN send_claimed_at timestamptz;
ALTER TABLE dispatch_attempts ADD COLUMN finish_evidence_digest bytes32;
ALTER TABLE dispatch_attempts ADD CONSTRAINT finished_evidence CHECK ((finished_at IS NULL) = (finish_evidence_digest IS NULL));

CREATE FUNCTION reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable ledger record'; END; $$;
CREATE TRIGGER tariffs_immutable BEFORE UPDATE OR DELETE ON tariffs FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER quotes_immutable BEFORE UPDATE OR DELETE ON quotes FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER reservations_immutable BEFORE UPDATE OR DELETE ON nullifier_reservations FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE FUNCTION protect_pool() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.pool,NEW.deployment_id,NEW.manifest_hash,NEW.authorization_config,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.pool,OLD.deployment_id,OLD.manifest_hash,OLD.authorization_config,OLD.created_at)
 OR NEW.writer_epoch < OLD.writer_epoch THEN RAISE EXCEPTION 'pool identity is immutable'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER pool_immutable BEFORE UPDATE ON pools FOR EACH ROW EXECUTE FUNCTION protect_pool();

CREATE FUNCTION protect_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.pool,NEW.request_id,NEW.nullifier,NEW.reservation_kind,NEW.quote_id,
 NEW.request_digest,NEW.request_transcript,NEW.control_secret_hash,NEW.proxy_secret_hash,
 NEW.mode,NEW.provider,NEW.cap_micro,NEW.max_concurrency,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.pool,OLD.request_id,OLD.nullifier,OLD.reservation_kind,OLD.quote_id,
 OLD.request_digest,OLD.request_transcript,OLD.control_secret_hash,OLD.proxy_secret_hash,
 OLD.mode,OLD.provider,OLD.cap_micro,OLD.max_concurrency,OLD.created_at) THEN
 RAISE EXCEPTION 'accepted session identity is immutable'; END IF;
 IF OLD.provider_key_ref IS NOT NULL AND NEW.provider_key_ref IS DISTINCT FROM OLD.provider_key_ref THEN RAISE EXCEPTION 'direct key reference is immutable'; END IF;
 IF OLD.close_requested AND NOT NEW.close_requested THEN RAISE EXCEPTION 'close cannot be undone'; END IF;
 IF OLD.activated_at IS NOT NULL AND ROW(NEW.activated_at,NEW.expires_at) IS DISTINCT FROM ROW(OLD.activated_at,OLD.expires_at) THEN
 RAISE EXCEPTION 'activation deadline is immutable'; END IF;
 IF OLD.direct_stop_evidence IS NOT NULL AND NEW.direct_stop_evidence IS DISTINCT FROM OLD.direct_stop_evidence THEN RAISE EXCEPTION 'direct stopping evidence is immutable'; END IF;
 IF OLD.state='SETTLED' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'settled session is immutable'; END IF;
 IF NEW.state <> OLD.state AND NOT (
 (OLD.state='RESERVED' AND NEW.state IN ('ISSUING','ACTIVE','RECONCILING')) OR
 (OLD.state='ISSUING' AND NEW.state IN ('ACTIVE','ISSUANCE_UNKNOWN','DRAINING','RECONCILING')) OR
 (OLD.state='ISSUANCE_UNKNOWN' AND NEW.state IN ('DRAINING','RECONCILING')) OR
 (OLD.state='ACTIVE' AND NEW.state='DRAINING') OR
 (OLD.state='DRAINING' AND NEW.state='RECONCILING') OR
 (OLD.state='RECONCILING' AND NEW.state='SIGN_PENDING') OR
 (OLD.state='SIGN_PENDING' AND NEW.state='SETTLED')) THEN
 RAISE EXCEPTION 'invalid session transition'; END IF;
 IF NEW.state='SIGN_PENDING' AND NEW.mode<>'proxy' AND NEW.direct_stop_evidence IS NULL THEN RAISE EXCEPTION 'direct key stop evidence missing'; END IF;
 IF NEW.state='SIGN_PENDING' AND NOT EXISTS (SELECT 1 FROM settlements x WHERE x.pool=NEW.pool AND x.request_id=NEW.request_id) THEN
 RAISE EXCEPTION 'settlement target must be stored first'; END IF;
 IF NEW.state='SETTLED' AND NOT EXISTS (SELECT 1 FROM settlements x WHERE x.pool=NEW.pool AND x.request_id=NEW.request_id AND state_signature IS NOT NULL) THEN
 RAISE EXCEPTION 'signature must be stored first'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER session_immutable BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION protect_session();

CREATE FUNCTION protect_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.pool,NEW.request_id,NEW.operation_id,NEW.request_hmac,NEW.endpoint,NEW.model,NEW.reservation_nano,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.pool,OLD.request_id,OLD.operation_id,OLD.request_hmac,OLD.endpoint,OLD.model,OLD.reservation_nano,OLD.created_at)
 THEN RAISE EXCEPTION 'operation identity is immutable'; END IF;
 IF OLD.dispatched_at IS NOT NULL AND ROW(NEW.dispatched_at,NEW.reconcile_deadline) IS DISTINCT FROM ROW(OLD.dispatched_at,OLD.reconcile_deadline) THEN RAISE EXCEPTION 'dispatch time is immutable'; END IF;
 IF OLD.provider_request_id IS NOT NULL AND NEW.provider_request_id IS DISTINCT FROM OLD.provider_request_id THEN RAISE EXCEPTION 'provider request is immutable'; END IF;
 IF OLD.state IN ('DONE','WAIVED_OPERATOR_LOSS') AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'terminal operation is immutable'; END IF;
 IF NEW.state <> OLD.state AND NOT (
 (OLD.state='RESERVED' AND NEW.state IN ('DISPATCHING','DONE')) OR
 (OLD.state='DISPATCHING' AND NEW.state IN ('STREAMING','USAGE_UNKNOWN','METERED')) OR
 (OLD.state='STREAMING' AND NEW.state IN ('USAGE_UNKNOWN','METERED')) OR
 (OLD.state='USAGE_UNKNOWN' AND NEW.state IN ('METERED','WAIVED_OPERATOR_LOSS')) OR
 (OLD.state='METERED' AND NEW.state='DONE')) THEN RAISE EXCEPTION 'invalid operation transition'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER operation_immutable BEFORE UPDATE ON operations FOR EACH ROW EXECUTE FUNCTION protect_operation();

CREATE FUNCTION protect_extra_target() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='settlements' AND NEW.anchor_randomness IS DISTINCT FROM OLD.anchor_randomness THEN
 RAISE EXCEPTION 'settlement randomness is immutable'; END IF;
 IF TG_TABLE_NAME='clearances' AND NEW.signature_message IS DISTINCT FROM OLD.signature_message THEN
 RAISE EXCEPTION 'clearance message is immutable'; END IF;
 RETURN NEW;
END; $$;
-- Separate functions are necessary because PL/pgSQL resolves record fields per table.
CREATE FUNCTION protect_clearance_message() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.signature_message IS DISTINCT FROM OLD.signature_message THEN RAISE EXCEPTION 'clearance message is immutable'; END IF; RETURN NEW; END; $$;
CREATE FUNCTION protect_settlement_randomness() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.anchor_randomness IS DISTINCT FROM OLD.anchor_randomness THEN RAISE EXCEPTION 'settlement randomness is immutable'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER settlement_randomness_immutable BEFORE UPDATE ON settlements FOR EACH ROW EXECUTE FUNCTION protect_settlement_randomness();
CREATE TRIGGER clearance_message_immutable BEFORE UPDATE ON clearances FOR EACH ROW EXECUTE FUNCTION protect_clearance_message();
DROP FUNCTION protect_extra_target();

CREATE FUNCTION protect_dispatch_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.send_claimed_at IS NOT NULL AND NEW.send_claimed_at IS DISTINCT FROM OLD.send_claimed_at THEN RAISE EXCEPTION 'send claim is immutable'; END IF;
 IF OLD.finish_evidence_digest IS NOT NULL AND NEW.finish_evidence_digest IS DISTINCT FROM OLD.finish_evidence_digest THEN RAISE EXCEPTION 'finish evidence is immutable'; END IF;
 IF NEW.send_claimed_at IS DISTINCT FROM OLD.send_claimed_at AND (OLD.finished_at IS NOT NULL OR OLD.fenced_at IS NOT NULL) THEN RAISE EXCEPTION 'completed attempt cannot send'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER dispatch_evidence_immutable BEFORE UPDATE ON dispatch_attempts FOR EACH ROW EXECUTE FUNCTION protect_dispatch_evidence();

CREATE FUNCTION require_settlement_receipts() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE charge_total numeric; expected_total numeric; mode_name text;
BEGIN
 SELECT charged_nano,mode INTO expected_total,mode_name FROM sessions WHERE pool=NEW.pool AND request_id=NEW.request_id;
 IF EXISTS (SELECT 1 FROM receipts r WHERE r.pool=NEW.pool AND r.request_id=NEW.request_id AND r.billing_effect='charge' AND r.signature IS NULL) THEN RAISE EXCEPTION 'unsigned charge receipt'; END IF;
 IF EXISTS (SELECT 1 FROM operations o WHERE o.pool=NEW.pool AND o.request_id=NEW.request_id AND NOT EXISTS
 (SELECT 1 FROM receipts r WHERE r.pool=o.pool AND r.request_id=o.request_id AND r.operation_id=o.operation_id AND r.billing_effect='charge' AND r.signature IS NOT NULL)) THEN RAISE EXCEPTION 'operation charge receipt missing'; END IF;
 IF mode_name <> 'proxy' AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.pool=NEW.pool AND r.request_id=NEW.request_id AND r.operation_id IS NULL AND r.billing_effect='charge' AND r.signature IS NOT NULL) THEN RAISE EXCEPTION 'direct charge receipt missing'; END IF;
 SELECT coalesce(sum((convert_from(canonical_body,'UTF8')::jsonb->>'charged_nano_usdc')::numeric),0) INTO charge_total FROM receipts WHERE pool=NEW.pool AND request_id=NEW.request_id AND billing_effect='charge';
 IF charge_total <> expected_total THEN RAISE EXCEPTION 'receipt aggregate mismatch'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER settlement_receipts BEFORE INSERT ON settlements FOR EACH ROW EXECUTE FUNCTION require_settlement_receipts();

-- No LOGIN credentials are embedded. Deployment grants these group roles to dedicated users.
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='zkapi_control_writer') THEN CREATE ROLE zkapi_control_writer NOLOGIN; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='zkapi_control_reader') THEN CREATE ROLE zkapi_control_reader NOLOGIN; END IF;
END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO zkapi_control_writer, zkapi_control_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO zkapi_control_reader;
GRANT SELECT,INSERT,UPDATE ON pools,tariffs,quotes,nullifier_reservations,sessions,operations,dispatch_attempts,settlements,clearances,provider_evidence,receipts,chain_checkpoints,chain_events,chain_transactions,outbox TO zkapi_control_writer;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO zkapi_control_writer;
REVOKE DELETE,TRUNCATE,REFERENCES,TRIGGER ON ALL TABLES IN SCHEMA public FROM zkapi_control_writer,zkapi_control_reader;

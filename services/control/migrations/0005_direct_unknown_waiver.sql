-- Explicit operator-loss approval is separate from evidence that a provider key stopped.
ALTER TABLE sessions ADD COLUMN direct_waiver_evidence bytes32;
CREATE TABLE direct_unknown_waivers (
 pool bytes32 NOT NULL,
 request_id uuid NOT NULL,
 approval_body bytea NOT NULL CHECK(octet_length(approval_body) BETWEEN 1 AND 16384),
 approval_hash bytes32 NOT NULL UNIQUE,
 approval_signature bytea NOT NULL CHECK(octet_length(approval_signature)=64),
 receipt_id uuid NOT NULL UNIQUE REFERENCES receipts(receipt_id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(pool,request_id),
 FOREIGN KEY(pool,request_id) REFERENCES sessions
);
CREATE TRIGGER direct_unknown_waivers_immutable BEFORE UPDATE OR DELETE ON direct_unknown_waivers FOR EACH ROW EXECUTE FUNCTION reject_mutation();
GRANT SELECT,INSERT ON direct_unknown_waivers TO zkapi_control_writer;
GRANT SELECT ON direct_unknown_waivers TO zkapi_control_reader;
CREATE OR REPLACE FUNCTION protect_session() RETURNS trigger LANGUAGE plpgsql AS $$
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
 IF NEW.state='SIGN_PENDING' AND NEW.mode<>'proxy' AND NEW.direct_stop_evidence IS NULL AND NEW.direct_waiver_evidence IS NULL THEN RAISE EXCEPTION 'direct key stop evidence missing'; END IF;
 IF NEW.state='SIGN_PENDING' AND NOT EXISTS (SELECT 1 FROM settlements x WHERE x.pool=NEW.pool AND x.request_id=NEW.request_id) THEN
 RAISE EXCEPTION 'settlement target must be stored first'; END IF;
 IF NEW.state='SETTLED' AND NOT EXISTS (SELECT 1 FROM settlements x WHERE x.pool=NEW.pool AND x.request_id=NEW.request_id AND state_signature IS NOT NULL) THEN
 RAISE EXCEPTION 'signature must be stored first'; END IF;
 IF OLD.direct_waiver_evidence IS NOT NULL AND NEW.direct_waiver_evidence IS DISTINCT FROM OLD.direct_waiver_evidence THEN RAISE EXCEPTION 'direct waiver is immutable'; END IF;
 IF NEW.direct_waiver_evidence IS NOT NULL THEN
  IF NEW.mode <> 'direct_openrouter' OR NEW.provider <> 'openrouter' OR NOT NEW.close_requested
   OR NEW.activated_at IS NOT NULL OR NEW.expires_at IS NOT NULL OR NEW.provider_key_ref IS NOT NULL
   OR NEW.direct_stop_evidence IS NOT NULL OR NEW.charged_nano <> 0 OR NEW.reserved_nano <> 0
   OR NEW.active_operations <> 0 OR NEW.state NOT IN ('RECONCILING','SIGN_PENDING','SETTLED') THEN
   RAISE EXCEPTION 'invalid direct unknown waiver'; END IF;
  IF OLD.direct_waiver_evidence IS NULL AND OLD.state <> 'ISSUANCE_UNKNOWN' THEN RAISE EXCEPTION 'waiver requires unknown issuance'; END IF;
  IF NOT EXISTS(SELECT 1 FROM direct_unknown_waivers w WHERE w.pool=NEW.pool AND w.request_id=NEW.request_id AND w.approval_hash=NEW.direct_waiver_evidence) THEN RAISE EXCEPTION 'signed waiver must be stored first'; END IF;
 END IF;
 RETURN NEW;
END; $$;

-- Freeze the exact original checkpoint/attempt inventory used by the signed approval.
CREATE FUNCTION protect_waived_direct_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='outbox' THEN
  IF TG_OP <> 'INSERT' THEN
   IF OLD.event_type='DIRECT_RECOVERY_CHECKPOINT' AND EXISTS(SELECT 1 FROM sessions s WHERE s.pool=OLD.pool AND s.request_id::text=OLD.metadata->'intent'->>'request_id' AND s.direct_waiver_evidence IS NOT NULL)
    AND (TG_OP='DELETE' OR ROW(NEW.pool,NEW.event_type,NEW.metadata,NEW.id,NEW.created_at) IS DISTINCT FROM ROW(OLD.pool,OLD.event_type,OLD.metadata,OLD.id,OLD.created_at)) THEN RAISE EXCEPTION 'waived direct history is immutable'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.pool,NEW.event_type,NEW.metadata,NEW.id,NEW.created_at) IS NOT DISTINCT FROM ROW(OLD.pool,OLD.event_type,OLD.metadata,OLD.id,OLD.created_at) THEN RETURN NEW; END IF;
  IF NEW.event_type='DIRECT_RECOVERY_CHECKPOINT' AND EXISTS(SELECT 1 FROM sessions s WHERE s.pool=NEW.pool AND s.request_id::text=NEW.metadata->'intent'->>'request_id' AND s.direct_waiver_evidence IS NOT NULL) THEN RAISE EXCEPTION 'waived direct history is immutable'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM sessions s WHERE s.pool=NEW.pool AND s.request_id=NEW.request_id AND s.direct_waiver_evidence IS NOT NULL) THEN RAISE EXCEPTION 'waived direct history is immutable'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER waived_direct_checkpoint BEFORE INSERT OR UPDATE OR DELETE ON outbox FOR EACH ROW EXECUTE FUNCTION protect_waived_direct_history();
CREATE TRIGGER waived_direct_attempt BEFORE INSERT OR UPDATE ON dispatch_attempts FOR EACH ROW EXECUTE FUNCTION protect_waived_direct_history();

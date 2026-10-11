-- An immutable fence for a never-admitted AUTH, not a note/nullifier clearance.
CREATE TABLE retired_authorizations (
    pool bytes32 NOT NULL REFERENCES pools,
    request_id uuid NOT NULL,
    quote_id uuid NOT NULL,
    nullifier bytes32 NOT NULL,
    request_digest bytes32 NOT NULL,
    request_transcript bytea NOT NULL,
    PRIMARY KEY (pool, request_id),
    UNIQUE (pool, quote_id),
    FOREIGN KEY (pool, quote_id) REFERENCES quotes
);
CREATE TRIGGER retired_authorizations_immutable BEFORE UPDATE OR DELETE ON retired_authorizations
    FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- Serialize even direct SQL inserts with the same pool lock as the writer.
CREATE FUNCTION fence_retired_authorization() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM pools WHERE pool=NEW.pool FOR UPDATE;
 IF TG_TABLE_NAME='sessions' THEN
   IF EXISTS (SELECT 1 FROM retired_authorizations r WHERE r.pool=NEW.pool
       AND (r.request_id=NEW.request_id OR r.quote_id=NEW.quote_id)) THEN
     RAISE EXCEPTION 'authorization retired';
   END IF;
 ELSE
   IF EXISTS (SELECT 1 FROM sessions s WHERE s.pool=NEW.pool
       AND (s.request_id=NEW.request_id OR s.quote_id=NEW.quote_id))
       OR EXISTS (SELECT 1 FROM nullifier_reservations n WHERE n.pool=NEW.pool AND n.nullifier=NEW.nullifier) THEN
     RAISE EXCEPTION 'authorization already reserved';
   END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER session_retirement_fence BEFORE INSERT ON sessions
    FOR EACH ROW EXECUTE FUNCTION fence_retired_authorization();
CREATE TRIGGER retirement_admission_fence BEFORE INSERT ON retired_authorizations
    FOR EACH ROW EXECUTE FUNCTION fence_retired_authorization();
GRANT SELECT,INSERT ON retired_authorizations TO zkapi_control_writer;
GRANT SELECT ON retired_authorizations TO zkapi_control_reader;

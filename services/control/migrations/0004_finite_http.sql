-- Add immutable finite HTTP identity to the existing accounting operations.
-- No accepted legacy row, tariff, receipt, dispatch claim or signing target changes.
ALTER TABLE operations ADD COLUMN envelope_version smallint NOT NULL DEFAULT 1;
ALTER TABLE operations ADD COLUMN binding_hash bytes32;
ALTER TABLE operations ADD COLUMN meter_hash bytes32;
ALTER TABLE operations ADD CONSTRAINT finite_http_identity CHECK (
    (envelope_version=1 AND binding_hash IS NULL AND meter_hash IS NULL)
    OR (envelope_version=2 AND binding_hash IS NOT NULL AND meter_hash IS NOT NULL
        AND endpoint LIKE '/zkapi/v2/execute/%' AND model='')
);
CREATE FUNCTION protect_finite_http_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.envelope_version,NEW.binding_hash,NEW.meter_hash)
       IS DISTINCT FROM ROW(OLD.envelope_version,OLD.binding_hash,OLD.meter_hash)
    THEN RAISE EXCEPTION 'finite HTTP identity is immutable'; END IF;
    RETURN NEW;
END; $$;
CREATE TRIGGER finite_http_identity_immutable BEFORE UPDATE ON operations
    FOR EACH ROW EXECUTE FUNCTION protect_finite_http_identity();

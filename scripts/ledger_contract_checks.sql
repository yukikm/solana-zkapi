-- Synthetic public metadata only; run in a disposable design database.
BEGIN;
DO $$
DECLARE
    p bytea := decode(repeat('01',32),'hex');
    h bytea := decode(repeat('02',32),'hex');
    n bytea := decode(repeat('03',32),'hex');
    rid uuid := '00000000-0000-4000-8000-000000000001';
    qid uuid := '00000000-0000-4000-8000-000000000002';
    oid uuid := '00000000-0000-4000-8000-000000000003';
    aid uuid := '00000000-0000-4000-8000-000000000004';
    owner_id uuid := '00000000-0000-4000-8000-000000000005';
BEGIN
    BEGIN
        PERFORM 'NaN'::amount_nano;
        RAISE EXCEPTION 'NaN amount allowed' USING ERRCODE='ZX001';
    EXCEPTION WHEN check_violation THEN NULL; END;
    INSERT INTO pools(pool,deployment_id,manifest_hash) VALUES(p,'fixture',h);
    INSERT INTO tariffs(tariff_hash,canonical_body) VALUES(h,'{}');
    INSERT INTO quotes(pool,quote_id,quote_hash,canonical_body,signature,tariff_hash,expires_at)
        VALUES(p,qid,h,'{}',decode(repeat('00',64),'hex'),h,100);
    INSERT INTO nullifier_reservations(pool,nullifier,kind) VALUES(p,n,'AUTH');
    BEGIN
        INSERT INTO nullifier_reservations(pool,nullifier,kind) VALUES(p,n,'CLEARANCE');
        RAISE EXCEPTION 'missing nullifier exclusion' USING ERRCODE='ZX001';
    EXCEPTION WHEN unique_violation THEN NULL; END;
    INSERT INTO sessions(pool,request_id,nullifier,quote_id,request_digest,request_transcript,
                         control_secret_hash,proxy_secret_hash,mode,provider,state,
                         cap_micro,max_concurrency,writer_epoch)
        VALUES(p,rid,n,qid,h,'{}',h,h,'proxy','openai','ACTIVE',1000000,4,0);
    BEGIN
        UPDATE sessions SET reserved_nano=1000000001 WHERE pool=p AND request_id=rid;
        RAISE EXCEPTION 'missing budget constraint' USING ERRCODE='ZX001';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN
        UPDATE sessions SET expires_at=100 WHERE pool=p AND request_id=rid;
        RAISE EXCEPTION 'missing activation pair constraint' USING ERRCODE='ZX001';
    EXCEPTION WHEN check_violation THEN NULL; END;
    INSERT INTO operations(pool,request_id,operation_id,request_hmac,endpoint,model,state,reservation_nano,charged_nano)
        VALUES(p,rid,oid,h,'/v1/responses','fixture','DONE',1001,1001);
    INSERT INTO dispatch_attempts(attempt_id,pool,request_id,operation_id,kind,writer_epoch,owner_instance)
        VALUES(aid,p,rid,oid,'PROXY_INFERENCE',0,owner_id);
    BEGIN
        INSERT INTO dispatch_attempts(attempt_id,pool,request_id,operation_id,kind,writer_epoch,owner_instance)
            VALUES('00000000-0000-4000-8000-000000000006',p,rid,oid,'PROXY_INFERENCE',0,owner_id);
        RAISE EXCEPTION 'missing attempt uniqueness' USING ERRCODE='ZX001';
    EXCEPTION WHEN unique_violation THEN NULL; END;
    BEGIN
        UPDATE dispatch_attempts SET owner_instance=rid WHERE attempt_id=aid;
        RAISE EXCEPTION 'mutable dispatch owner' USING ERRCODE='ZX001';
    EXCEPTION WHEN raise_exception THEN NULL; END;
    UPDATE sessions SET state='RECONCILING',charged_nano=1001 WHERE pool=p AND request_id=rid;
    BEGIN
        INSERT INTO settlements(pool,request_id,charge_micro,next_anchor,next_commitment_x,
                                next_commitment_y,blind_delta,signature_message,message_digest)
            VALUES(p,rid,2,h,h,h,h,'message',h);
        RAISE EXCEPTION 'unfenced settlement allowed' USING ERRCODE='ZX001';
    EXCEPTION WHEN raise_exception THEN NULL; END;
    UPDATE dispatch_attempts SET finished_at=clock_timestamp() WHERE attempt_id=aid;
    BEGIN
        INSERT INTO settlements(pool,request_id,charge_micro,next_anchor,next_commitment_x,
                                next_commitment_y,blind_delta,signature_message,message_digest)
            VALUES(p,rid,3,h,h,h,h,'message',h);
        RAISE EXCEPTION 'incorrect rounding allowed' USING ERRCODE='ZX001';
    EXCEPTION WHEN raise_exception THEN NULL; END;
    INSERT INTO settlements(pool,request_id,charge_micro,next_anchor,next_commitment_x,
                            next_commitment_y,blind_delta,signature_message,message_digest)
        VALUES(p,rid,2,h,h,h,h,'message',h);
    BEGIN
        UPDATE settlements SET charge_micro=1 WHERE pool=p AND request_id=rid;
        RAISE EXCEPTION 'mutable settlement' USING ERRCODE='ZX001';
    EXCEPTION WHEN raise_exception THEN NULL; END;
    BEGIN
        UPDATE settlements SET state_signature=decode(repeat('00',64),'hex') WHERE pool=p AND request_id=rid;
        RAISE EXCEPTION 'invalid state signature length allowed' USING ERRCODE='ZX001';
    EXCEPTION WHEN check_violation THEN NULL; END;
    UPDATE settlements SET state_signature=decode(repeat('00',96),'hex') WHERE pool=p AND request_id=rid;
    BEGIN
        UPDATE settlements SET state_signature=decode(repeat('01',96),'hex') WHERE pool=p AND request_id=rid;
        RAISE EXCEPTION 'mutable settlement signature' USING ERRCODE='ZX001';
    EXCEPTION WHEN raise_exception THEN NULL; END;
    INSERT INTO receipts(receipt_id,pool,request_id,operation_id,billing_effect,canonical_body,receipt_hash)
        VALUES(qid,p,rid,oid,'charge','{}',h);
    UPDATE receipts SET signature=decode(repeat('00',64),'hex') WHERE receipt_id=qid;
    BEGIN
        UPDATE receipts SET canonical_body='changed' WHERE receipt_id=qid;
        RAISE EXCEPTION 'mutable receipt' USING ERRCODE='ZX001';
    EXCEPTION WHEN raise_exception THEN NULL; END;
    BEGIN
        INSERT INTO receipts(receipt_id,pool,request_id,operation_id,billing_effect,canonical_body,receipt_hash)
            VALUES(oid,p,rid,oid,'charge','{}',n);
        RAISE EXCEPTION 'duplicate charge receipt allowed' USING ERRCODE='ZX001';
    EXCEPTION WHEN unique_violation THEN NULL; END;
    INSERT INTO nullifier_reservations(pool,nullifier,kind) VALUES(p,h,'CLEARANCE');
    INSERT INTO clearances(pool,nullifier,message_digest) VALUES(p,h,h);
    BEGIN
        UPDATE clearances SET signature=decode(repeat('00',64),'hex') WHERE pool=p AND nullifier=h;
        RAISE EXCEPTION 'invalid clearance signature length allowed' USING ERRCODE='ZX001';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN
        UPDATE clearances SET message_digest=n WHERE pool=p AND nullifier=h;
        RAISE EXCEPTION 'mutable clearance message' USING ERRCODE='ZX001';
    EXCEPTION WHEN raise_exception THEN NULL; END;
    BEGIN
        UPDATE clearances SET nullifier=n WHERE pool=p AND nullifier=h;
        RAISE EXCEPTION 'mutable clearance identity' USING ERRCODE='ZX001';
    EXCEPTION WHEN raise_exception THEN NULL; END;
    UPDATE clearances SET signature=decode(repeat('00',96),'hex') WHERE pool=p AND nullifier=h;
    -- A retry may write exactly the saved value, but may not replace or erase it.
    UPDATE clearances SET signature=decode(repeat('00',96),'hex') WHERE pool=p AND nullifier=h;
    BEGIN
        UPDATE clearances SET signature=NULL WHERE pool=p AND nullifier=h;
        RAISE EXCEPTION 'mutable clearance signature' USING ERRCODE='ZX001';
    EXCEPTION WHEN raise_exception THEN NULL; END;
    BEGIN
        DELETE FROM clearances WHERE pool=p AND nullifier=h;
        RAISE EXCEPTION 'clearance deletion allowed' USING ERRCODE='ZX001';
    EXCEPTION WHEN raise_exception THEN NULL; END;
END;
$$;
ROLLBACK;
SELECT 'PASS: 18 negative constraint cases and valid settlement/receipt/clearance paths';

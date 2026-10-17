drop function if exists app_private.release_gdelt_request(uuid, integer);
drop function if exists app_private.claim_gdelt_request(uuid);
drop table if exists app_private.gdelt_request_gate;

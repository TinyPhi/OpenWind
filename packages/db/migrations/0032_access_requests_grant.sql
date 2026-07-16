-- analytics: excluded (grant statement, no new columns)
-- down:
--   REVOKE SELECT, INSERT, UPDATE ON access_requests FROM app_user;

-- Migration 0028 created access_requests with RLS but, unlike the batched
-- grants in 0022, never granted app_user table privileges — every route
-- using withTenantContext (SET LOCAL ROLE app_user) got permission denied.
GRANT SELECT, INSERT, UPDATE ON access_requests TO app_user;

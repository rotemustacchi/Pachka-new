-- admin_audit: let the server read the log it writes.
--
-- Owner: moderation
--
-- Forward-only and additive: see db/README.md. No down migration exists.
--
-- 20260827T150000 got this table almost entirely right. It has FORCE ROW LEVEL
-- SECURITY, an append-only trigger, a hash chain, an admin read policy, and --
-- unusually for this codebase before today -- a real INSERT policy for
-- `service_role`. It also granted `select, insert on admin_audit to
-- service_role`.
--
-- What it does not have is a SELECT *policy* for `service_role`. The grant
-- alone is not enough: with RLS enabled, a role needs both the privilege and a
-- policy that admits the row.
--
-- The consequence is the quiet kind. `moderation.verify_audit_chain()` walks
-- every entry in `seq` order and reports the first break. RLS filters rows, it
-- does not raise -- so on a connection that does not bypass RLS the walk sees
-- an empty table, finds no break, and returns `ok`. The tamper-detection
-- control that SECURITY.md S1-14 describes as the one that still works after an
-- attacker has the service-role key would have reported a clean chain for a log
-- it could not read a single row of.
--
-- It passed because the harness connected as a superuser. It no longer does.
--
-- Note what is deliberately NOT added: there is still no UPDATE and no DELETE
-- policy on this table for any role, which is the point of the table.

create policy admin_audit_server_read on admin_audit
  for select to service_role
  using (true);

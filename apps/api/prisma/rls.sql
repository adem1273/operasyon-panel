-- Run after migrations to enforce tenant isolation at the database layer.

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservation_status_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_users ON users;
CREATE POLICY tenant_isolation_users ON users
USING ("tenantId" = current_setting('app.current_tenant_id')::uuid);

DROP POLICY IF EXISTS tenant_isolation_user_devices ON user_devices;
CREATE POLICY tenant_isolation_user_devices ON user_devices
USING ("tenantId" = current_setting('app.current_tenant_id')::uuid);

DROP POLICY IF EXISTS tenant_isolation_reservations ON reservations;
CREATE POLICY tenant_isolation_reservations ON reservations
USING ("tenantId" = current_setting('app.current_tenant_id')::uuid);

DROP POLICY IF EXISTS tenant_isolation_notification_deliveries ON notification_deliveries;
CREATE POLICY tenant_isolation_notification_deliveries ON notification_deliveries
USING ("tenantId" = current_setting('app.current_tenant_id')::uuid);

DROP POLICY IF EXISTS tenant_isolation_reservation_status_logs ON reservation_status_logs;
CREATE POLICY tenant_isolation_reservation_status_logs ON reservation_status_logs
USING ("tenantId" = current_setting('app.current_tenant_id')::uuid);

DROP POLICY IF EXISTS tenant_isolation_audit_logs ON audit_logs;
CREATE POLICY tenant_isolation_audit_logs ON audit_logs
USING ("tenantId" = current_setting('app.current_tenant_id')::uuid);

DROP POLICY IF EXISTS tenant_isolation_auth_sessions ON auth_sessions;
CREATE POLICY tenant_isolation_auth_sessions ON auth_sessions
USING ("tenantId" = current_setting('app.current_tenant_id')::uuid);

-- tenants table can be restricted by selected operation mode.
-- In many SaaS setups, tenant records are visible only to super admins.

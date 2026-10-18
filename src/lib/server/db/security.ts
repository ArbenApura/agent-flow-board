// ROLES, GRANTS AND FORCED ROW LEVEL SECURITY, GENERATED FROM THE TENANT TABLE REGISTRY (ADR-021)
// No schema diff can express these, and generating them from the registry means no tenant table can be forgotten.

// -- TYPES -- //
import type { TenantEntry } from './schema';
// -- MODULES -- //
// Importing the whole schema registers every tenant table before the statements are generated
import { TENANT_TABLES } from './schema';

// -- CONSTANTS -- //

export const RUNTIME_ROLE = 'app_runtime';

/** Tables outside any org: people, their preferences, OAuth clients and device codes. They hold no tenant data. */
const PLAIN_TABLES = [
	'user',
	'oauth_client',
	'device_code',
	'auth_session',
	'auth_account',
	'auth_verification',
	'auth_lockout',
	'auth_rate_limit',
	'auth_device'
];
/** One row per person, visible to that person only. */
const USER_TABLES = ['user_pref'];

const ORG = "nullif(current_setting('app.org_id', true), '')";
const PROJECT = "nullif(current_setting('app.project_id', true), '')";
const USER = "nullif(current_setting('app.user_id', true), '')";

// -- FUNCTIONS -- //

const q = (name: string) => `"${name}"`;

/** The row filter of a tenant table. The org wall always applies, the project wall applies whenever a project is set. */
export function usingClause(t: TenantEntry): string {
	if (t.using) return t.using;
	const orgWall = `${q(t.orgColumn)} = ${ORG}::uuid`;
	return t.scope === 'project'
		? `${orgWall} and (${PROJECT} is null or "project_id" = ${PROJECT}::uuid)`
		: orgWall;
}

/** Every statement, in order, safe to run again. */
export function securityStatements(): string[] {
	const out: string[] = [];
	out.push(
		`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${RUNTIME_ROLE}') THEN CREATE ROLE ${RUNTIME_ROLE} NOLOGIN NOBYPASSRLS; END IF; END $$`
	);
	out.push(`GRANT USAGE ON SCHEMA public TO ${RUNTIME_ROLE}`);
	for (const name of PLAIN_TABLES) {
		out.push(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${q(name)} TO ${RUNTIME_ROLE}`);
	}
	for (const name of USER_TABLES) {
		out.push(`ALTER TABLE ${q(name)} ENABLE ROW LEVEL SECURITY`);
		out.push(`ALTER TABLE ${q(name)} FORCE ROW LEVEL SECURITY`);
		out.push(`DROP POLICY IF EXISTS user_isolation ON ${q(name)}`);
		out.push(
			`CREATE POLICY user_isolation ON ${q(name)} FOR ALL TO ${RUNTIME_ROLE} USING ("user_id" = ${USER}) WITH CHECK ("user_id" = ${USER})`
		);
		out.push(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${q(name)} TO ${RUNTIME_ROLE}`);
	}
	for (const t of TENANT_TABLES) {
		const using = usingClause(t);
		out.push(`ALTER TABLE ${q(t.name)} ENABLE ROW LEVEL SECURITY`);
		out.push(`ALTER TABLE ${q(t.name)} FORCE ROW LEVEL SECURITY`);
		out.push(`DROP POLICY IF EXISTS tenant_isolation ON ${q(t.name)}`);
		// WITH CHECK stops a write that would move a row into another org, and the same project wall as the read
		const check = t.check ?? (t.using ? `"${t.orgColumn}" = ${ORG}::uuid` : using);
		out.push(
			`CREATE POLICY tenant_isolation ON ${q(t.name)} FOR ALL TO ${RUNTIME_ROLE} USING (${using}) WITH CHECK (${check})`
		);
		out.push(
			t.appendOnly
				? `GRANT SELECT, INSERT ON ${q(t.name)} TO ${RUNTIME_ROLE}`
				: `GRANT SELECT, INSERT, UPDATE, DELETE ON ${q(t.name)} TO ${RUNTIME_ROLE}`
		);
	}
	// The event log only grows. The one allowed change is anonymising the actor when a person is deleted (L19).
	out.push(`GRANT UPDATE ("actor_user_id", "actor_label") ON "event" TO ${RUNTIME_ROLE}`);
	out.push(`
CREATE OR REPLACE FUNCTION afb_event_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
	IF (to_jsonb(NEW) - 'actor_user_id' - 'actor_label') IS DISTINCT FROM (to_jsonb(OLD) - 'actor_user_id' - 'actor_label') THEN
		RAISE EXCEPTION 'event rows are append only';
	END IF;
	RETURN NEW;
END $fn$`);
	out.push(`DROP TRIGGER IF EXISTS afb_event_guard ON "event"`);
	out.push(
		`CREATE TRIGGER afb_event_guard BEFORE UPDATE ON "event" FOR EACH ROW EXECUTE FUNCTION afb_event_guard()`
	);
	out.push(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RUNTIME_ROLE}`);
	return out;
}

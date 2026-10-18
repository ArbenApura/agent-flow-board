// SCHEMA HELPERS: EVERY TENANT TABLE CARRIES org_id AND IS REGISTERED, SO ROW LEVEL SECURITY IS GENERATED FOR ALL OF THEM (ADR-021)

// -- DEP-TYPES -- //
import type {
	AnyPgColumn,
	ExtraConfigColumn,
	PgColumnBuilderBase,
	PgTableExtraConfigValue
} from 'drizzle-orm/pg-core';
// -- DEP-MODULES -- //
import { sql } from 'drizzle-orm';
import { check, customType, integer, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';

// -- TYPES -- //

export type TenantScope = 'org' | 'project';
export type TenantEntry = {
	name: string;
	scope: TenantScope;
	/** The column that holds the org id. The org table itself uses its own id. */
	orgColumn: string;
	/** Replaces the default row filter for tables that need a wider rule (the member list of a user). */
	using?: string;
	/** Replaces the WITH CHECK clause; it defaults to the org wall when a `using` override is set. */
	check?: string;
	/** Tables whose rows only ever grow. No UPDATE or DELETE is granted to the runtime role. */
	appendOnly?: boolean;
};

// -- CONSTANTS -- //

/** Every table that holds one organisation's data. Row level security policies are generated from this list. */
export const TENANT_TABLES: TenantEntry[] = [];

export const ROLES = ['owner', 'admin', 'member', 'viewer', 'guest'] as const;
export const STATUSES = [
	'PLANNED',
	'IN PROGRESS',
	'IN REVIEW',
	'ON HOLD',
	'COMPLETED',
	'REMOVED'
] as const;
export const STEP_STATES = ['open', 'done', 'waived', 'superseded'] as const;
export const VISIBILITIES = ['public', 'private'] as const;
export const TARGETS = ['dev', 'preview', 'deployed'] as const;

// -- FUNCTIONS -- //

/** A PostgreSQL full text search column, always generated from the row's own text columns. */
export const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

export const id = () => uuid('id').primaryKey().defaultRandom();

export const stamps = () => ({
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

/** The optimistic concurrency column. Every write that changes the row bumps it. */
export const version = () => integer('version').notNull().default(1);

/** A CHECK constraint limiting a text column to a fixed set of values. */
export const oneOf = (name: string, column: AnyPgColumn, values: readonly string[]) =>
	// The values are constants from this codebase, written as literals because DDL cannot take parameters
	check(
		name,
		sql`${column} in (${sql.raw(values.map((v) => `'${v.replaceAll("'", "''")}'`).join(', '))})`
	);

/**
 * Defines a tenant table. `org` scope tables are filtered by the org alone. `project` scope tables also carry
 * project_id, and the policy narrows to one project whenever the request sets a project.
 */
export function tenantTable<T extends Record<string, PgColumnBuilderBase>>(
	name: string,
	scope: TenantScope,
	columns: T,
	extra?: (self: Record<string, ExtraConfigColumn>) => PgTableExtraConfigValue[],
	options: Partial<Pick<TenantEntry, 'orgColumn' | 'using' | 'check' | 'appendOnly'>> = {}
) {
	TENANT_TABLES.push({ name, scope, orgColumn: options.orgColumn ?? 'org_id', ...options });
	// The array form of the extra config is supported at runtime, its type is wider than the overloads accept
	return pgTable(name, columns, extra as never);
}

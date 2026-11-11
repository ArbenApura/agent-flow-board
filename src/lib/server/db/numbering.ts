// ATOMIC ITEM AND TASK NUMBERS FROM A PER PROJECT COUNTER ROW (SPEC 5)
// The counter row is locked by the upsert and the lock lasts until the transaction ends, so two concurrent creates
// can never share a number, and a rolled back create gives its number back (no gaps from failures).

// -- TYPES -- //
import type { Tx } from './client';
// -- DEP-MODULES -- //
import { sql } from 'drizzle-orm';

// -- FUNCTIONS -- //

type CounterColumn = 'next' | 'next_task' | 'next_note';

async function take(
	tx: Tx,
	orgId: string,
	projectId: string,
	column: CounterColumn
): Promise<number> {
	// The columns that are not being taken keep their default of 1 when the row is made here
	const res = await tx.execute(
		sql.raw(
			`insert into project_counter (project_id, org_id, ${column}) values ('${projectId}', '${orgId}', 2)
			 on conflict (project_id) do update set ${column} = project_counter.${column} + 1
			 returning ${column} - 1 as n`
		)
	);
	return Number((res as unknown as { rows: { n: number }[] }).rows[0].n);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, name: string) {
	if (!UUID.test(value)) throw new Error(`${name} must be a UUID`);
}

/**
 * The next item number of the project, for example { number: 142 }. It is the per project order and no longer part of the
 * reference: a new item's reference is a clock stamp (db/flowId.ts, FLOW-20261017-0950).
 */
export async function allocateItemNumber(
	tx: Tx,
	orgId: string,
	projectId: string
): Promise<{ number: number }> {
	assertUuid(orgId, 'orgId');
	assertUuid(projectId, 'projectId');
	return { number: await take(tx, orgId, projectId, 'next') };
}

/** The next task number in the project. */
export async function allocateTaskNumber(
	tx: Tx,
	orgId: string,
	projectId: string
): Promise<number> {
	assertUuid(orgId, 'orgId');
	assertUuid(projectId, 'projectId');
	return take(tx, orgId, projectId, 'next_task');
}

/** The next note number in the project (N-12). */
export async function allocateNoteNumber(
	tx: Tx,
	orgId: string,
	projectId: string
): Promise<number> {
	assertUuid(orgId, 'orgId');
	assertUuid(projectId, 'projectId');
	return take(tx, orgId, projectId, 'next_note');
}

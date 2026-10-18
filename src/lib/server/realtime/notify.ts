// THE CHANGE NOTICE: WHAT IS SENT THROUGH NOTIFY WHEN A PROJECT CHANGES, SO OTHER OPEN PAGES CAN REFRESH (SPEC 11, 12)
// The notice is small on purpose (Postgres limits a payload to 8000 bytes) and holds ids only, never content.

// -- TYPES -- //
import type { Tx } from '../db/client';
// -- DEP-MODULES -- //
import { sql } from 'drizzle-orm';

// -- TYPES -- //

export type Change = {
	/** Organisation id. */
	o: string;
	/** Project id. */
	p: string;
	/** What happened: an event row was written, or a session claimed or released an item. */
	k: 'event' | 'claim';
	/** The event id, for replay. */
	e?: number;
	/** The item id, so a stream can leave out changes to items the viewer may not see. */
	i?: string | null;
	/** The verb, so a page can decide what to refresh. */
	v?: string;
};

// -- CONSTANTS -- //

export const CHANNEL = 'afb_change';

// -- FUNCTIONS -- //

/** Queues a notice that is delivered when the surrounding transaction commits, never before. */
export async function notifyChange(tx: Tx, change: Change): Promise<void> {
	await tx.execute(sql`select pg_notify(${CHANNEL}, ${JSON.stringify(change)})`);
}

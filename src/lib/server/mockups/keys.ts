// STORAGE KEYS OF MOCKUP FILES: ONE RESERVED PREFIX, SO THE GENERAL FILE ROUTE CAN REFUSE THEM

// -- DEP-MODULES -- //
import { randomUUID } from 'node:crypto';
// -- CONSTANTS -- //
import { MOCKUP_KEY_PREFIX } from '../db/schema/mockups';

// -- FUNCTIONS -- //

export const isMockupKey = (key: string) => key.split('/')[0] === MOCKUP_KEY_PREFIX;

/** A new key for one stored file of a mockup, version, screenshot or kit. Every stored file gets its own. */
export const mockupKey = (orgId: string, projectId: string, kind: 'html' | 'png' | 'kit') =>
	`${MOCKUP_KEY_PREFIX}/${orgId}/${projectId}/${randomUUID()}.${kind === 'png' ? 'png' : 'html'}`;

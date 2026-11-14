// STORAGE KEYS OF MOCKUP FILES: ONE RESERVED PREFIX, SO THE GENERAL FILE ROUTE CAN REFUSE THEM

// -- DEP-MODULES -- //
import { randomUUID } from 'node:crypto';
// -- CONSTANTS -- //
import { MOCKUP_KEY_PREFIX } from '../db/schema/mockups';

// -- FUNCTIONS -- //

export const isMockupKey = (key: string) => key.split('/')[0] === MOCKUP_KEY_PREFIX;

/** A new key for one stored file of a mockup, version, screenshot, kit or kit asset. Every stored file gets its own. */
export const mockupKey = (
	orgId: string,
	projectId: string,
	kind: 'html' | 'png' | 'kit' | 'asset',
	ext?: string
) => {
	const suffix = kind === 'png' ? 'png' : kind === 'asset' ? (ext ?? 'bin') : 'html';
	return `${MOCKUP_KEY_PREFIX}/${orgId}/${projectId}/${randomUUID()}.${suffix}`;
};

/** Reserved key for derived check/compare evidence assets stored via attachments so backup, purge and route isolation cover them. */
export const mockupEvidenceKey = (orgId: string, projectId: string, cleanFilename: string) =>
	`${MOCKUP_KEY_PREFIX}/${orgId}/${projectId}/${randomUUID()}-${cleanFilename}`;

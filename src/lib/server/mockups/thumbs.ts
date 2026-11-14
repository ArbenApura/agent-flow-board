// WHICH FILE A MOCKUP CARD SHOWS: THE SCREENSHOT OF THE CURRENT VERSION WHEN IT HAS ONE, OTHERWISE THE LIVE PREVIEW PAGE

// IMPORTED TYPES
import type { MockupGrant } from './serve';

// -- FUNCTIONS -- //

/** The file grant of a card's picture and whether it is a page to frame (live) or an image. */
export function cardGrant(
	orgId: string,
	m: { id: string; projectId: string; currentVersion: number; hasShot: boolean }
): { grant: MockupGrant; live: boolean } {
	return {
		grant: {
			orgId,
			projectId: m.projectId,
			mockupId: m.id,
			version: m.currentVersion,
			kind: m.hasShot ? 'shot' : 'thumb'
		},
		live: !m.hasShot
	};
}

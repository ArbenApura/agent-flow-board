// THE 5 MINUTE ADDRESS OF A MOCKUP CARD'S PICTURE: THE SCREENSHOT WHEN THE CURRENT VERSION HAS ONE, OTHERWISE THE LIVE PREVIEW FILE. SIGNED WITH AN HMAC, NO DATABASE CALL PER CARD

// -- MODULES -- //
import { cardGrant } from '../mockups/thumbs';
import { memberMockupUrl } from './mockupLinks';

// -- FUNCTIONS -- //

/** The address a card shows for the current version of one mockup, and whether it is a live preview page. */
export function cardThumb(
	orgId: string,
	m: { id: string; projectId: string; currentVersion: number; hasShot: boolean }
): { thumb: string; live: boolean } {
	const { grant, live } = cardGrant(orgId, m);
	return { thumb: memberMockupUrl(grant), live };
}

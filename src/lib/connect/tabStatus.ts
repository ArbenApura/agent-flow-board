// HOW EACH SECTION OF CONNECT A TOOL STANDS, AS THE SHORT PILL ON ITS TAB CARD (AFB-20261115-1000, B.1)
// Pure, so the words and the tones are tested. A status never uses the accent: success, warning and danger are the fixed status tones.

// IMPORTED TYPES
import type { ConnectTabKey } from './hrefs';

// -- TYPES -- //

export type PillTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';
export type TabStatus = { text: string; tone: PillTone; mono?: boolean };

export type TabStatusInput = {
	/** How many apps the person has connected here. */
	connections: number;
	/** The release of the skills bundle, or null when it could not be read. */
	skillsVersion: string | null;
	/** Setting up the editor line needs the Manage permission. */
	canSetUp: boolean;
	/** The person's own bridge sign in, or null when it could not be read. */
	signIn: { state: 'signed-in' | 'expired' | 'none' } | null;
	/** The person's own check runners, or null when they could not be read. */
	runners: { online: boolean }[] | null;
};

// -- FUNCTIONS -- //

export function tabStatuses(i: TabStatusInput): Record<ConnectTabKey, TabStatus> {
	const tools: TabStatus =
		i.connections > 0
			? { text: `${i.connections} ${i.connections === 1 ? 'app' : 'apps'}`, tone: 'neutral' }
			: { text: 'None yet', tone: 'neutral' };
	const skills: TabStatus = i.skillsVersion
		? { text: i.skillsVersion, tone: 'neutral', mono: true }
		: { text: 'Not loaded', tone: 'danger' };
	let editor: TabStatus;
	if (!i.canSetUp) editor = { text: 'Needs Manage', tone: 'neutral' };
	else if (!i.signIn) editor = { text: 'Not read', tone: 'danger' };
	else if (i.signIn.state === 'signed-in') editor = { text: 'Signed in', tone: 'success' };
	else if (i.signIn.state === 'expired') editor = { text: 'Expired', tone: 'warning' };
	else editor = { text: 'Not set up', tone: 'neutral' };
	let bridge: TabStatus;
	if (!i.runners || i.runners.length === 0) bridge = { text: 'No runner', tone: 'neutral' };
	else if (i.runners.some((r) => r.online)) bridge = { text: 'Runner on', tone: 'success' };
	else bridge = { text: 'Offline', tone: 'warning' };
	return { tools, skills, editor, bridge };
}

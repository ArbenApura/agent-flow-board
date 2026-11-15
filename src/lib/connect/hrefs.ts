// THE ADDRESS OF A TAB OF CONNECT A TOOL: THE TAB AND THE ORGANISATION STAY IN IT, SO A LINK OPENS THE SAME TAB FOR THE SAME ORGANISATION

// -- TYPES -- //

export type ConnectTabKey = 'tools' | 'skills' | 'editor' | 'bridge';

// -- FUNCTIONS -- //

/** The address of one tab. The tools tab is the plain /connect. */
export function connectHref(org: string | null, tab: ConnectTabKey): string {
	const params = new URLSearchParams();
	if (org) params.set('org', org);
	if (tab !== 'tools') params.set('tab', tab);
	const query = params.toString();
	return query ? `/connect?${query}` : '/connect';
}

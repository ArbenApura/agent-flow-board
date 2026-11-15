// THE SETUP CHECKLIST OF CONNECT A TOOL: SIX TILES, WHAT THE BOARD KNOWS BY ITSELF AND WHAT THE PERSON SAID (AFB-20261115-1000, H.1)
// Pure, so every state is tested. Progress is the signed in person's own: their connections, their bridge sign in and their own runners.
// A colleague's runner is never counted here. Anything can be skipped, and a skip can be undone.

// -- TYPES -- //

export type TileKey = 'tools' | 'skills' | 'bridge' | 'editor' | 'checks' | 'token';
export type TileStatus = 'done' | 'todo' | 'attention' | 'skipped';
/** What the person marked. The server keeps these per person and organisation. */
export type Marks = Partial<Record<TileKey, 'done' | 'skipped'>>;
/** Which tab of the page a tile opens. */
export type TileGo = 'tools' | 'skills' | 'editor' | 'bridge';

export type SetupInput = {
	/** How many apps the person has connected in this organisation. */
	connections: number;
	/** The person's own bridge sign in, or null when it could not be read. */
	signIn: { state: 'signed-in' | 'expired' | 'none'; expiresAt: string | null } | null;
	/** The person's own check runners. Null when they could not be read. */
	runners: { online: boolean }[] | null;
	marks: Marks;
	person: string;
};

export type Tile = {
	key: TileKey;
	title: string;
	status: TileStatus;
	/** One plain line for the status the tile is in. */
	text: string;
	go: TileGo;
	goLabel: string;
	/** The board cannot know this one: the person says when it is done. */
	manual: boolean;
	optional: boolean;
};

// -- CONSTANTS -- //

type Def = {
	key: TileKey;
	title: string;
	todo: string;
	go: TileGo;
	goLabel: string;
	manual?: boolean;
	optional?: boolean;
};

const DEFS: Def[] = [
	{
		key: 'tools',
		title: 'Connect a tool',
		todo: 'Add Agent Flow Board to the tool you work in.',
		go: 'tools',
		goLabel: 'Pick a tool'
	},
	{
		key: 'skills',
		title: 'Install the skills',
		todo: 'Give your agent the /flow skills. Your agent knows what it has, so mark it when you did.',
		go: 'skills',
		goLabel: 'Install them',
		manual: true
	},
	{
		key: 'bridge',
		title: 'Install the bridge',
		todo: 'One npm command, once per computer.',
		go: 'editor',
		goLabel: 'See the command'
	},
	{
		key: 'editor',
		title: 'Show your item in your editor',
		todo: 'Paste one prompt into Claude Code. This only supports Claude Code.',
		go: 'editor',
		goLabel: 'Set it up'
	},
	{
		key: 'checks',
		title: 'Run browser checks here',
		todo: 'Connect this computer as a check runner.',
		go: 'bridge',
		goLabel: 'Connect it'
	},
	{
		key: 'token',
		title: 'Make a token for a script',
		todo: 'Only if a script or a CI job needs one.',
		go: 'tools',
		goLabel: 'Make a token',
		manual: true,
		optional: true
	}
];

// -- FUNCTIONS -- //

const when = (iso: string | null) =>
	iso ? new Date(iso).toISOString().slice(0, 16).replace('T', ' ') : 'earlier';

/** What the board can tell by itself about one tile: done, in need of attention, or nothing. */
function known(key: TileKey, i: SetupInput): { status: 'done' | 'attention'; text: string } | null {
	if (key === 'tools' && i.connections > 0)
		return {
			status: 'done',
			text: `${i.connections} ${i.connections === 1 ? 'app is' : 'apps are'} connected.`
		};
	if (key === 'bridge' && (i.signIn?.state === 'signed-in' || i.signIn?.state === 'expired'))
		return { status: 'done', text: 'The bridge is installed and has a sign in.' };
	if (key === 'editor') {
		if (i.signIn?.state === 'signed-in')
			return { status: 'done', text: `Signed in as ${i.person}.` };
		if (i.signIn?.state === 'expired')
			return {
				status: 'attention',
				text: `The sign in ended ${when(i.signIn.expiresAt)}. Sign in again.`
			};
	}
	if (key === 'checks' && i.runners && i.runners.length > 0)
		return {
			status: 'done',
			text: i.runners.some((r) => r.online)
				? 'This computer is a check runner.'
				: 'Your check runner is registered but offline now.'
		};
	return null;
}

/** The six tiles in order, each with its status and its line. The person's own marks decide the ones the board cannot know. */
export function setupTiles(i: SetupInput): Tile[] {
	return DEFS.map((d): Tile => {
		const base = {
			key: d.key,
			title: d.title,
			go: d.go,
			goLabel: d.goLabel,
			manual: !!d.manual,
			optional: !!d.optional
		};
		const by = known(d.key, i);
		if (by) return { ...base, ...by };
		const mark = i.marks[d.key];
		if (mark === 'done' && d.manual)
			return { ...base, status: 'done', text: 'You marked this as done.' };
		if (mark === 'skipped')
			return { ...base, status: 'skipped', text: 'Skipped. You can come back to it.' };
		return { ...base, status: 'todo', text: d.todo };
	});
}

/** How many tiles are done and how many skipped, and whether none is left to do. */
export function setupProgress(tiles: Tile[]) {
	const done = tiles.filter((t) => t.status === 'done').length;
	const skipped = tiles.filter((t) => t.status === 'skipped').length;
	return {
		done,
		skipped,
		total: tiles.length,
		percent: Math.round((done / tiles.length) * 100),
		/** Every tile is done or skipped. The checklist folds itself then, unless the person chose. */
		settled: done + skipped === tiles.length
	};
}

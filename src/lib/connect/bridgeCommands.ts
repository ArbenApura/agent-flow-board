// EVERY COMMAND OF THE BRIDGE, ONE LIST FOR THE CONNECT PAGE (AFB-20261115-1000, G.5). PURE, SO A TEST CAN HOLD IT AGAINST THE BRIDGE USAGE AND README.
// The commands are the bridge's own (packages/bridge/README.md and the usage lines of src/cli.ts). The page fills in the board address and
// the organisation, so a command can be copied and run as it is. A word in <angle brackets> is for the person to fill in.

// IMPORTED MODULES
import { BRIDGE_PROGRAM } from './bridgeInstall';

// -- TYPES -- //

export type CommandKind = 'Sign in' | 'Hooks' | 'Stdio' | 'Held writes' | 'Checks' | 'Mockups';
export type BridgeCommand = { kind: CommandKind; command: string; text: string };

// -- CONSTANTS -- //

export const COMMAND_KINDS: readonly CommandKind[] = [
	'Sign in',
	'Hooks',
	'Stdio',
	'Held writes',
	'Checks',
	'Mockups'
];

/** The arguments after the program name, with {server} and {org} where the page fills in the board address and the organisation. */
const COMMANDS: { kind: CommandKind; args: string; text: string }[] = [
	{
		kind: 'Sign in',
		args: 'login --server {server} --org {org}',
		text: 'Sign in with a device code. The sign in is kept in your keychain.'
	},
	{
		kind: 'Sign in',
		args: 'login --json --server {server} --org {org}',
		text: 'For an agent: line 1 holds the code and a verifier. It never prints a token.'
	},
	{ kind: 'Sign in', args: 'logout --server {server}', text: 'Remove the sign in of this server.' },
	{
		kind: 'Hooks',
		args: 'setup --org {org} --server {server}',
		text: 'Write the Claude Code hooks into this repository, in .claude/settings.local.json. Your other hooks stay, and the old file is backed up outside the repository.'
	},
	{
		kind: 'Hooks',
		args: 'setup --shared --org {org} --server {server}',
		text: 'The same, into the shared .claude/settings.json.'
	},
	{
		kind: 'Hooks',
		args: 'hooks print claude --server {server} --org {org}',
		text: 'Print the hook settings to paste by hand. Also antigravity and gemini.'
	},
	{
		kind: 'Stdio',
		args: 'mcp --server {server} --org {org}',
		text: 'Forward MCP over stdio, for tools that only speak stdio.'
	},
	{
		kind: 'Held writes',
		args: 'queue list',
		text: 'Show writes held while the board could not be reached.'
	},
	{ kind: 'Held writes', args: 'queue retry <id>', text: 'Send one held write again.' },
	{ kind: 'Held writes', args: 'queue drop <id>', text: 'Throw one held write away.' },
	{
		kind: 'Checks',
		args: 'check connect --server {server} --org {org} --json',
		text: 'Make this computer a check runner. An agent approves the printed code.'
	},
	{
		kind: 'Checks',
		args: 'check run <item> <key> --server {server} --org {org}',
		text: 'Run one check: build a private copy, preview it, run it in a sandbox and report. Exit 0 pass, 1 fail, 2 could not run.'
	},
	{
		kind: 'Checks',
		args: 'check pull <item> <key> --server {server} --org {org}',
		text: 'Show the board copy of a check script as data.'
	},
	{
		kind: 'Checks',
		args: 'check watch --once',
		text: 'Take runs started from the Run button of the board.'
	},
	{ kind: 'Checks', args: 'check status', text: 'What is connected, and what needs fixing.' },
	{
		kind: 'Checks',
		args: 'check doctor',
		text: 'A full report: the bridge, Node, the browser (it is started once to prove it works), free disk space and the worker. Each line says OK, Missing or Wrong and the command that fixes it.'
	},
	{
		kind: 'Checks',
		args: 'check doctor --fix --yes',
		text: 'Repair what it can and clear old runs. If the browser is missing it downloads it (about 320 MB, once); --yes is your yes to that download.'
	},
	{ kind: 'Checks', args: 'check clear', text: 'Remove old runs.' },
	{
		kind: 'Checks',
		args: 'check setup --yes',
		text: 'Install the browser the checks use (about 320 MB, once). Without --yes it only tells you the size and downloads nothing.'
	},
	{
		kind: 'Checks',
		args: 'check project <NAME> --org {org} --repo <folder>',
		text: 'Register a repo folder for a board project. It must sit inside an approved folder.'
	},
	{
		kind: 'Checks',
		args: 'check approve --request --action <roots|register|secrets|adopt-env|pictures> --target <target>',
		text: "Ask the board for the owner's approval, with no terminal for the owner."
	},
	{
		kind: 'Checks',
		args: 'check login <NAME> --org {org} --approval <code>',
		text: 'Open a window on your own computer and sign in once to the site under test.'
	},
	{
		kind: 'Checks',
		args: 'check roots list',
		text: 'The approved parent folders. Also add and remove.'
	},
	{
		kind: 'Checks',
		args: 'check secrets list',
		text: 'The names of the sealed test values. Also import and forget.'
	},
	{
		kind: 'Checks',
		args: 'check service status',
		text: 'Windows: whether the worker starts when you sign in. Also install and uninstall.'
	},
	{
		kind: 'Mockups',
		args: 'mockup push <file.html> --server {server} --org {org} --item <ref>',
		text: 'Publish one mockup page to the board.'
	},
	{
		kind: 'Mockups',
		args: 'mockup bundle <folder> --server {server} --org {org} --item <ref>',
		text: 'Publish a mockup made of parts.'
	},
	{
		kind: 'Mockups',
		args: 'mockup pull <id> --out <file.html> --server {server} --org {org}',
		text: 'Get a published mockup back as a file.'
	},
	{
		kind: 'Mockups',
		args: 'mockup url <id> --server {server} --org {org}',
		text: 'Make a short-lived link to look at a mockup.'
	},
	{
		kind: 'Mockups',
		args: 'mockup inspect <id> --server {server} --org {org} --screen <S>',
		text: 'Measure the rendered boxes and styles of a mockup screen.'
	},
	{
		kind: 'Mockups',
		args: 'mockup renders <id> --server {server} --org {org}',
		text: 'Render the declared screens again at each width.'
	},
	{
		kind: 'Mockups',
		args: 'mockup kit <file.html> --server {server} --org {org} --project <key>',
		text: 'Save the project style kit (its built stylesheet and fonts).'
	}
];

// -- FUNCTIONS -- //

/** The commands with the board address and the organisation filled in, ready to copy. */
export function bridgeCommands(server: string, orgSlug: string): BridgeCommand[] {
	return COMMANDS.map((c) => ({
		kind: c.kind,
		command: `${BRIDGE_PROGRAM} ${c.args.replaceAll('{server}', server).replaceAll('{org}', orgSlug)}`,
		text: c.text
	}));
}

/** The words right after the program that name the command, for example "check connect" or "queue retry", up to the first flag or placeholder. A test holds these against the bridge. */
export function commandWords(c: BridgeCommand): string[] {
	const words: string[] = [];
	for (const w of c.command.slice(BRIDGE_PROGRAM.length + 1).split(' ')) {
		if (!/^[a-z][a-z-]*$/.test(w)) break;
		words.push(w);
	}
	return words;
}

/** The commands that match what the person typed and the kind they chose, grouped by kind in the usual order. */
export function filterCommands(
	all: BridgeCommand[],
	kind: 'All' | CommandKind,
	term: string
): { kind: CommandKind; rows: BridgeCommand[] }[] {
	const t = term.trim().toLowerCase();
	const shown = all.filter(
		(c) =>
			(kind === 'All' || c.kind === kind) &&
			(!t || `${c.command} ${c.text}`.toLowerCase().includes(t))
	);
	return COMMAND_KINDS.map((k) => ({ kind: k, rows: shown.filter((c) => c.kind === k) })).filter(
		(g) => g.rows.length > 0
	);
}

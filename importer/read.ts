// READS A HAPR BOARD FOLDER INTO MEMORY: ITEMS, THEIR DOCUMENTS, LOGS, ATTACHMENTS, TASKS, REMOVED ITEMS AND THE ID MAP (SPEC 13)
// Only fsro.ts functions are used, so reading cannot change anything. What cannot be read is listed in `notes`, never skipped silently.

// -- DEP-MODULES -- //
import { join } from 'node:path';
// -- MODULES -- //
import { exists, isDir, names, readBytes, readText, rel, sha256 } from './fsro';
import { parseIdMap, parseTasks, type ParsedTask } from './parse';

// -- TYPES -- //

export type ItemJson = {
	id: string;
	legacyId: string | null;
	title: string;
	stream: string;
	scope: string;
	status: string;
	statusNote: string;
	dirNote: string | null;
	branch: string;
	baseRef: string;
	created: string;
	updated: string;
	external: { where: string } | null;
	legacyPercent: number | null;
	related: { id: string; relation: string }[];
	history: {
		at: string;
		kind: 'status' | 'note';
		from?: string | null;
		to?: string;
		note: string;
	}[];
	attachments: AttachmentRecord[];
	visibility?: 'public' | 'private';
	tabName?: string;
};
export type AttachmentRecord = {
	file: string;
	kind: string;
	caption: string;
	added: string;
	visibility: 'public' | 'private';
	refs: string[];
	source?: string | null;
	sha256: string;
};
export type SourceAttachment = AttachmentRecord & {
	path: string;
	/** Where the record came from: the item folder or the private manifest. */
	origin: 'public' | 'private';
};
export type SourceItem = {
	/** The folder relative to flow/, for example features/core/agent-flow-board. */
	dir: string;
	json: ItemJson;
	docs: {
		spec?: string;
		plan?: string;
		decisions?: string;
		progress?: string;
		validation?: string;
		references?: string;
	};
	log?: string;
	/** Other Markdown files inside the item folder, kept as documents. */
	extras: { path: string; text: string }[];
	/** Files in the item folder that are not Markdown and not attachments: scripts, data, traces and pictures kept with the work. */
	workingFiles: { rel: string; path: string }[];
	attachments: SourceAttachment[];
};
export type RemovedRow = {
	id: string;
	legacyId: string | null;
	stream: string;
	scope: string;
	status: string;
	percent: number | null;
	reason: string;
	dirNote: string;
	branch: string;
	baseRef: string;
	updated: string;
};
export type SourceBoard = {
	root: string;
	items: SourceItem[];
	removed: RemovedRow[];
	idMap: { legacy: string; flow: string; name: string }[];
	tasks: ParsedTask[];
	legacyHistoryRows: number;
	/** Things that could not be read or placed, for the report. */
	notes: string[];
};

// -- CONSTANTS -- //

const DOCS = {
	'SPEC.md': 'spec',
	'PLAN.md': 'plan',
	'DECISIONS.md': 'decisions',
	'PROGRESS.md': 'progress',
	'VALIDATION.md': 'validation',
	'REFERENCES.md': 'references'
} as const;

// -- FUNCTIONS -- //

/** The folders under flow/ that hold an item.json, at any depth. */
function itemDirs(flow: string): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const n of names(dir)) {
			if (n === '.git' || n === 'schema' || n === 'node_modules') continue;
			const p = join(dir, n);
			if (!isDir(p)) continue;
			if (exists(join(p, 'item.json'))) out.push(p);
			else walk(p);
		}
	};
	walk(flow);
	return out;
}

/** Everything inside an item folder that is not one of its own known files, split into documents and skipped files. */
function walkExtras(itemDir: string) {
	const extras: { path: string; text: string }[] = [];
	const workingFiles: { rel: string; path: string }[] = [];
	const known = new Set(['item.json', 'LOG.md', ...Object.keys(DOCS)]);
	const walk = (dir: string, top: boolean) => {
		for (const n of names(dir)) {
			const p = join(dir, n);
			if (isDir(p)) {
				if (top && n === 'attachments') continue;
				walk(p, false);
				continue;
			}
			if (top && known.has(n)) continue;
			if (/\.md$/i.test(n)) extras.push({ path: rel(itemDir, p), text: readText(p) });
			else workingFiles.push({ rel: rel(itemDir, p), path: p });
		}
	};
	walk(itemDir, true);
	return { extras, workingFiles };
}

export function readBoard(root: string): SourceBoard {
	const flow = join(root, 'flow');
	const notes: string[] = [];
	if (!isDir(flow))
		throw new Error(`${flow} is not a folder. Point the importer at a HAPR .board folder.`);
	const items: SourceItem[] = [];
	for (const dir of itemDirs(flow)) {
		const json = JSON.parse(readText(join(dir, 'item.json'))) as ItemJson;
		const docs: SourceItem['docs'] = {};
		for (const [file, key] of Object.entries(DOCS))
			if (exists(join(dir, file))) docs[key] = readText(join(dir, file));
		const log = exists(join(dir, 'LOG.md')) ? readText(join(dir, 'LOG.md')) : undefined;
		const { extras, workingFiles } = walkExtras(dir);
		const attachments: SourceAttachment[] = [];
		for (const a of json.attachments ?? []) {
			const path = join(dir, 'attachments', a.file);
			if (exists(path)) attachments.push({ ...a, path, origin: 'public' });
			else notes.push(`${json.id}: the public attachment ${a.file} is listed but missing`);
		}
		const manifest = join(root, 'attachments', json.id, 'manifest.json');
		if (exists(manifest)) {
			const m = JSON.parse(readText(manifest)) as { attachments: AttachmentRecord[] };
			for (const a of m.attachments) {
				const path = join(root, 'attachments', json.id, a.file);
				if (exists(path)) attachments.push({ ...a, path, origin: 'private' });
				else notes.push(`${json.id}: the private attachment ${a.file} is listed but missing`);
			}
		}
		items.push({ dir: rel(flow, dir), json, docs, log, extras, workingFiles, attachments });
	}
	items.sort((a, b) => a.json.id.localeCompare(b.json.id, 'en'));
	const removed = exists(join(flow, 'removed-items.json'))
		? (JSON.parse(readText(join(flow, 'removed-items.json'))) as { items: RemovedRow[] }).items
		: [];
	const idMap = exists(join(flow, 'ID-MAP.md'))
		? parseIdMap(readText(join(flow, 'ID-MAP.md')))
		: [];
	const tasksFile = join(root, 'TASKS.md');
	const tasks = exists(tasksFile) ? parseTasks(readText(tasksFile)) : [];
	const legacy = join(flow, 'history-legacy.md');
	const legacyHistoryRows = exists(legacy)
		? readText(legacy)
				.split('\n')
				.filter((l) => /^\|\s*`\d+\.\d+\.\d+`/.test(l)).length
		: 0;
	// A private manifest for an id with no folder is reported
	const attDir = join(root, 'attachments');
	if (isDir(attDir)) {
		const known = new Set(items.map((i) => i.json.id));
		for (const n of names(attDir))
			if (isDir(join(attDir, n)) && !known.has(n))
				notes.push(`attachments/${n} belongs to no item folder`);
	}
	return { root, items, removed, idMap, tasks, legacyHistoryRows, notes };
}

/** The bytes of an attachment and whether they match the checksum its record gives. */
export function attachmentBytes(a: SourceAttachment) {
	const bytes = readBytes(a.path);
	return { bytes, actual: sha256(bytes), matches: sha256(bytes) === a.sha256 };
}

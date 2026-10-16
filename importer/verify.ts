// THE CONTENT VERIFICATION REPORT: EVERY FACT OF THE SOURCE BOARD IS COMPARED WITH THE DATABASE BY ITS CONTENT, NOT BY ITS COUNT (SPEC 13)
// It reads the source again with the same read-only code, works out what each thing should have become with the same pure functions
// the import used, and compares that with what the database holds, including the bytes of every stored file.

// -- TYPES -- //
import type { Storage } from '../src/lib/server/adapters/storage';
import type { DbHandle } from '../src/lib/server/db/client';
import type { SourceBoard, SourceItem } from './read';
// -- DEP-MODULES -- //
import { createHash } from 'node:crypto';
// -- MODULES -- //
import {
	attachment,
	check,
	checkRun,
	decision,
	event,
	item,
	itemAlias,
	manualCheck,
	phase,
	section,
	step,
	task,
	uiChange,
	uiShotRun
} from '../src/lib/server/db/schema';
import { withTenant } from '../src/lib/server/db/tenant';
import { attachmentBytes } from './read';
import { readBytes } from './fsro';
import { parseDecisions, parsePlan, parseUiChanges } from './parse';
import {
	dateOfId,
	dayStart,
	documentsOf,
	eventsOf,
	flowIdOf,
	isRemoved,
	jsonOf,
	removedSources,
	type Source
} from './shape';

// -- TYPES -- //

export type Mismatch = { item: string; kind: string; detail: string };
export type Report = {
	ok: boolean;
	generated: string;
	source: { items: number; removedRows: number; tasks: number; attachments: number };
	/** How many facts of each kind were compared. A report that compared nothing proves nothing. */
	compared: Record<string, number>;
	mismatches: Mismatch[];
	/** Things left out on purpose or that did not map one to one, listed so none is silent. */
	notes: string[];
};
export type VerifyOptions = {
	handle: DbHandle;
	storage: Storage;
	orgId: string;
	projectId: string;
	themes: { key: string }[];
};

// -- CONSTANTS -- //

const TASK_STATUS = new Set(['TODO', 'IN PROGRESS', 'DONE', 'DROPPED', 'FUTURE']);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const day = (d: Date) => d.toISOString().slice(0, 10);

// -- FUNCTIONS -- //

/** The percent and status the old tools wrote into the generated block of PROGRESS.md, when there is one. */
export function recordedState(
	progress: string | undefined
): { status: string; percent: number | null } | null {
	const m = /<!-- flow:state:start[\s\S]*?-->\s*\*\*Status\*\*\s*`([^`]+)`,\s*(?:(\d+)%|n\/a)/.exec(
		progress ?? ''
	);
	return m ? { status: m[1], percent: m[2] === undefined ? null : Number(m[2]) } : null;
}

/** Compares what the source says with what the database holds. */
export async function verifyImport(board: SourceBoard, o: VerifyOptions): Promise<Report> {
	const mismatches: Mismatch[] = [];
	const compared: Record<string, number> = {};
	const notes = [...board.notes];
	const same = (kind: string, id: string, expected: unknown, actual: unknown, what = '') => {
		compared[kind] = (compared[kind] ?? 0) + 1;
		const a = JSON.stringify(expected);
		const b = JSON.stringify(actual);
		if (a !== b)
			mismatches.push({
				item: id,
				kind,
				detail: `${what}expected ${a.slice(0, 300)}, found ${b.slice(0, 300)}`
			});
	};

	const data = await withTenant(
		o.handle,
		{ orgId: o.orgId, projectId: o.projectId },
		async (tx) => ({
			items: await tx.select().from(item),
			aliases: await tx.select().from(itemAlias),
			phases: await tx.select().from(phase),
			steps: await tx.select().from(step),
			checks: await tx.select().from(manualCheck),
			decisions: await tx.select().from(decision),
			sections: await tx.select().from(section),
			events: await tx.select().from(event),
			attachments: await tx.select().from(attachment),
			uiChanges: await tx.select().from(uiChange),
			kitChecks: await tx.select().from(check),
			runs: await tx.select().from(checkRun),
			shotRuns: await tx.select().from(uiShotRun),
			tasks: await tx.select().from(task)
		})
	);
	const aliasToItem = new Map(data.aliases.map((a) => [a.alias, a.itemId]));
	const sources: Source[] = [...board.items, ...removedSources(board)];
	const attachmentCount = board.items.reduce((n, i) => n + i.attachments.length, 0);

	for (const src of sources) {
		const flowId = flowIdOf(src);
		const itemId = aliasToItem.get(flowId);
		const row = data.items.find((i) => i.id === itemId);
		if (!row) {
			mismatches.push({ item: flowId, kind: 'item', detail: 'is not in the database' });
			continue;
		}
		const j = jsonOf(src);
		const removed = isRemoved(src) ? src.removed : null;
		// The item itself
		same(
			'item',
			flowId,
			{
				stream: j?.stream ?? removed!.stream,
				scope: j?.scope ?? removed!.scope,
				status: j?.status ?? removed!.status,
				visibility: j?.visibility ?? 'public',
				branchNote: (j?.branch ?? removed!.branch).replace(/`/g, ''),
				legacyPercent: j ? j.legacyPercent : removed!.percent,
				tabName: j?.tabName ?? null,
				created: j?.created ?? dateOfId(flowId)
			},
			{
				stream: row.stream,
				scope: row.scope,
				status: row.status,
				visibility: row.visibility,
				branchNote: row.branchNote,
				legacyPercent: row.legacyPercent,
				tabName: row.tabName,
				created: day(new Date(row.createdAt.getTime() + 8 * 3600_000))
			}
		);
		if (j) same('item-title', flowId, j.title, row.title);
		const updatedAt = j ? new Date(j.updated) : dayStart(removed!.updated.slice(0, 10));
		same('item-updated', flowId, updatedAt.toISOString(), row.updatedAt.toISOString());
		// Names the item answers to
		const myAliases = new Set(data.aliases.filter((a) => a.itemId === row.id).map((a) => a.alias));
		const wanted = [
			flowId,
			j?.legacyId ?? removed?.legacyId,
			...board.idMap.filter((m) => m.flow === flowId).map((m) => m.legacy)
		].filter((x): x is string => Boolean(x));
		same('alias', flowId, wanted.sort(), wanted.filter((w) => myAliases.has(w)).sort());

		const full = isRemoved(src) ? null : (src as SourceItem);
		// The plan
		const plan = full?.docs.plan ? parsePlan(full.docs.plan) : null;
		if (plan) {
			const seenPhase = new Set<string>();
			const seenStep = new Set<string>();
			const expectedPhases: [string, string][] = [];
			const expectedSteps: [string, string, string, string | null][] = [];
			for (const ph of plan.phases) {
				if (seenPhase.has(ph.key)) continue;
				seenPhase.add(ph.key);
				expectedPhases.push([ph.key, ph.title]);
				for (const st of ph.steps) {
					if (seenStep.has(st.key)) continue;
					seenStep.add(st.key);
					expectedSteps.push([
						st.key,
						st.state,
						st.text,
						st.state === 'waived' || st.state === 'superseded' ? st.notes.join('\n') || null : null
					]);
				}
			}
			same(
				'phase',
				flowId,
				expectedPhases,
				data.phases
					.filter((p) => p.itemId === row.id)
					.sort((a, b) => a.position - b.position)
					.map((p) => [p.key, p.title])
			);
			same(
				'step',
				flowId,
				expectedSteps,
				data.steps
					.filter((s) => s.itemId === row.id)
					.sort((a, b) => a.position - b.position)
					.map((s) => [s.key, s.state, s.text, s.reason])
			);
			const seenCheck = new Set<string>();
			const expectedChecks = plan.checks
				.filter((c) => (seenCheck.has(c.key) ? false : seenCheck.add(c.key)))
				.map((c) => [
					c.key,
					c.text,
					c.auto,
					c.state,
					c.state === 'waived' || c.state === 'superseded' ? c.notes.join('\n') || null : null
				]);
			same(
				'manual-check',
				flowId,
				expectedChecks,
				data.checks
					.filter((c) => c.itemId === row.id)
					.sort((a, b) => a.position - b.position)
					.map((c) => [c.key, c.text, c.auto, c.state, c.reason])
			);
			// The percent: the old tools' own number for an open item, a frozen one for a closed legacy item
			const counted = expectedSteps.filter((s) => s[1] === 'open' || s[1] === 'done');
			const done = counted.filter((s) => s[1] === 'done').length;
			const expectedPercent =
				j?.legacyPercent ?? (counted.length === 0 ? 0 : Math.floor((done / counted.length) * 100));
			same('percent', flowId, expectedPercent, row.percent);
			const rec = recordedState(full?.docs.progress);
			if (rec && j && j.legacyPercent === null && rec.percent !== null)
				same('percent-vs-hapr', flowId, rec.percent, row.percent, 'the old board said ');
		}

		// Decisions
		const dec = full?.docs.decisions ? parseDecisions(full.docs.decisions) : null;
		if (dec) {
			const used = new Set<number>();
			let nextFree = Math.max(0, ...dec.adrs.map((a) => a.number)) + 1;
			const expected = dec.adrs.map((a) => {
				let n = a.number;
				if (used.has(n)) n = nextFree++;
				used.add(n);
				return [
					n,
					a.title || `ADR-${a.number}`,
					a.context,
					a.decision,
					a.alternatives,
					a.consequences
				];
			});
			same(
				'adr',
				flowId,
				expected,
				data.decisions
					.filter((d) => d.itemId === row.id && d.kind === 'adr')
					.sort((a, b) => a.position - b.position)
					.map((d) => [d.number, d.title, d.context, d.decision, d.alternatives, d.consequences])
			);
			same(
				'settled',
				flowId,
				dec.settled.map((s) => [s.question, s.answer, s.source]),
				data.decisions
					.filter((d) => d.itemId === row.id && d.kind === 'settled')
					.sort((a, b) => a.position - b.position)
					.map((d) => [d.title, d.answer, d.source])
			);
			if (dec.headings !== dec.adrs.length)
				mismatches.push({ item: flowId, kind: 'adr', detail: 'an ADR heading was counted twice' });
		}

		// Documents, byte for byte
		const docs = documentsOf(src);
		const mine = data.sections.filter((s) => s.itemId === row.id);
		same(
			'document-list',
			flowId,
			docs.map((d) => d.slug),
			mine.sort((a, b) => a.position - b.position).map((s) => s.slug)
		);
		for (const d of docs) {
			const got = mine.find((s) => s.slug === d.slug);
			same(
				'document',
				`${flowId} ${d.slug}`,
				sha(Buffer.from(d.body)),
				got ? sha(Buffer.from(got.body)) : null
			);
		}

		// History and log lines, with their dates
		const key = (e: { verb: string; at: Date; after: unknown }) => {
			const a = (e.after ?? {}) as Record<string, unknown>;
			return `${e.at.toISOString()}|${e.verb}|${String(a.text ?? a.status ?? a.title ?? '')}|${String(a.note ?? '')}`;
		};
		const expectedEvents = eventsOf(src)
			.map((e) => key(e))
			.sort();
		const gotEvents = data.events
			.filter((e) => e.itemId === row.id)
			.map((e) => key({ verb: e.verb, at: e.createdAt, after: e.after }))
			.sort();
		same('event', flowId, expectedEvents, gotEvents);

		// UI changes table
		if (full?.docs.validation) {
			const t = parseUiChanges(
				full.docs.validation,
				o.themes.map((x) => x.key)
			);
			same(
				'ui-change',
				flowId,
				t.rows,
				data.uiChanges
					.filter((u) => u.itemId === row.id)
					.sort((a, b) => a.position - b.position)
					.map((u) => ({
						page: u.page,
						stateRecipe: u.stateRecipe,
						themes: u.themes,
						accounts: u.accounts,
						siblings: u.siblings,
						levels: u.levels,
						viewports: u.viewports
					}))
			);
			if (t.tableRows > 0 && t.rows.length === 0)
				notes.push(
					`${flowId}: the UI changes table has ${t.tableRows} rows but no page could be read from them`
				);
		}

		// Attachments: the record, and the bytes in storage
		for (const a of full?.attachments ?? []) {
			const { bytes, actual, matches } = attachmentBytes(a);
			if (!matches)
				notes.push(
					`${flowId}: ${a.file} does not match the checksum of its record (${a.sha256.slice(0, 12)}, the file is ${actual.slice(0, 12)})`
				);
			const got = data.attachments.find(
				(x) => x.itemId === row.id && x.filename === a.file && x.caption === a.caption
			);
			if (!got) {
				mismatches.push({
					item: flowId,
					kind: 'attachment',
					detail: `${a.file} is not in the database`
				});
				continue;
			}
			same(
				'attachment',
				`${flowId} ${a.file}`,
				{
					visibility: a.visibility,
					kind: a.kind,
					refs: a.refs,
					size: bytes.byteLength,
					checksum: actual
				},
				{
					visibility: got.visibility,
					kind: got.kind,
					refs: got.refs,
					size: got.size,
					checksum: got.checksum
				}
			);
			const stored = await o.storage.get(got.storageKey);
			same('attachment-bytes', `${flowId} ${a.file}`, actual, stored ? sha(stored) : null);
		}

		// Working files kept with the item
		for (const w of full?.workingFiles ?? []) {
			const bytes = readBytes(w.path);
			const got = data.attachments.find(
				(x) => x.itemId === row.id && x.kind === 'working-file' && x.caption === w.rel
			);
			if (!got) {
				mismatches.push({
					item: flowId,
					kind: 'working-file',
					detail: `${w.rel} is not in the database`
				});
				continue;
			}
			const stored = await o.storage.get(got.storageKey);
			same('working-file', `${flowId} ${w.rel}`, sha(bytes), stored ? sha(stored) : null);
		}

		// Attached run results
		for (const a of full?.attachments ?? []) {
			if (!/\.json$/i.test(a.file)) continue;
			const isCheck = /^Browser check run/i.test(a.caption);
			const isShots = /^UI shots run/i.test(a.caption);
			if (!isCheck && !isShots) continue;
			let j: {
				run_id?: string;
				checks?: Record<string, unknown>;
				rows?: { shots?: { image?: string }[] }[];
				siblings?: Record<string, { image?: string }>;
			};
			try {
				j = JSON.parse(attachmentBytes(a).bytes.toString('utf8'));
			} catch {
				continue;
			}
			const rid = j.run_id ?? a.file;
			if (isCheck) {
				const runs = data.runs.filter((r) => r.reason?.includes(`HAPR run ${rid}`));
				same('check-run', `${flowId} ${rid}`, Object.keys(j.checks ?? {}).length, runs.length);
			} else {
				const runs = data.shotRuns.filter(
					(r) => r.itemId === row.id && r.reason?.includes(`HAPR run ${rid}`)
				);
				const images = [
					...(j.rows ?? []).flatMap((r) => (r.shots ?? []).map((s) => s.image)),
					...Object.values(j.siblings ?? {}).map((s) => s.image)
				].filter((x): x is string => Boolean(x && /^data:image\/jpeg;base64,/.test(x)));
				same('shots-run', `${flowId} ${rid}`, 1, runs.length);
				const expectedHashes = images
					.map((d) => sha(Buffer.from(d.split(',')[1], 'base64')))
					.sort();
				const gotHashes = data.attachments
					.filter((x) => x.itemId === row.id && x.kind === 'ui-shot' && x.refs.includes(rid))
					.map((x) => x.checksum)
					.sort();
				same('shots-pictures', `${flowId} ${rid}`, expectedHashes, gotHashes);
			}
		}
	}

	// Tasks
	for (const t of board.tasks) {
		const got = data.tasks.find((x) => x.number === t.number);
		if (!got) {
			mismatches.push({ item: `T-${t.number}`, kind: 'task', detail: 'is not in the database' });
			continue;
		}
		same(
			'task',
			`T-${t.number}`,
			{
				title: t.title,
				status: TASK_STATUS.has(t.status) ? t.status : 'TODO',
				group: t.group || null,
				priority: t.priority && t.priority !== '-' ? t.priority : null
			},
			{ title: got.title, status: got.status, group: got.groupName, priority: got.priority }
		);
		for (const part of [t.task, t.links, t.notes])
			if (part) same('task-text', `T-${t.number}`, true, got.body.includes(part), 'the text ');
	}

	// Totals
	same(
		'totals',
		'board',
		{ items: sources.length, tasks: board.tasks.length },
		{ items: data.items.length, tasks: data.tasks.length }
	);
	if (board.legacyHistoryRows > 0)
		notes.push(
			`history-legacy.md holds ${board.legacyHistoryRows} registry history rows. They belong to the registry, not to an item, and stay only in the HAPR board.`
		);
	return {
		ok: mismatches.length === 0 && Object.keys(compared).length > 0,
		generated: new Date().toISOString(),
		source: {
			items: board.items.length,
			removedRows: sources.length - board.items.length,
			tasks: board.tasks.length,
			attachments: attachmentCount
		},
		compared,
		mismatches,
		notes
	};
}

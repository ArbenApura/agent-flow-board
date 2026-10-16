// WHAT AN ITEM OF THE SOURCE BOARD BECOMES: ITS DOCUMENTS AND ITS EVENTS, AS PURE FUNCTIONS (SPEC 13)
// The import writes these and the verification report compares the database with them, so both stand on one definition.

// -- TYPES -- //
import type { ItemJson, RemovedRow, SourceBoard, SourceItem } from './read';
// -- MODULES -- //
import { parseDecisions, parseLog } from './parse';

export type Doc = { slug: string; title: string; body: string };
export type Planned = { at: Date; verb: string; before?: object; after: object };
export type Source = SourceItem | { removed: RemovedRow; title: string };

// -- FUNCTIONS -- //

/** The title of an item that has a row in removed-items.json and no folder: the name the ID map gives it. */
export const removedTitle = (r: RemovedRow, idMap: { flow: string; name: string }[]) =>
	idMap.find((m) => m.flow === r.id)?.name.replace(/\s*\(removed\)\s*$/, '') ||
	r.dirNote.replace(/`/g, '').split('/')[0] ||
	r.id;

export const isRemoved = (s: Source): s is { removed: RemovedRow; title: string } => 'removed' in s;
export const jsonOf = (s: Source): ItemJson | null => (isRemoved(s) ? null : s.json);
export const flowIdOf = (s: Source) => (isRemoved(s) ? s.removed.id : s.json.id);

export const dayStart = (d: string) => new Date(`${d}T00:00:00+08:00`);
export const dateOfId = (id: string) => {
	const m = /^FLOW-(\d{4})(\d{2})(\d{2})-/.exec(id);
	return m ? `${m[1]}-${m[2]}-${m[3]}` : '2026-09-18';
};

const slugOf = (s: string) =>
	s
		.toLowerCase()
		.replace(/\.md$/, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '') || 'document';

/** The generated state block of PROGRESS.md belongs to the old tools, so only the hand written part is a document. */
export const withoutStateBlock = (text: string) =>
	text.replace(/<!-- flow:state:start[\s\S]*?<!-- flow:state:end -->\n?/g, '');

/** The text of a registry document: what the old tools kept in item.json that has no column of its own. */
export function registryText(j: ItemJson): string {
	const lines: string[] = [];
	if (j.legacyId) lines.push(`- Legacy number: ${j.legacyId}`);
	if (j.dirNote) lines.push(`- Folder note: ${j.dirNote}`);
	if (j.baseRef) lines.push(`- Base ref: ${j.baseRef}`);
	if (j.statusNote) lines.push(`- Status note: ${j.statusNote}`);
	if (j.external) lines.push(`- Lives outside the repo: ${j.external.where}`);
	for (const r of j.related ?? []) lines.push(`- ${r.relation} ${r.id}`);
	return lines.length ? `${lines.join('\n')}\n` : '';
}

/** The documents an item becomes. Free text is kept whole, so nothing in an old format is lost. */
export function documentsOf(src: Source): Doc[] {
	const docs: Doc[] = [];
	const add = (slug: string, title: string, body: string | undefined) => {
		if (!body || !body.trim()) return;
		let s = slug;
		let n = 1;
		while (docs.some((d) => d.slug === s)) s = `${slug}-${++n}`;
		docs.push({ slug: s, title, body });
	};
	if (isRemoved(src)) {
		const r = src.removed;
		add(
			'registry',
			'Registry notes',
			[
				r.legacyId ? `- Legacy number: ${r.legacyId}` : '',
				`- Folder note: ${r.dirNote}`,
				`- Base ref: ${r.baseRef}`,
				`- Removed row: ${r.reason}`
			]
				.filter(Boolean)
				.join('\n') + '\n'
		);
		return docs;
	}
	add('spec', 'Spec', src.docs.spec);
	add('plan', 'Plan as written', src.docs.plan);
	add(
		'progress',
		'Progress notes',
		src.docs.progress ? withoutStateBlock(src.docs.progress) : undefined
	);
	add('validation', 'Validation', src.docs.validation);
	add('references', 'References', src.docs.references);
	for (const e of src.extras) add(slugOf(e.path), e.path, e.text);
	add('registry', 'Registry notes', registryText(src.json));
	if (src.docs.decisions) {
		const d = parseDecisions(src.docs.decisions);
		if (d.adrs.length === 0 && d.settled.length === 0)
			add('decisions', 'Decisions as written', src.docs.decisions);
	}
	return docs;
}

/** The events an item becomes: its creation, its history and its log lines, oldest first. */
export function eventsOf(src: Source): Planned[] {
	const j = jsonOf(src);
	const flowId = flowIdOf(src);
	const created = dayStart(j?.created ?? dateOfId(flowId));
	const events: Planned[] = [
		{
			at: created,
			verb: 'item.create',
			after: { title: j?.title ?? (isRemoved(src) ? src.title : flowId), imported: true }
		}
	];
	for (const h of j?.history ?? [])
		events.push(
			h.kind === 'status'
				? {
						at: new Date(h.at),
						verb: 'item.status',
						before: { status: h.from ?? null },
						after: { status: h.to, note: h.note, imported: true }
					}
				: { at: new Date(h.at), verb: 'item.log', after: { text: h.note, imported: true } }
		);
	if (!isRemoved(src) && src.log)
		for (const l of parseLog(src.log))
			events.push({
				at: new Date(l.at ?? `${j!.created}T00:00:00+08:00`),
				verb: 'item.log',
				after: { text: l.text, raw: l.raw, imported: true }
			});
	return events.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** The removed rows that have no folder, as items: they keep their row and the title the ID map gives them. */
export function removedSources(board: Pick<SourceBoard, 'items' | 'removed' | 'idMap'>): Source[] {
	return board.removed
		.filter((r) => !board.items.some((i) => i.json.id === r.id))
		.map((r) => ({ removed: r, title: removedTitle(r, board.idMap) }));
}

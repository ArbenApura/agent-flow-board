// THE LINKS OF A NOTE AS PLAIN LOGIC (AFB-20261111-0035, STEPS 5.2 AND 5.3)
// How the links panel groups what a note links to, which links can be removed there, where each link goes, which search
// results are worth offering, and the calls to the notes endpoints. No Svelte, so all of it runs in the tests.

// -- TYPES -- //

export type LinkKind = 'item' | 'task' | 'mockup' | 'note';
export type LinkSource = 'panel' | 'text';

/** One thing a note links to, as the links endpoint answers it. */
export interface NoteLink {
	kind: LinkKind;
	id: string;
	/** N-12, T-12 or the plan reference; null for a mockup. */
	ref: string | null;
	title: string;
	/** Where the link is written: the Links panel, the text of the note, or both. */
	sources: LinkSource[];
}

export interface NoteRef {
	id: string;
	ref: string;
	title: string;
}

export interface NoteLinks {
	links: NoteLink[];
	mentionedBy: NoteRef[];
}

/** A note that links to a plan, task or mockup. */
export interface LinkedNote extends NoteRef {
	folderId: string | null;
	updatedAt: string;
}

export interface LinkGroup {
	kind: LinkKind;
	label: string;
	links: NoteLink[];
}

/** What a search for something to link offers. */
export interface Target {
	kind: LinkKind;
	id: string;
	ref: string | null;
	title: string;
}

/** The part of `api` these calls need, so a test can hand in a fake. */
export type Call = <T>(
	org: string,
	path: string,
	init?: { method?: string; body?: unknown }
) => Promise<T>;

// -- CONSTANTS -- //

/** The order of the sections of the panel, and the words over each. */
export const GROUPS: { kind: LinkKind; label: string }[] = [
	{ kind: 'item', label: 'Plans' },
	{ kind: 'task', label: 'Tasks' },
	{ kind: 'mockup', label: 'Mockups' },
	{ kind: 'note', label: 'Notes it links to' }
];

export const KIND_NAME: Record<LinkKind, string> = {
	item: 'Plan',
	task: 'Task',
	mockup: 'Mockup',
	note: 'Note'
};

// -- FUNCTIONS -- //

/** The links in the four sections, in order. A section with no link is left out. */
export function groupLinks(links: NoteLink[]): LinkGroup[] {
	return GROUPS.map((g) => ({
		...g,
		links: links.filter((l) => l.kind === g.kind)
	})).filter((g) => g.links.length > 0);
}

/** A link can be taken off the panel only when it was put there by hand. A link written in the text goes when the text changes. */
export function canRemove(link: NoteLink): boolean {
	return link.sources.includes('panel');
}

/** True when removing the panel link would leave a link that is also written in the text. */
export function staysInText(link: NoteLink): boolean {
	return link.sources.includes('panel') && link.sources.includes('text');
}

/** The address of what a link points at. A mockup has no number, so it is opened by its id. */
export function linkHref(
	base: string,
	link: { kind: LinkKind; id: string; ref: string | null }
): string {
	switch (link.kind) {
		case 'item':
			return `${base}/${link.ref ?? link.id}`;
		case 'task':
			return `${base}/tasks?task=${encodeURIComponent(link.id)}`;
		case 'mockup':
			return `${base}/mockups/${link.id}`;
		case 'note':
			return `${base}/notes/${link.ref ?? link.id}`;
	}
}

/** The address of a note. */
export function noteHref(base: string, note: { ref: string }): string {
	return `${base}/notes/${note.ref}`;
}

/** The name a call uses for a target: its reference, or its id for a mockup. */
export function targetName(t: { id: string; ref: string | null }): string {
	return t.ref ?? t.id;
}

/**
 * The search results worth offering: not the note itself, not what is already linked, and only the kinds the picker is for.
 * Nothing is dropped from the list but those, so the order of the search is kept.
 */
export function offerTargets(
	targets: Target[],
	opts: { kinds?: LinkKind[]; selfId?: string; linked?: { kind: LinkKind; id: string }[] }
): Target[] {
	const have = new Set((opts.linked ?? []).map((l) => `${l.kind}:${l.id}`));
	return targets.filter(
		(t) =>
			(!opts.kinds || opts.kinds.includes(t.kind)) &&
			!(t.kind === 'note' && t.id === opts.selfId) &&
			!have.has(`${t.kind}:${t.id}`)
	);
}

// -- CALLS -- //

const notePath = (project: string, note: string, suffix = '') =>
	`/projects/${project}/notes/${note}${suffix}`;

/** What a note links to and which notes mention it. */
export async function fetchLinks(
	call: Call,
	org: string,
	project: string,
	note: string
): Promise<NoteLinks> {
	const got = await call<NoteLinks>(org, notePath(project, note, '/links'));
	return { links: got.links ?? [], mentionedBy: got.mentionedBy ?? [] };
}

/** Puts a link on the panel. Linking twice changes nothing. */
export function addLink(call: Call, org: string, project: string, note: string, target: Target) {
	return call(org, notePath(project, note, '/links'), {
		method: 'POST',
		body: { targetKind: target.kind, target: targetName(target) }
	});
}

/** Takes a link off the panel. */
export function removeLink(
	call: Call,
	org: string,
	project: string,
	note: string,
	link: { kind: LinkKind; id: string; ref: string | null }
) {
	const q = `targetKind=${link.kind}&target=${encodeURIComponent(targetName(link))}`;
	return call(org, notePath(project, note, `/links?${q}`), { method: 'DELETE' });
}

/** The notes that link to a plan, task or mockup. */
export async function fetchLinkedNotes(
	call: Call,
	org: string,
	project: string,
	target: { kind: 'item' | 'task' | 'mockup'; name: string }
): Promise<LinkedNote[]> {
	const q = `kind=${target.kind}&target=${encodeURIComponent(target.name)}`;
	const got = await call<{ notes: LinkedNote[] }>(org, `/projects/${project}/notes/linked-to?${q}`);
	return got.notes ?? [];
}

/** Things in the project whose title contains the words. */
export async function searchTargets(
	call: Call,
	org: string,
	project: string,
	q: string
): Promise<Target[]> {
	const got = await call<{ targets: Target[] }>(
		org,
		`/projects/${project}/notes/link-targets?q=${encodeURIComponent(q)}`
	);
	return got.targets ?? [];
}

// HOW A TASK STATUS IS SHOWN, AND THE PURE HELPERS THE TASKS PAGE FILTERS AND GROUPS WITH

// -- TYPES -- //
export type TaskState = 'TODO' | 'IN PROGRESS' | 'FUTURE' | 'DONE' | 'DROPPED';
export type TaskView = 'board' | 'groups' | 'list';
/** What the helpers need of a task. The rows the server sends carry more fields and still fit. */
export type TaskRow = {
	id: string;
	number: number;
	version: number;
	title: string;
	status: string;
	body: string;
	groupName: string | null;
	priority: string | null;
	assigneeId: string | null;
	linkedItemIds: string[];
};
/** What a person can change in the drawer. Blank group and priority mean none, no assignee is an empty string. */
export type TaskForm = {
	title: string;
	body: string;
	groupName: string;
	priority: string;
	assigneeId: string;
};
export type TaskChanges = {
	title?: string;
	body?: string;
	groupName?: string | null;
	priority?: string | null;
	assigneeId?: string | null;
};
export type TaskFilter = { q: string; status: TaskState[]; priority: string[] };

// -- CONSTANTS -- //

/** The board columns, in the order a task moves through them. */
export const TASK_STATES = ['TODO', 'IN PROGRESS', 'FUTURE', 'DONE', 'DROPPED'] as const;
export const TASK_VIEWS = ['board', 'groups', 'list'] as const;
export const TASK_VIEW_LABEL: Record<TaskView, string> = {
	board: 'Board',
	groups: 'Groups',
	list: 'List'
};
/** The value the priority filter uses for a task that has no priority. */
export const NO_PRIORITY = 'none';
/** A finished column shows this many cards until the person asks for more. */
export const CLOSED_COLUMN_LIMIT = 20;
/** Fixed status tokens, never the org accent. STATUS_STYLE belongs to items and has no task statuses. */
export const TASK_STATUS_STYLE: Record<TaskState, { dot: string; top: string; rail: string }> = {
	TODO: { dot: 'bg-muted', top: 'border-t-muted', rail: 'bg-muted' },
	'IN PROGRESS': { dot: 'bg-info', top: 'border-t-info', rail: 'bg-info' },
	FUTURE: { dot: 'bg-hold', top: 'border-t-hold', rail: 'bg-hold' },
	DONE: { dot: 'bg-success', top: 'border-t-success', rail: 'bg-success' },
	DROPPED: { dot: 'bg-danger', top: 'border-t-danger', rail: 'bg-danger' }
};

// -- FUNCTIONS -- //

export const isTaskState = (s: string): s is TaskState =>
	(TASK_STATES as readonly string[]).includes(s);

/** A status the database guarantees, narrowed for the style lookup. Anything else reads as TODO. */
export const asTaskState = (s: string): TaskState => (isTaskState(s) ? s : 'TODO');

export const parseTaskView = (v: string | null): TaskView =>
	(TASK_VIEWS as readonly string[]).includes(v ?? '') ? (v as TaskView) : 'board';

/** The key a task's priority is filtered by. Empty and missing priorities are the same. */
export const priorityKey = (p: string | null): string => p?.trim() || NO_PRIORITY;

/** The distinct priorities present, with how many tasks each holds. No priority comes last. */
export function priorityOptions(tasks: TaskRow[]): { value: string; label: string; n: number }[] {
	const counts = new Map<string, number>();
	for (const t of tasks)
		counts.set(priorityKey(t.priority), (counts.get(priorityKey(t.priority)) ?? 0) + 1);
	return [...counts.entries()]
		.map(([value, n]) => ({ value, label: value === NO_PRIORITY ? 'No priority' : value, n }))
		.sort((a, b) =>
			a.value === NO_PRIORITY
				? 1
				: b.value === NO_PRIORITY
					? -1
					: a.value.localeCompare(b.value, 'en', { numeric: true })
		);
}

/** Search matches the title, the body and the group. Empty status or priority lists mean no limit. */
export function filterTasks<T extends TaskRow>(tasks: T[], f: TaskFilter): T[] {
	const q = f.q.trim().toLowerCase();
	return tasks.filter((t) => {
		if (f.status.length && !f.status.includes(asTaskState(t.status))) return false;
		if (f.priority.length && !f.priority.includes(priorityKey(t.priority))) return false;
		if (!q) return true;
		return [t.title, t.body, t.groupName ?? ''].some((s) => s.toLowerCase().includes(q));
	});
}

export function groupByStatus<T extends TaskRow>(tasks: T[]): Record<TaskState, T[]> {
	const out: Record<TaskState, T[]> = {
		TODO: [],
		'IN PROGRESS': [],
		FUTURE: [],
		DONE: [],
		DROPPED: []
	};
	for (const t of tasks) out[asTaskState(t.status)].push(t);
	return out;
}

/** Tasks under their group name, groups in name order and the tasks without a group last. */
export function groupByName<T extends TaskRow>(tasks: T[]): { name: string | null; tasks: T[] }[] {
	const named = new Map<string, T[]>();
	const loose: T[] = [];
	for (const t of tasks) {
		const name = t.groupName?.trim();
		if (!name) loose.push(t);
		else (named.get(name) ?? named.set(name, []).get(name))?.push(t);
	}
	const groups = [...named.entries()]
		.sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true }))
		.map(([name, list]) => ({ name: name as string | null, tasks: list }));
	return loose.length ? [...groups, { name: null, tasks: loose }] : groups;
}

/** A finished column shows its first cards until it is opened. */
export const capColumn = <T>(list: T[], state: TaskState, open: boolean): T[] =>
	(state === 'DONE' || state === 'DROPPED') && !open ? list.slice(0, CLOSED_COLUMN_LIMIT) : list;

/** The body as one plain line for a card: Markdown marks are dropped, and nothing is ever rendered as HTML. */
export function bodyPreview(body: string): string {
	return (
		body
			.slice(0, 400)
			// Images and links keep their text, checklist and list markers go, fence lines lose their language word
			.replace(/!?\[([^\]]*)\]\([^)\s]*\)/g, '$1')
			.replace(/^\s*```.*$/gm, ' ')
			.replace(/^[\s>]*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?)/gm, '')
			// Emphasis marks only at word edges, so snake_case_name and ~5 min stay as written
			.replace(/(\*{1,2})([^\s*](?:[^*]*[^\s*])?)\1/g, '$2')
			.replace(/(^|\W)_(\S(?:[^_]*\S)?)_(?=\W|$)/g, '$1$2')
			.replace(/`([^`]*)`/g, '$1')
			.replace(/\s+/g, ' ')
			.trim()
	);
}

/** The form a task starts from when Edit opens. */
export const formOf = (t: {
	title: string;
	body: string;
	groupName: string | null;
	priority: string | null;
	assigneeId: string | null;
}): TaskForm => ({
	title: t.title,
	body: t.body,
	groupName: t.groupName ?? '',
	priority: t.priority ?? '',
	assigneeId: t.assigneeId ?? ''
});

/** Only the fields that differ from the baseline, so a save never overwrites what the person did not touch. */
export function diffTask(baseline: TaskForm, form: TaskForm): TaskChanges {
	const out: TaskChanges = {};
	if (form.title.trim() !== baseline.title.trim()) out.title = form.title.trim();
	if (form.body !== baseline.body) out.body = form.body;
	if (form.groupName.trim() !== baseline.groupName.trim())
		out.groupName = form.groupName.trim() || null;
	if (form.priority.trim() !== baseline.priority.trim())
		out.priority = form.priority.trim() || null;
	if (form.assigneeId !== baseline.assigneeId) out.assigneeId = form.assigneeId || null;
	return out;
}

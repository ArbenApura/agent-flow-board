// -- DEP-MODULES -- //
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import {
	CLOSED_COLUMN_LIMIT,
	NO_PRIORITY,
	type TaskRow,
	bodyPreview,
	capColumn,
	diffTask,
	filterTasks,
	formOf,
	groupByName,
	groupByStatus,
	parseTaskView,
	priorityKey,
	priorityOptions
} from './tasks.js';

// -- CONSTANTS -- //

const task = (n: number, over: Partial<TaskRow> = {}): TaskRow => ({
	id: `id-${n}`,
	number: n,
	version: 1,
	title: `Task ${n}`,
	status: 'TODO',
	body: '',
	groupName: null,
	priority: null,
	assigneeId: null,
	linkedItemIds: [],
	...over
});

// -- TESTS -- //

describe('filterTasks', () => {
	const all = [
		task(1, { title: 'Fix billing', priority: 'P1', groupName: 'Billing' }),
		task(2, { body: 'Mentions BILLING in the body', status: 'DONE' }),
		task(3, { priority: '  ', status: 'IN PROGRESS' })
	];

	it('matches the title, the body and the group, ignoring case', () => {
		const hits = filterTasks(all, { q: 'billing', status: [], priority: [] });
		expect(hits.map((t) => t.number)).toEqual([1, 2]);
	});

	it('limits by status and by priority, with a blank priority meaning none', () => {
		expect(
			filterTasks(all, { q: '', status: ['DONE'], priority: [] }).map((t) => t.number)
		).toEqual([2]);
		expect(
			filterTasks(all, { q: '', status: [], priority: [NO_PRIORITY] }).map((t) => t.number)
		).toEqual([2, 3]);
		expect(filterTasks(all, { q: '', status: [], priority: ['P1'] }).map((t) => t.number)).toEqual([
			1
		]);
	});

	it('returns every task when nothing is asked', () => {
		expect(filterTasks(all, { q: ' ', status: [], priority: [] })).toHaveLength(3);
	});
});

describe('priorityOptions', () => {
	it('lists the distinct values with counts and puts no priority last', () => {
		const opts = priorityOptions([
			task(1),
			task(2, { priority: 'P2' }),
			task(3, { priority: 'P10' }),
			task(4, { priority: 'P2' })
		]);
		expect(opts.map((o) => [o.value, o.n])).toEqual([
			['P2', 2],
			['P10', 1],
			[NO_PRIORITY, 1]
		]);
		expect(opts.at(-1)?.label).toBe('No priority');
	});

	it('reads a blank priority as none', () => {
		expect(priorityKey(' ')).toBe(NO_PRIORITY);
		expect(priorityKey(null)).toBe(NO_PRIORITY);
	});
});

describe('groupByStatus', () => {
	it('puts every task in its column and an unknown status in TODO', () => {
		const cols = groupByStatus([
			task(1),
			task(2, { status: 'DONE' }),
			task(3, { status: 'WEIRD' })
		]);
		expect(cols.TODO.map((t) => t.number)).toEqual([1, 3]);
		expect(cols.DONE.map((t) => t.number)).toEqual([2]);
		expect(cols.DROPPED).toEqual([]);
	});
});

describe('groupByName', () => {
	it('sorts the groups and keeps the tasks without a group last', () => {
		const groups = groupByName([
			task(1),
			task(2, { groupName: 'Zeta' }),
			task(3, { groupName: 'Alpha' }),
			task(4, { groupName: '  ' })
		]);
		expect(groups.map((g) => g.name)).toEqual(['Alpha', 'Zeta', null]);
		expect(groups.at(-1)?.tasks.map((t) => t.number)).toEqual([1, 4]);
	});

	it('has no loose bucket when every task has a group', () => {
		expect(groupByName([task(1, { groupName: 'A' })]).map((g) => g.name)).toEqual(['A']);
		expect(groupByName([])).toEqual([]);
	});
});

describe('capColumn', () => {
	const many = Array.from({ length: CLOSED_COLUMN_LIMIT + 5 }, (_, i) => i);

	it('caps only the finished columns until they are opened', () => {
		expect(capColumn(many, 'DONE', false)).toHaveLength(CLOSED_COLUMN_LIMIT);
		expect(capColumn(many, 'DROPPED', false)).toHaveLength(CLOSED_COLUMN_LIMIT);
		expect(capColumn(many, 'DONE', true)).toHaveLength(many.length);
		expect(capColumn(many, 'TODO', false)).toHaveLength(many.length);
	});
});

describe('bodyPreview', () => {
	it('drops Markdown marks and joins the lines', () => {
		expect(bodyPreview('## Title\n- **bold** and `code`\n[link](http://x.test) end')).toBe(
			'Title bold and code link end'
		);
	});

	it('keeps identifiers, numbers and issue marks as written', () => {
		expect(bodyPreview('Rename snake_case_name, about ~5 min\n#42 and +1')).toBe(
			'Rename snake_case_name, about ~5 min #42 and +1'
		);
	});

	it('handles checklists, images, bullets and fences', () => {
		expect(bodyPreview('- [ ] todo\n- [x] done\n* bullet\n+ plus\n![shot](a.png)')).toBe(
			'todo done bullet plus shot'
		);
		expect(bodyPreview('```ts\nconst a = 1\n```')).toBe('const a = 1');
		expect(bodyPreview('*em* and **strong** and _under_')).toBe('em and strong and under');
	});

	it('leaves markup as text, never as HTML', () => {
		expect(bodyPreview('<b>hi</b>')).toBe('<b>hi</b>');
	});
});

describe('parseTaskView', () => {
	it('falls back to the board', () => {
		expect(parseTaskView('list')).toBe('list');
		expect(parseTaskView('areas')).toBe('board');
		expect(parseTaskView(null)).toBe('board');
	});
});

describe('diffTask', () => {
	const base = formOf(
		task(1, { title: 'Original title', body: 'Body', groupName: 'Ops', priority: 'P1' })
	);

	it('is empty when nothing changed, trimming does not count as a change', () => {
		expect(diffTask(base, { ...base })).toEqual({});
		expect(diffTask(base, { ...base, title: '  Original title ', groupName: ' Ops ' })).toEqual({});
	});

	it('sends only what changed', () => {
		expect(diffTask(base, { ...base, body: 'New body' })).toEqual({ body: 'New body' });
		expect(diffTask(base, { ...base, title: 'Another title', priority: 'P3' })).toEqual({
			title: 'Another title',
			priority: 'P3'
		});
	});

	it('clears a blank group or priority with null, and no assignee with null', () => {
		expect(diffTask(base, { ...base, groupName: '  ', priority: '' })).toEqual({
			groupName: null,
			priority: null
		});
		const assigned = formOf(task(2, { assigneeId: 'u1' }));
		expect(diffTask(assigned, { ...assigned, assigneeId: '' })).toEqual({ assigneeId: null });
		expect(diffTask(formOf(task(3)), { ...formOf(task(3)), assigneeId: 'u2' })).toEqual({
			assigneeId: 'u2'
		});
	});

	it('starts a task with no group, priority or assignee from empty fields', () => {
		expect(formOf(task(4))).toMatchObject({ groupName: '', priority: '', assigneeId: '' });
	});
});

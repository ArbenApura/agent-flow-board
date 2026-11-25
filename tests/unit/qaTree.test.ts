// QA MAP TREE (AFB-20261125-1421): AREAS ARE / PATHS, GROUPS NEST, COUNTS ROLL UP AND FLAT AREAS KEEP WORKING

// IMPORTED DEP-MODULES
import { describe, expect, it } from 'vitest';
// IMPORTED MODULES
import {
	QA_AREA_OTHER,
	qaAreaPath,
	qaBuildTree,
	qaGroupPaths,
	qaInArea
} from '../../src/lib/board/qa/status';

// -- CONSTANTS -- //

const f = (key: string, area: string) => ({ key, area });
const SAMPLE = [
	f('a', 'apps/admin'),
	f('b', 'apps/centers'),
	f('c', 'apps/centers/queue'),
	f('d', 'apps/site'),
	f('e', ''),
	f('g', 'apps/centers')
];

// -- TESTS -- //

describe('qaAreaPath', () => {
	it('trims the parts and drops empty ones', () => {
		expect(qaAreaPath(' apps / admin ')).toBe('apps/admin');
		expect(qaAreaPath('apps//admin/')).toBe('apps/admin');
	});
	it('names a blank or missing area Other', () => {
		expect(qaAreaPath('')).toBe(QA_AREA_OTHER);
		expect(qaAreaPath('  / ')).toBe(QA_AREA_OTHER);
		expect(qaAreaPath(null)).toBe(QA_AREA_OTHER);
		expect(qaAreaPath(undefined)).toBe(QA_AREA_OTHER);
	});
	it('keeps a flat area as a one level path', () => {
		expect(qaAreaPath('Billing')).toBe('Billing');
	});
	it('keeps the first four parts of a longer path', () => {
		expect(qaAreaPath('a/b/c/d/e/f')).toBe('a/b/c/d');
	});
});

describe('qaInArea', () => {
	it('matches the group and everything under it, not a name that only starts the same', () => {
		expect(qaInArea('apps/centers/queue', 'apps/centers')).toBe(true);
		expect(qaInArea('apps/centers', 'apps/centers')).toBe(true);
		expect(qaInArea('apps/centers-old', 'apps/centers')).toBe(false);
		expect(qaInArea('apps/site', 'apps/centers')).toBe(false);
	});
	it('matches everything for an empty filter, and a blank area for Other', () => {
		expect(qaInArea('x/y', '')).toBe(true);
		expect(qaInArea('', QA_AREA_OTHER)).toBe(true);
	});
	it('treats a group really called all as a group, not as no filter', () => {
		expect(qaInArea('all/x', 'all')).toBe(true);
		expect(qaInArea('apps', 'all')).toBe(false);
	});
});

describe('qaBuildTree', () => {
	const tree = qaBuildTree(SAMPLE);

	it('nests groups by path and makes a node for a parent that holds no feature itself', () => {
		expect(tree.map((n) => n.path)).toEqual(['apps', QA_AREA_OTHER]);
		const apps = tree[0];
		expect(apps.own).toEqual([]);
		expect(apps.children.map((n) => n.path)).toEqual(['apps/admin', 'apps/centers', 'apps/site']);
		expect(apps.children[1].children.map((n) => n.path)).toEqual(['apps/centers/queue']);
	});

	it('rolls every feature of a subtree into the parent and keeps the own ones apart', () => {
		const apps = tree[0];
		expect(apps.all.map((x) => x.key).sort()).toEqual(['a', 'b', 'c', 'd', 'g']);
		const centers = apps.children[1];
		expect(centers.own.map((x) => x.key)).toEqual(['b', 'g']);
		expect(centers.all.map((x) => x.key).sort()).toEqual(['b', 'c', 'g']);
	});

	it('gives each node its label, trail and depth', () => {
		const queue = tree[0].children[1].children[0];
		expect(queue.label).toBe('queue');
		expect(queue.trail).toBe('apps / centers');
		expect(queue.depth).toBe(2);
		expect(tree[0].trail).toBe('');
		expect(tree[0].depth).toBe(0);
	});

	it('puts Other last and keeps the feature order inside a group', () => {
		const flat = qaBuildTree([f('z', ''), f('y', 'Billing'), f('x', 'Account'), f('w', 'Account')]);
		expect(flat.map((n) => n.path)).toEqual(['Account', 'Billing', QA_AREA_OTHER]);
		expect(flat[0].own.map((x) => x.key)).toEqual(['x', 'w']);
	});

	it('caps a deep path at four levels and merges a blank area with a literal Other', () => {
		const t = qaBuildTree([f('p', 'a/b/c/d/e/f'), f('q', ''), f('r', 'Other'), f('s', ' ')]);
		expect(qaGroupPaths(t).map((g) => g.path)).toEqual([
			'a',
			'a/b',
			'a/b/c',
			'a/b/c/d',
			QA_AREA_OTHER
		]);
		const other = t.find((n) => n.path === QA_AREA_OTHER);
		expect(other?.own.map((x) => x.key)).toEqual(['q', 'r', 's']);
		expect(t[0].all.map((x) => x.key)).toEqual(['p']);
	});

	it('keeps a group named all and treats different case as different groups', () => {
		const t = qaBuildTree([f('a', 'all/x'), f('b', 'Apps'), f('c', 'apps')]);
		expect(t.map((n) => n.path).sort()).toEqual(['Apps', 'all', 'apps']);
	});

	it('returns nothing for no features', () => {
		expect(qaBuildTree([])).toEqual([]);
	});
});

describe('qaGroupPaths', () => {
	it('lists parents before their children, with depths', () => {
		expect(qaGroupPaths(qaBuildTree(SAMPLE))).toEqual([
			{ path: 'apps', label: 'apps', depth: 0 },
			{ path: 'apps/admin', label: 'admin', depth: 1 },
			{ path: 'apps/centers', label: 'centers', depth: 1 },
			{ path: 'apps/centers/queue', label: 'queue', depth: 2 },
			{ path: 'apps/site', label: 'site', depth: 1 },
			{ path: QA_AREA_OTHER, label: QA_AREA_OTHER, depth: 0 }
		]);
	});
});

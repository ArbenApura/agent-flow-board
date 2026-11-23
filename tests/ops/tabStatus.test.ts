import { describe, expect, it } from 'vitest';
import { tabStatuses, type TabStatusInput } from '../../src/lib/connect/tabStatus';

const base: TabStatusInput = {
	connections: 0,
	skillsVersion: '1.15.0',
	canSetUp: true,
	signIn: { state: 'none' }
};
const of = (over: Partial<TabStatusInput>) => tabStatuses({ ...base, ...over });

describe('the status pills of the Connect tab cards', () => {
	it('counts the connected apps with the right plural and says None yet for none', () => {
		expect(of({ connections: 0 }).tools.text).toBe('None yet');
		expect(of({ connections: 1 }).tools.text).toBe('1 app');
		expect(of({ connections: 3 }).tools.text).toBe('3 apps');
	});

	it('shows the release number in mono, and a danger pill when the bundle could not be read', () => {
		expect(of({}).skills).toEqual({ text: '1.15.0', tone: 'neutral', mono: true });
		expect(of({ skillsVersion: null }).skills).toMatchObject({
			text: 'Not loaded',
			tone: 'danger'
		});
	});

	it('gives each bridge sign in state its own word and a fixed status tone, never the accent', () => {
		expect(of({ signIn: { state: 'signed-in' } }).editor).toEqual({
			text: 'Signed in',
			tone: 'success'
		});
		expect(of({ signIn: { state: 'expired' } }).editor).toEqual({
			text: 'Expired',
			tone: 'warning'
		});
		expect(of({ signIn: { state: 'none' } }).editor).toEqual({
			text: 'Not set up',
			tone: 'neutral'
		});
		expect(of({ signIn: null }).editor).toEqual({ text: 'Not read', tone: 'danger' });
		// Needs Manage comes first: a person who cannot set it up is told so, whatever the sign in says
		expect(of({ canSetUp: false, signIn: { state: 'signed-in' } }).editor.text).toBe(
			'Needs Manage'
		);
		for (const s of [{ state: 'signed-in' as const }, { state: 'expired' as const }, null])
			expect(['neutral', 'success', 'warning', 'danger']).toContain(of({ signIn: s }).editor.tone);
	});

	it('follows the bridge sign in for the Bridge pill', () => {
		expect(of({ signIn: null }).bridge).toEqual({ text: 'Not read', tone: 'danger' });
		expect(of({ signIn: { state: 'none' } }).bridge).toEqual({
			text: 'Not signed in',
			tone: 'neutral'
		});
		expect(of({ signIn: { state: 'signed-in' } }).bridge).toEqual({
			text: 'Signed in',
			tone: 'success'
		});
		expect(of({ signIn: { state: 'expired' } }).bridge).toEqual({
			text: 'Expired',
			tone: 'warning'
		});
	});
});

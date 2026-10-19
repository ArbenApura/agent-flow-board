import { describe, expect, it } from 'vitest';
import { SettingsTabs } from './tabs.svelte';

describe('the settings tabs', () => {
	it('lists a section once, and drops its tab when the section leaves', () => {
		const tabs = new SettingsTabs();
		tabs.add({ id: 'general', title: 'General' });
		tabs.add({ id: 'general', title: 'General again' });
		tabs.add({ id: 'environments', title: 'Environments' });
		expect(tabs.items.map((t) => t.id)).toEqual(['general', 'environments']);
		tabs.remove('environments');
		expect(tabs.items.map((t) => t.id)).toEqual(['general']);
		tabs.remove('missing');
		expect(tabs.items).toHaveLength(1);
	});
});

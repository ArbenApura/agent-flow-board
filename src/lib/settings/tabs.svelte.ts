// THE SECTIONS OF A SETTINGS PAGE, COLLECTED AS THEY RENDER, SO THE SIDE NAVIGATION AND THE ONE VISIBLE SECTION AGREE (ADR-004)
// IMPORTED DEP-TYPES
import type { Component } from 'svelte';
// IMPORTED DEP-MODULES
import { getContext, setContext } from 'svelte';

// -- TYPES -- //

export type SettingsTab = {
	id: string;
	title: string;
	/** The small picture in the navigation, the same one the section card carries. */
	icon?: Component<{ size?: number; class?: string }>;
	/** The heading the tab sits under. Tabs without one render in a flat list. */
	group?: string;
};

// -- CONSTANTS -- //

const KEY = Symbol('settings-tabs');

// -- FUNCTIONS -- //

export class SettingsTabs {
	items = $state<SettingsTab[]>([]);

	/** Called by each section while it renders, on the server and in the browser, so the list is complete in the first HTML. */
	add(tab: SettingsTab) {
		if (!this.items.some((t) => t.id === tab.id)) this.items.push(tab);
	}

	/** Called when a section leaves the page (hidden by a switch), so its tab leaves the navigation with it. */
	remove(id: string) {
		this.items = this.items.filter((t) => t.id !== id);
	}
}

export const createTabs = () => setContext(KEY, new SettingsTabs());
export const useTabs = () => getContext<SettingsTabs | undefined>(KEY);

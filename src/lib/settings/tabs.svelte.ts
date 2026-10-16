// THE SECTIONS OF A SETTINGS PAGE, COLLECTED AS THEY RENDER, SO THE SIDE NAVIGATION AND THE ONE VISIBLE SECTION AGREE (ADR-004)
import { getContext, setContext } from 'svelte';

// -- TYPES -- //

export type SettingsTab = { id: string; title: string };

// -- CONSTANTS -- //

const KEY = Symbol('settings-tabs');

// -- FUNCTIONS -- //

class SettingsTabs {
	items = $state<SettingsTab[]>([]);

	/** Called by each section while it renders, on the server and in the browser, so the list is complete in the first HTML. */
	add(id: string, title: string) {
		if (!this.items.some((t) => t.id === id)) this.items.push({ id, title });
	}
}

export const createTabs = () => setContext(KEY, new SettingsTabs());
export const useTabs = () => getContext<SettingsTabs | undefined>(KEY);

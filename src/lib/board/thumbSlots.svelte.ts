// THE LIVE PREVIEW FRAMES THAT EXIST RIGHT NOW. SHARED BY EVERY CARD, SO NO MORE THAN MAX_LIVE_FRAMES RUN AT ONCE

// IMPORTED DEP-MODULES
import { SvelteMap } from 'svelte/reactivity';
// IMPORTED MODULES
import { planSlot } from '#lib/board/thumbLoad.js';

// -- CONSTANTS -- //

/** Card id to its distance from the middle of the screen, for every live frame. A card reads `has` to know it may show its frame. */
const live = new SvelteMap<string, number>();

// -- FUNCTIONS -- //

export const thumbSlots = {
	has: (id: string): boolean => live.has(id),
	/** Asks for a slot. A nearer card takes the place of the farthest one, which then reads `has` as false and shows the placeholder. */
	request(id: string, distance: number): boolean {
		const plan = planSlot(live, id, distance);
		if (!plan.grant) return false;
		if (plan.evict) live.delete(plan.evict);
		live.set(id, distance);
		return true;
	},
	/** Keeps the distance of a card that has a slot current as it moves, so the farthest one is the farthest now and not when it came near. */
	touch(id: string, distance: number): void {
		if (live.has(id)) live.set(id, distance);
	},
	release(id: string): void {
		live.delete(id);
	}
};

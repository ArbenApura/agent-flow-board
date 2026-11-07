// THE MOCKUPS OF ONE PLAN FOR ITS PAGE: A COUNT AND A LIST ON EVERY LOAD, AND THE PREVIEW AND BUILD NOTES ONLY WHEN THE MOCKUPS TAB IS OPEN

// -- TYPES -- //
import type { Ctx } from '../ops/context';
// -- MODULES -- //
import { ALL_SCREENS } from '../../board/mockups';
import { getMockup, listMockups, mockupFileGrant } from '../ops/mockups';
import { memberMockupUrl } from './mockupLinks';
import { cardThumb } from './mockupThumbs';

// -- TYPES -- //

export type ItemMockups = {
	list: {
		id: string;
		title: string;
		currentVersion: number;
		versions: number;
		hasShot: boolean;
		thumb: string;
		/** True when the address is a live preview page, false for a screenshot. */
		live: boolean;
		updatedAt: Date;
		publicLinkOn: boolean;
	}[];
	/** The newest mockup of the plan with its preview address and notes, only when the tab is open. */
	open: {
		id: string;
		version: number;
		src: string;
		screens: string[];
		notes: { author: string | null; keep: string; free: string } | null;
	} | null;
};

// -- FUNCTIONS -- //

export async function itemMockups(
	ctx: Ctx,
	projectKey: string,
	itemRef: string,
	withPreview: boolean
): Promise<ItemMockups> {
	const { mockups } = await listMockups(ctx, { project: projectKey, item: itemRef });
	const list = mockups.map((m) => ({
		id: m.id,
		title: m.title,
		currentVersion: m.currentVersion,
		versions: m.versions,
		hasShot: m.hasShot,
		...cardThumb(ctx.orgId, m),
		updatedAt: m.updatedAt,
		publicLinkOn: m.publicLinkOn
	}));
	if (!withPreview || list.length === 0) return { list, open: null };
	const first = list[0];
	const [detail, grant] = await Promise.all([
		getMockup(ctx, first.id),
		mockupFileGrant(ctx, first.id)
	]);
	return {
		list,
		open: {
			id: first.id,
			version: first.currentVersion,
			src: memberMockupUrl(grant),
			screens: ALL_SCREENS,
			notes: detail.notes
				? { author: detail.notes.author, keep: detail.notes.keep, free: detail.notes.free }
				: null
		}
	};
}

// THE MOCKUPS OF ONE PLAN FOR ITS PAGE: A COUNT AND A LIST ON EVERY LOAD, AND THE PREVIEW AND BUILD NOTES ONLY WHEN THE MOCKUPS TAB IS OPEN

// -- TYPES -- //
import type { Ctx } from '../ops/context';
// -- MODULES -- //
import { getMockupSettings } from '../ops/mockupSettings';
import { getMockup, listMockups, mockupFileGrant } from '../ops/mockups';
import { memberMockupUrl } from './mockupLinks';

// -- TYPES -- //

export type ItemMockups = {
	list: {
		id: string;
		title: string;
		currentVersion: number;
		versions: number;
		hasShot: boolean;
		thumb: string | null;
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
		thumb: m.hasShot
			? memberMockupUrl({
					orgId: ctx.orgId,
					projectId: m.projectId,
					mockupId: m.id,
					version: m.currentVersion,
					kind: 'shot'
				})
			: null,
		updatedAt: m.updatedAt,
		publicLinkOn: m.publicLinkOn
	}));
	if (!withPreview || list.length === 0) return { list, open: null };
	const first = list[0];
	const [detail, grant, settings] = await Promise.all([
		getMockup(ctx, first.id),
		mockupFileGrant(ctx, first.id),
		getMockupSettings(ctx, projectKey)
	]);
	return {
		list,
		open: {
			id: first.id,
			version: first.currentVersion,
			src: memberMockupUrl(grant),
			screens: settings.screens,
			notes: detail.notes
				? { author: detail.notes.author, keep: detail.notes.keep, free: detail.notes.free }
				: null
		}
	};
}

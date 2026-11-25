// THE MOCKUPS OF ONE PLAN FOR ITS PAGE: A COUNT AND A LIST ON EVERY LOAD, AND THE PREVIEW AND BUILD NOTES ONLY WHEN THE MOCKUPS TAB IS OPEN

// IMPORTED TYPES
import type { MockupFidelity } from '../../board/mockups';
import type { Ctx } from '../ops/context';
// IMPORTED MODULES
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
		/** The tier of the current version, for the badge. */
		fidelity: MockupFidelity;
	}[];
	/** The newest mockup of the plan with its preview address and notes, only when the tab is open. */
	open: {
		id: string;
		/** The version on show: the one the address asked for, otherwise the newest. */
		version: number;
		src: string;
		screens: string[];
		notes: { author: string | null; keep: string; free: string } | null;
		/** Every version, newest first, for the History drawer. */
		versions: {
			number: number;
			size: number;
			createdAt: Date | string;
			restoredFrom: number | null;
			hasScreenshot: boolean;
			fidelity: MockupFidelity;
		}[];
		canWrite: boolean;
	} | null;
};

// -- FUNCTIONS -- //

export async function itemMockups(
	ctx: Ctx,
	projectKey: string,
	itemRef: string,
	withPreview: boolean,
	/** The mockup the address asked for (?m=). A wrong or foreign id shows the newest one. */
	chosen: string | null = null,
	/** The version the address asked for (?v=). A number the mockup does not have shows the newest. */
	chosenVersion: string | null = null
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
		publicLinkOn: m.publicLinkOn,
		fidelity: m.fidelity
	}));
	if (!withPreview || list.length === 0) return { list, open: null };
	// Only a mockup of this plan can be chosen: the id is looked up in the plan's own list
	const shown = list.find((m) => m.id === chosen) ?? list[0];
	const first = await getMockup(ctx, shown.id);
	const asked = Number(chosenVersion);
	const version =
		chosenVersion !== null &&
		Number.isInteger(asked) &&
		first.versions.some((v) => v.number === asked)
			? asked
			: shown.currentVersion;
	// The notes belong to the version on show, so an older version reads its own
	const [detail, grant] = await Promise.all([
		version === shown.currentVersion ? first : getMockup(ctx, shown.id, version),
		mockupFileGrant(ctx, shown.id, { version })
	]);
	return {
		list,
		open: {
			id: shown.id,
			version,
			src: memberMockupUrl(grant),
			screens: ALL_SCREENS,
			notes: detail.notes
				? { author: detail.notes.author, keep: detail.notes.keep, free: detail.notes.free }
				: null,
			versions: first.versions.map((v) => ({
				number: v.number,
				size: v.size,
				createdAt: v.createdAt,
				restoredFrom: v.restoredFrom,
				hasScreenshot: v.hasScreenshot,
				fidelity: v.fidelity
			})),
			canWrite: first.canWrite
		}
	};
}

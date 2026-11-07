// WHAT THE MOCKUP SETTINGS PAGE NEEDS: THE SAVED STYLE, DEVICES, PAGE EXAMPLES AND THE DETAILS OF COLOURS AND FONTS. NEVER THE KIT FILE

// -- TYPES -- //
import type { Ctx } from '../ops/context';
// -- MODULES -- //
import { getMockupSettings } from '../ops/mockupSettings';

// -- TYPES -- //

export type MockupSettingsPage = {
	style: { text: string; updatedBy: string | null; updatedAt: Date | string | null };
	screens: string[];
	themes: string[];
	examples: { id: string; name: string; prompt: string; updatedBy: string | null }[];
	kit: {
		number: number;
		builtFromCommit: string;
		builtAt: Date | string;
		summary: string;
		stale: boolean;
		builtBy: string | null;
	} | null;
	/** Admins and owners change the settings. Everyone else who can see the project reads them. */
	canManage: boolean;
};

// -- FUNCTIONS -- //

/** The settings the page shows, in the page's own plain names. Only metadata of the kit leaves the server. */
export async function mockupSettingsPage(
	ctx: Ctx,
	projectKey: string
): Promise<MockupSettingsPage> {
	const s = await getMockupSettings(ctx, projectKey);
	return {
		style: s.style,
		screens: s.screens,
		themes: s.themes,
		examples: s.templates.map((t) => ({
			id: t.id,
			name: t.name,
			prompt: t.prompt,
			updatedBy: t.updatedBy
		})),
		kit: s.kit
			? {
					number: s.kit.number,
					builtFromCommit: s.kit.builtFromCommit,
					builtAt: s.kit.builtAt,
					summary: s.kit.summary,
					stale: s.kit.stale,
					builtBy: s.kit.builtBy
				}
			: null,
		canManage: s.canManage
	};
}

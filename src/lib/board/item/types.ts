// THE SHAPE OF THE DATA THE ITEM PAGE AND ITS TABS SHARE

// -- TYPES -- //
import type { itemCore, itemExtras } from '#lib/server/ops/board.js';

type Core = Awaited<ReturnType<typeof itemCore>>;
type Extras = Awaited<ReturnType<typeof itemExtras>>;

/** What shows first: the plan, decisions and documents, with their Markdown already rendered to safe HTML. */
export type ItemView = Omit<Core, 'sections' | 'decisions'> & {
	sections: (Core['sections'][number] & { html: string })[];
	decisions: (Core['decisions'][number] & {
		contextHtml: string;
		decisionHtml: string;
		alternativesHtml: string;
		consequencesHtml: string;
	})[];
};

/** What can arrive after the first paint: discussion, files and recent activity. */
export type ItemExtras = Omit<Extras, 'comments'> & {
	comments: (Extras['comments'][number] & { html: string })[];
};

/** What every tab needs besides the data: who it is for, and how to tell the page that something was written. */
export type TabEnv = {
	org: string;
	canWrite: boolean;
	canComment: boolean;
	isOwner: boolean;
	/** Refetches the page's data after a write. */
	onchanged: () => Promise<void>;
};

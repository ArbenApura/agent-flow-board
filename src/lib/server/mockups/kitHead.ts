// THE PROJECT KIT'S HEAD AND HOW IT REACHES A MOCKUP: A MOCKUP CARRIES ONLY A MARKER, THE BOARD PUTS THE PROJECT'S STYLESHEET AND FONTS IN WHEN IT SERVES THE PAGE

// -- TYPES -- //
import type { Storage } from '../adapters/storage';
import type { Tx } from '../db/client';
import type { KitFacts } from './lint';
// -- DEP-MODULES -- //
import { desc, eq } from 'drizzle-orm';
// -- MODULES -- //
import { mockupKit, mockupKitAsset } from '../db/schema';
import { extractKitAssets } from './kitAssets';
import { kitFacts } from './lint';

// -- TYPES -- //

export type LoadedKit = {
	id: string;
	head: string | null;
	facts: KitFacts;
	externalAssets: boolean;
};

// -- CONSTANTS -- //

/** A mockup starts with this in its head. The board replaces it with the kit head when it serves the page. */
export const KIT_MARKER = '<!--afb-kit-->';
export const KIT_START = '<!--afb-kit:start-->';
export const KIT_END = '<!--afb-kit:end-->';
/** The kits that were read lately, by kit id. A kit file never changes, so an entry never goes stale. A small cache, cleared when it is full. */
const CACHE_LIMIT = 24;
const cache = new Map<string, { head: string | null; facts: KitFacts; externalAssets: boolean }>();

// -- FUNCTIONS -- //

/** The text between the kit's two head markers, or null when the kit has none. */
export function kitHeadOf(kitHtml: string): string | null {
	const start = kitHtml.indexOf(KIT_START);
	if (start === -1) return null;
	const from = start + KIT_START.length;
	const end = kitHtml.indexOf(KIT_END, from);
	return end === -1 ? null : kitHtml.slice(from, end);
}

/** True when a page asks for the kit's head. */
export const wantsKit = (html: string): boolean => html.includes(KIT_MARKER);

/** The page with the marker replaced by the kit head, or removed when there is no head. A page without the marker is returned as it is. */
export function injectKitHead(html: string, head: string | null): string {
	const at = html.indexOf(KIT_MARKER);
	if (at === -1) return html;
	// Only the first marker takes the head, so a stylesheet of several MB is never repeated; a later marker is removed
	const rest = html
		.slice(at + KIT_MARKER.length)
		.split(KIT_MARKER)
		.join('');
	return html.slice(0, at) + (head ?? '') + rest;
}

/** Forgets every kit read so far. For tests. */
export const clearKitCache = () => cache.clear();

/**
 * The project's newest kit: its head for serving and its facts for the check. Null when the project has no kit or its file is
 * missing. The file is read once per kit and kept in memory by the kit's id.
 */
export async function loadKit(
	tx: Tx,
	storage: Storage | null | undefined,
	projectId: string
): Promise<LoadedKit | null> {
	if (!storage) return null;
	const [row] = await tx
		.select({ id: mockupKit.id, key: mockupKit.storageKey })
		.from(mockupKit)
		.where(eq(mockupKit.projectId, projectId))
		.orderBy(desc(mockupKit.number))
		.limit(1);
	if (!row) return null;
	const hit = cache.get(row.id);
	if (hit) return { id: row.id, ...hit };
	const bytes = await storage.get(row.key);
	if (!bytes) return null;
	const text = new TextDecoder().decode(bytes);
	// The facts are read from the head alone, so a kit of several MB is not scanned twice on a cold load
	const rawHead = kitHeadOf(text);
	const assetRows = await tx
		.select({ id: mockupKitAsset.id })
		.from(mockupKitAsset)
		.where(eq(mockupKitAsset.kitId, row.id))
		.limit(1);
	let head = rawHead;
	let externalAssets = false;
	if (assetRows.length > 0 && rawHead) {
		const extracted = extractKitAssets(text);
		if (extracted.headTemplate && extracted.assets.length > 0) {
			head = extracted.headTemplate;
			externalAssets = true;
		}
	}
	const entry = { head, facts: kitFacts(rawHead ?? text), externalAssets };
	if (cache.size >= CACHE_LIMIT) cache.clear();
	cache.set(row.id, entry);
	return { id: row.id, ...entry };
}

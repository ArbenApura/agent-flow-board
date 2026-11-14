// SERVING MOCKUP FILES: A SIGNED LINK FOR MEMBERS, THE PUBLIC TOKEN, AND THE ISOLATING HEADERS ON EVERY ANSWER (AFB-20261107-0346)
// A mockup is HTML written by an agent, so it runs sandboxed: no cookies, no same origin, no network. Every response of both
// routes is built here in one try/catch, errors and 500s included, so no answer can leave without the headers.

// IMPORTED TYPES
import type { DbHandle } from '../db/client';
import type { Storage } from '../adapters/storage';
// IMPORTED DEP-MODULES
import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
// IMPORTED MODULES
import { ALL_SCREENS } from '../../board/mockups';
import { item, mockup, mockupKitAsset, mockupVersion, project, user } from '../db/schema';
import { withTenant } from '../db/tenant';
import { KIT_ASSET_NAME, hasAssetPlaceholders, materializeAssetPlaceholders } from './kitAssets';
import { injectKitHead, loadKit, wantsKit } from './kitHead';
import { PIN_SCRIPT, PUBLIC_SCRIPT } from './pinScript';

// -- TYPES -- //

export type MockupGrant = {
	orgId: string;
	projectId: string;
	mockupId: string;
	version: number;
	kind: 'html' | 'shot' | 'thumb';
};
export type KitAssetGrant = {
	orgId: string;
	projectId: string;
	kitId: string;
	name: string;
};
type Served = {
	status: number;
	body: string | Uint8Array;
	type: string;
	extra?: Record<string, string>;
	csp?: string;
};

// -- CONSTANTS -- //

export const MOCKUP_LINK_SECONDS = 300;
/** The header of every answer of the mockup routes. It forbids everything a page could use to reach out of its box. */
export const MOCKUP_CSP =
	"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'";
/** The header of a card's live preview. Same box as above, but no script runs at all, so a list of cards never executes a mockup. */
export const THUMB_CSP =
	"sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'";
/** Header applied to standalone kit asset files (CSS, fonts, images) so sandboxed frames can load them without running scripts. */
export const KIT_ASSET_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'";

/** Per-response CSP when a kit externalizes CSS/font files to the signed kit asset prefix on the same mockup origin. */
export function buildMockupCsp(isThumb: boolean, kitAssetPrefix?: string): string {
	if (!kitAssetPrefix) return isThumb ? THUMB_CSP : MOCKUP_CSP;
	const script = isThumb ? "script-src 'none'" : "script-src 'unsafe-inline'";
	const sandbox = isThumb ? 'sandbox' : 'sandbox allow-scripts';
	return `${sandbox}; default-src 'none'; ${script}; style-src 'unsafe-inline' ${kitAssetPrefix}; img-src data: ${kitAssetPrefix}; font-src data: ${kitAssetPrefix}; form-action 'none'; base-uri 'none'`;
}
/** A page larger than this is never drawn as a live preview. */
export const THUMB_MAX_BYTES = 2 * 1024 * 1024;
/** What a failed live preview answers: an empty, transparent page, so the placeholder under the frame stays visible. */
const EMPTY_THUMB_HTML =
	'<!doctype html><html><head><meta charset="utf-8"><style>html,body{background:transparent;margin:0}</style></head><body></body></html>';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNAVAILABLE_HTML =
	'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Link not available</title><style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:28rem;padding:1.5rem;text-align:center}</style></head><body><main><h1>This link is no longer available</h1><p>The person who shared it may have switched it off.</p></main></body></html>';

// -- FUNCTIONS -- //

/** The routes that read no session: a signed mockup file (/mf) and a public mockup link (/m). */
export const readsNoSession = (pathname: string) => /^\/(mf|m|n)\//.test(pathname);

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

/** Adds the pin script before the last closing body tag, or at the end when the page has none. */
export function injectPinScript(html: string): string {
	const at = html.toLowerCase().lastIndexOf('</body>');
	return at === -1 ? html + PIN_SCRIPT : html.slice(0, at) + PIN_SCRIPT + html.slice(at);
}

/** Adds the read only script of a public link, in the same place as the pin script. It carries the options and screens, never the pins. */
export function injectPublicScript(html: string): string {
	const at = html.toLowerCase().lastIndexOf('</body>');
	return at === -1 ? html + PUBLIC_SCRIPT : html.slice(0, at) + PUBLIC_SCRIPT + html.slice(at);
}

/** Every header the mockup routes send, on every answer. */
export function mockupHeaders(
	type: string,
	extra: Record<string, string> = {},
	csp: string = MOCKUP_CSP
): Record<string, string> {
	return {
		'content-type': type,
		'content-security-policy': csp,
		'referrer-policy': 'no-referrer',
		'x-content-type-options': 'nosniff',
		'x-robots-tag': 'noindex',
		'cache-control': 'no-store',
		...extra
	};
}

/** The whole answer, built here. A body sent as a string is text, bytes are an image. */
export function mockupResponse(s: Served): Response {
	return new Response(s.body as BodyInit, {
		status: s.status,
		headers: mockupHeaders(s.type, s.extra, s.csp)
	});
}

/** The answer to a failed live preview: nothing to see, and no script allowed. */
const emptyThumb = (): Served => ({
	status: 404,
	body: EMPTY_THUMB_HTML,
	type: 'text/html; charset=utf-8',
	csp: THUMB_CSP
});

const unavailable = (status: number, extra?: Record<string, string>, csp?: string): Served => ({
	status,
	body: UNAVAILABLE_HTML,
	type: 'text/html; charset=utf-8',
	extra,
	csp
});

// -- SIGNED LINKS FOR MEMBERS -- //

const payloadOf = (g: MockupGrant) =>
	`${g.orgId}.${g.projectId}.${g.mockupId}.${g.version}.${g.kind}`;
const MOCKUP_GRANT_SALT = Buffer.from('afb-mockup-grant-v1', 'utf8');
const deriveGrantKey = (secret: string, g: MockupGrant) =>
	Buffer.from(
		hkdfSync(
			'sha256',
			Buffer.from(secret, 'utf8'),
			MOCKUP_GRANT_SALT,
			Buffer.from(`${g.orgId}:${g.projectId}:${g.mockupId}:${g.version}:${g.kind}`, 'utf8'),
			32
		)
	);
const signature = (secret: string, g: MockupGrant, exp: number) =>
	createHmac('sha256', deriveGrantKey(secret, g))
		.update(`${payloadOf(g)}\n${exp}`)
		.digest('base64url');

/** The relative address of one mockup file that works for 5 minutes. */
export function signMockupGrant(
	secret: string,
	g: MockupGrant,
	now = Date.now(),
	ttl = MOCKUP_LINK_SECONDS
): string {
	const exp = Math.floor(now / 1000) + ttl;
	return `/mf/${g.orgId}/${g.projectId}/${g.mockupId}/${g.version}/${g.kind}?exp=${exp}&sig=${signature(secret, g, exp)}`;
}

export function verifyMockupGrant(
	secret: string,
	g: MockupGrant,
	exp: number,
	sig: string,
	now = Date.now()
): boolean {
	if (!Number.isFinite(exp) || !Number.isFinite(now) || exp * 1000 < now) return false;
	const want = Buffer.from(signature(secret, g, exp));
	const got = Buffer.from(sig);
	return want.length === got.length && timingSafeEqual(want, got);
}

const kitAssetKey = (secret: string, g: KitAssetGrant) =>
	Buffer.from(
		hkdfSync(
			'sha256',
			Buffer.from(secret, 'utf8'),
			MOCKUP_GRANT_SALT,
			Buffer.from(`${g.orgId}:${g.projectId}:kit:${g.kitId}:${g.name}`, 'utf8'),
			32
		)
	);
const kitAssetSig = (secret: string, g: KitAssetGrant, exp: number) =>
	createHmac('sha256', kitAssetKey(secret, g))
		.update(`${g.orgId}.${g.projectId}.${g.kitId}.${g.name}\n${exp}`)
		.digest('base64url');

/** Signed path for one stored kit asset file under /mf/kit/. */
export function signKitAssetGrant(
	secret: string,
	g: KitAssetGrant,
	now = Date.now(),
	ttl = MOCKUP_LINK_SECONDS
): string {
	const exp = Math.floor(now / 1000) + ttl;
	return `/mf/kit/${g.orgId}/${g.projectId}/${g.kitId}/${encodeURIComponent(g.name)}?exp=${exp}&sig=${kitAssetSig(secret, g, exp)}`;
}

/** Verifies a signed kit asset URL. */
export function verifyKitAssetGrant(
	secret: string,
	g: KitAssetGrant,
	exp: number,
	sig: string,
	now = Date.now()
): boolean {
	if (!Number.isFinite(exp) || !Number.isFinite(now) || exp * 1000 < now) return false;
	const want = Buffer.from(kitAssetSig(secret, g, exp));
	const got = Buffer.from(sig);
	return want.length === got.length && timingSafeEqual(want, got);
}

const parseGrant = (p: {
	org: string;
	project: string;
	mockup: string;
	version: string;
	kind: string;
}): MockupGrant | null => {
	const version = Number(p.version);
	if (![p.org, p.project, p.mockup].every((v) => UUID.test(v))) return null;
	if (!Number.isInteger(version) || version < 1) return null;
	if (p.kind !== 'html' && p.kind !== 'shot' && p.kind !== 'thumb') return null;
	return { orgId: p.org, projectId: p.project, mockupId: p.mockup, version, kind: p.kind };
};

type Deps = { handle: DbHandle; storage: Storage | null };

/**
 * The page with the project's newest kit head put where the marker is. A page without the marker costs nothing, and a project
 * with no kit has the marker removed. Externalized kit assets produce a per-response prefix for CSP.
 */
async function withKit(
	deps: Deps,
	orgId: string,
	projectId: string,
	html: string,
	materialize?: {
		urlFor: (kitId: string, assetName: string) => string;
		cspPrefixFor: (kitId: string) => string;
	}
): Promise<{ html: string; kitAssetPrefix?: string }> {
	if (!wantsKit(html)) return { html };
	// A kit that cannot be read serves the page without it, never an error page: the marker is simply removed
	const kit = await withTenant(deps.handle, { orgId, projectId }, (tx) =>
		loadKit(tx, deps.storage, projectId)
	).catch(() => null);
	if (!kit?.head) return { html: injectKitHead(html, null) };
	if (!hasAssetPlaceholders(kit.head) || !materialize) {
		return { html: injectKitHead(html, kit.head) };
	}
	const resolvedHead = materializeAssetPlaceholders(kit.head, (name) =>
		materialize.urlFor(kit.id, name)
	);
	return {
		html: injectKitHead(html, resolvedHead),
		kitAssetPrefix: materialize.cspPrefixFor(kit.id)
	};
}

/** One file for a valid signed link: the page with the pin script, or its screenshot. Anything else is the plain unavailable page. */
export async function serveMemberMockup(
	deps: Deps,
	secret: string,
	params: { org: string; project: string; mockup: string; version: string; kind: string },
	query: { exp: string | null; sig: string | null },
	now = Date.now(),
	requestOrigin?: string
): Promise<Response> {
	// A card's live preview answers an empty transparent page to every failure, so the placeholder under it stays visible
	const fail = (status: number) =>
		mockupResponse(params.kind === 'thumb' ? emptyThumb() : unavailable(status));
	try {
		const grant = parseGrant(params);
		if (
			!grant ||
			!deps.storage ||
			!verifyMockupGrant(secret, grant, Number(query.exp), query.sig ?? '', now)
		)
			return fail(404);
		const found = await withTenant(
			deps.handle,
			{ orgId: grant.orgId, projectId: grant.projectId },
			async (tx) => {
				const [row] = await tx
					.select({
						key: mockupVersion.storageKey,
						shot: mockupVersion.screenshotKey,
						size: mockupVersion.size,
						trashed: mockup.trashedAt
					})
					.from(mockupVersion)
					.innerJoin(mockup, eq(mockup.id, mockupVersion.mockupId))
					.where(
						and(eq(mockupVersion.mockupId, grant.mockupId), eq(mockupVersion.number, grant.version))
					);
				if (!row || row.trashed) return null;
				return { key: grant.kind === 'shot' ? row.shot : row.key, size: row.size };
			}
		);
		if (!found?.key) return fail(404);
		// The size was read with the row, so a page that is too big for a preview is refused before its file is read
		if (grant.kind === 'thumb' && found.size > THUMB_MAX_BYTES) return fail(404);
		const bytes = await deps.storage.get(found.key);
		if (!bytes) return fail(404);
		if (grant.kind === 'shot')
			return mockupResponse({ status: 200, body: bytes, type: 'image/png' });
		const rendered = await withKit(
			deps,
			grant.orgId,
			grant.projectId,
			new TextDecoder().decode(bytes),
			{
				urlFor: (kitId, name) =>
					signKitAssetGrant(
						secret,
						{ orgId: grant.orgId, projectId: grant.projectId, kitId, name },
						now
					),
				cspPrefixFor: (kitId) =>
					requestOrigin
						? `${requestOrigin}/mf/kit/${grant.orgId}/${grant.projectId}/${kitId}/`
						: `'self'`
			}
		);
		if (grant.kind === 'thumb')
			return mockupResponse({
				status: 200,
				body: rendered.html,
				type: 'text/html; charset=utf-8',
				csp: buildMockupCsp(true, rendered.kitAssetPrefix)
			});
		return mockupResponse({
			status: 200,
			body: injectPinScript(rendered.html),
			type: 'text/html; charset=utf-8',
			csp: buildMockupCsp(false, rendered.kitAssetPrefix)
		});
	} catch (e) {
		console.error('Mockup file failed', e instanceof Error ? e.message : e);
		return fail(500);
	}
}

// -- THE PUBLIC LINK -- //

export type PublicMockup = {
	orgId: string;
	projectId: string;
	mockupId: string;
	title: string;
	version: number;
	storageKey: string;
	screenshotKey: string | null;
	planRef: string | null;
	sharedBy: string;
	projectName: string;
	/** The widths the project draws mockups at. */
	screens: string[];
};

/**
 * Finds the mockup a public address names. A wrong address, a link that is off, a trashed mockup, a private plan and a plan in the
 * trash all give null, and the first lookup costs the same in each case. The address is never logged.
 */
export async function findPublicMockup(
	handle: DbHandle,
	token: string,
	version?: number
): Promise<PublicMockup | null> {
	if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) return null;
	const found = await withTenant(handle, { mockupTokenHash: sha256(token) }, async (tx) => {
		const [m] = await tx.select().from(mockup);
		return m ?? null;
	});
	if (!found) return null;
	return withTenant(handle, { orgId: found.orgId, projectId: found.projectId }, async (tx) => {
		if (found.itemId) {
			const [plan] = await tx
				.select({ visibility: item.visibility, deletedAt: item.deletedAt })
				.from(item)
				.where(eq(item.id, found.itemId));
			if (!plan || plan.visibility !== 'public' || plan.deletedAt) return null;
		}
		const [v] = await tx
			.select()
			.from(mockupVersion)
			.where(
				and(
					eq(mockupVersion.mockupId, found.id),
					eq(mockupVersion.number, version ?? found.currentVersion)
				)
			);
		if (!v) return null;
		const planRef = found.itemId
			? ((await tx.select({ ref: item.ref }).from(item).where(eq(item.id, found.itemId)))[0]?.ref ??
				null)
			: null;
		const [who] = v.createdBy
			? await tx.select({ name: user.name }).from(user).where(eq(user.id, v.createdBy))
			: [];
		const [proj] = await tx
			.select({ name: project.name })
			.from(project)
			.where(eq(project.id, found.projectId));
		return {
			orgId: found.orgId,
			projectId: found.projectId,
			mockupId: found.id,
			title: found.title,
			version: v.number,
			storageKey: v.storageKey,
			screenshotKey: v.screenshotKey,
			planRef,
			sharedBy: who?.name ?? 'Someone',
			projectName: proj?.name ?? '',
			screens: [...ALL_SCREENS]
		};
	});
}

/** The page of a public link, sandboxed, with the read only options script and without the pin script. The same plain page answers every kind of failure. */
export async function servePublicMockup(
	deps: Deps,
	token: string,
	version?: number,
	screenshot = false,
	requestOrigin?: string
): Promise<Response> {
	const referrer = { 'referrer-policy': 'no-referrer' };
	try {
		const found = deps.storage ? await findPublicMockup(deps.handle, token, version) : null;
		if (!found || !deps.storage) return mockupResponse(unavailable(404, referrer));
		const key = screenshot ? found.screenshotKey : found.storageKey;
		const bytes = key ? await deps.storage.get(key) : null;
		if (!bytes) return mockupResponse(unavailable(404, referrer));
		if (screenshot)
			return mockupResponse({ status: 200, body: bytes, type: 'image/png', extra: referrer });
		const rendered = await withKit(
			deps,
			found.orgId,
			found.projectId,
			new TextDecoder().decode(bytes),
			{
				urlFor: (_kitId, name) => `/m/${encodeURIComponent(token)}/kit/${encodeURIComponent(name)}`,
				cspPrefixFor: () =>
					requestOrigin ? `${requestOrigin}/m/${encodeURIComponent(token)}/kit/` : `'self'`
			}
		);
		return mockupResponse({
			status: 200,
			body: injectPublicScript(rendered.html),
			type: 'text/html; charset=utf-8',
			extra: referrer,
			csp: buildMockupCsp(false, rendered.kitAssetPrefix)
		});
	} catch (e) {
		console.error('Public mockup failed', e instanceof Error ? e.message : e);
		return mockupResponse(unavailable(500, referrer));
	}
}

const ASSET_HEADERS = {
	'access-control-allow-origin': '*',
	'cross-origin-resource-policy': 'cross-origin'
};

/** Serves one signed kit asset file (CSS or embedded font/image) with isolating headers and CORS for sandboxed iframes. */
export async function serveMemberKitAsset(
	deps: Deps,
	secret: string,
	params: { org: string; project: string; kit: string; name: string },
	query: { exp: string | null; sig: string | null },
	now = Date.now()
): Promise<Response> {
	const fail = (status: number) => mockupResponse(unavailable(status, undefined, KIT_ASSET_CSP));
	try {
		if (
			![params.org, params.project, params.kit].every((v) => UUID.test(v)) ||
			!KIT_ASSET_NAME.test(params.name) ||
			!deps.storage
		)
			return fail(404);
		const grant: KitAssetGrant = {
			orgId: params.org,
			projectId: params.project,
			kitId: params.kit,
			name: params.name
		};
		if (!verifyKitAssetGrant(secret, grant, Number(query.exp), query.sig ?? '', now))
			return fail(404);
		const row = await withTenant(
			deps.handle,
			{ orgId: grant.orgId, projectId: grant.projectId },
			async (tx) => {
				const [asset] = await tx
					.select({ key: mockupKitAsset.storageKey, mime: mockupKitAsset.mime })
					.from(mockupKitAsset)
					.where(and(eq(mockupKitAsset.kitId, grant.kitId), eq(mockupKitAsset.name, grant.name)));
				return asset ?? null;
			}
		);
		if (!row) return fail(404);
		const bytes = await deps.storage.get(row.key);
		if (!bytes) return fail(404);
		if (grant.name.toLowerCase().endsWith('.css')) {
			const css = materializeAssetPlaceholders(new TextDecoder().decode(bytes), (name) => {
				const signed = signKitAssetGrant(
					secret,
					{ orgId: grant.orgId, projectId: grant.projectId, kitId: grant.kitId, name },
					now
				);
				return `./${name}?${signed.split('?')[1] ?? ''}`;
			});
			return mockupResponse({
				status: 200,
				body: css,
				type: row.mime,
				extra: ASSET_HEADERS,
				csp: KIT_ASSET_CSP
			});
		}
		return mockupResponse({
			status: 200,
			body: bytes,
			type: row.mime,
			extra: ASSET_HEADERS,
			csp: KIT_ASSET_CSP
		});
	} catch (e) {
		console.error('Kit asset failed', e instanceof Error ? e.message : e);
		return fail(500);
	}
}

/** Serves one extracted kit asset file on a public mockup token, resolving asset URLs within the same public kit folder. */
export async function servePublicKitAsset(
	deps: Deps,
	token: string,
	name: string
): Promise<Response> {
	const referrer = { 'referrer-policy': 'no-referrer' };
	try {
		if (!KIT_ASSET_NAME.test(name) || !deps.storage)
			return mockupResponse(unavailable(404, referrer, KIT_ASSET_CSP));
		const found = await findPublicMockup(deps.handle, token);
		if (!found) return mockupResponse(unavailable(404, referrer, KIT_ASSET_CSP));
		const row = await withTenant(
			deps.handle,
			{ orgId: found.orgId, projectId: found.projectId },
			async (tx) => {
				const kit = await loadKit(tx, deps.storage, found.projectId);
				if (!kit) return null;
				const [asset] = await tx
					.select({ key: mockupKitAsset.storageKey, mime: mockupKitAsset.mime })
					.from(mockupKitAsset)
					.where(and(eq(mockupKitAsset.kitId, kit.id), eq(mockupKitAsset.name, name)));
				return asset ?? null;
			}
		);
		if (!row) return mockupResponse(unavailable(404, referrer, KIT_ASSET_CSP));
		const bytes = await deps.storage.get(row.key);
		if (!bytes) return mockupResponse(unavailable(404, referrer, KIT_ASSET_CSP));
		if (name.toLowerCase().endsWith('.css')) {
			const css = materializeAssetPlaceholders(
				new TextDecoder().decode(bytes),
				(assetName) => `./${encodeURIComponent(assetName)}`
			);
			return mockupResponse({
				status: 200,
				body: css,
				type: row.mime,
				extra: { ...referrer, ...ASSET_HEADERS },
				csp: KIT_ASSET_CSP
			});
		}
		return mockupResponse({
			status: 200,
			body: bytes,
			type: row.mime,
			extra: { ...referrer, ...ASSET_HEADERS },
			csp: KIT_ASSET_CSP
		});
	} catch (e) {
		console.error('Public kit asset failed', e instanceof Error ? e.message : e);
		return mockupResponse(unavailable(500, referrer, KIT_ASSET_CSP));
	}
}

// SERVING MOCKUP FILES: A SIGNED LINK FOR MEMBERS, THE PUBLIC TOKEN, AND THE ISOLATING HEADERS ON EVERY ANSWER (AFB-20261107-0346)
// A mockup is HTML written by an agent, so it runs sandboxed: no cookies, no same origin, no network. Every response of both
// routes is built here in one try/catch, errors and 500s included, so no answer can leave without the headers.

// -- TYPES -- //
import type { DbHandle } from '../db/client';
import type { Storage } from '../adapters/storage';
// -- DEP-MODULES -- //
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
// -- MODULES -- //
import { item, mockup, mockupProject, mockupVersion, project, user } from '../db/schema';
import { withTenant } from '../db/tenant';
import { injectKitHead, loadKit, wantsKit } from './kitHead';

// -- TYPES -- //

export type MockupGrant = {
	orgId: string;
	projectId: string;
	mockupId: string;
	version: number;
	kind: 'html' | 'shot' | 'thumb';
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
/** A page larger than this is never drawn as a live preview. */
export const THUMB_MAX_BYTES = 2 * 1024 * 1024;
/** What a failed live preview answers: an empty, transparent page, so the placeholder under the frame stays visible. */
const EMPTY_THUMB_HTML =
	'<!doctype html><html><head><meta charset="utf-8"><style>html,body{background:transparent;margin:0}</style></head><body></body></html>';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNAVAILABLE_HTML =
	'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Link not available</title><style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:28rem;padding:1.5rem;text-align:center}</style></head><body><main><h1>This link is no longer available</h1><p>The person who shared it may have switched it off.</p></main></body></html>';

/**
 * The script added to a member's view of a mockup. It does two things only: it reports a click as a type and two numbers
 * (percent of the page, so a pin lands in the same place at any width) plus a short element hint, and it draws the numbered
 * pins the board hands it. It never reads or sends anything else, and it only listens to its own parent window.
 */
const PIN_SCRIPT = `<script>(function(){var on=false,pins=[],layer=null;function size(){var d=document.documentElement;return{w:Math.max(d.scrollWidth,innerWidth,1),h:Math.max(d.scrollHeight,innerHeight,1)}}function draw(){if(!layer){layer=document.createElement('div');layer.style.cssText='position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';document.body.appendChild(layer)}layer.textContent='';var s=size();pins.forEach(function(p,i){var m=document.createElement('div');m.textContent=String(i+1);m.style.cssText='position:absolute;left:'+(p.x/100*s.w)+'px;top:'+(p.y/100*s.h)+'px;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:CanvasText;color:Canvas;font:600 12px/22px system-ui,sans-serif;text-align:center;box-shadow:0 0 0 2px Canvas';layer.appendChild(m)})}function hint(el){if(!el||!el.tagName)return'';var t=el.tagName.toLowerCase();if(el.id)t+='#'+String(el.id).slice(0,40);var c=typeof el.className==='string'?el.className.trim().split(/\\s+/)[0]:'';if(c)t+='.'+c.slice(0,40);var x=(el.textContent||'').trim().replace(/\\s+/g,' ').slice(0,40);return(t+(x?' "'+x+'"':'')).slice(0,120)}addEventListener('message',function(e){if(e.source!==parent)return;var d=e.data;if(!d||typeof d!=='object')return;if(d.type==='afb-pin-mode'){on=d.on===true;document.documentElement.style.cursor=on?'crosshair':''}else if(d.type==='afb-pins'&&Array.isArray(d.pins)){pins=d.pins.slice(0,200).filter(function(p){return p&&typeof p.x==='number'&&typeof p.y==='number'&&isFinite(p.x)&&isFinite(p.y)}).map(function(p){return{x:Math.min(100,Math.max(0,p.x)),y:Math.min(100,Math.max(0,p.y))}});draw()}});document.addEventListener('click',function(e){if(!on)return;e.preventDefault();e.stopPropagation();var s=size();parent.postMessage({type:'afb-mockup-pin',x:Math.min(100,Math.max(0,Math.round(e.pageX/s.w*10000)/100)),y:Math.min(100,Math.max(0,Math.round(e.pageY/s.h*10000)/100)),hint:hint(e.target)},'*')},true);addEventListener('resize',draw);addEventListener('load',function(){parent.postMessage({type:'afb-mockup-ready'},'*')})})()</script>`;

// -- FUNCTIONS -- //

/** The routes that read no session: a signed mockup file (/mf) and a public mockup link (/m). */
export const readsNoSession = (pathname: string) => /^\/(mf|m)\//.test(pathname);

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

/** Adds the pin script before the last closing body tag, or at the end when the page has none. */
export function injectPinScript(html: string): string {
	const at = html.toLowerCase().lastIndexOf('</body>');
	return at === -1 ? html + PIN_SCRIPT : html.slice(0, at) + PIN_SCRIPT + html.slice(at);
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

const unavailable = (status: number, extra?: Record<string, string>): Served => ({
	status,
	body: UNAVAILABLE_HTML,
	type: 'text/html; charset=utf-8',
	extra
});

// -- SIGNED LINKS FOR MEMBERS -- //

const payloadOf = (g: MockupGrant) =>
	`${g.orgId}.${g.projectId}.${g.mockupId}.${g.version}.${g.kind}`;
const signature = (secret: string, g: MockupGrant, exp: number) =>
	createHmac('sha256', secret)
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
	if (!Number.isFinite(exp) || exp * 1000 < now) return false;
	const want = Buffer.from(signature(secret, g, exp));
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
 * with no kit has the marker removed.
 */
async function withKit(
	deps: Deps,
	orgId: string,
	projectId: string,
	html: string
): Promise<string> {
	if (!wantsKit(html)) return html;
	// A kit that cannot be read serves the page without it, never an error page: the marker is simply removed
	const kit = await withTenant(deps.handle, { orgId, projectId }, (tx) =>
		loadKit(tx, deps.storage, projectId)
	).catch(() => null);
	return injectKitHead(html, kit?.head ?? null);
}

/** One file for a valid signed link: the page with the pin script, or its screenshot. Anything else is the plain unavailable page. */
export async function serveMemberMockup(
	deps: Deps,
	secret: string,
	params: { org: string; project: string; mockup: string; version: string; kind: string },
	query: { exp: string | null; sig: string | null },
	now = Date.now()
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
		const page = await withKit(deps, grant.orgId, grant.projectId, new TextDecoder().decode(bytes));
		if (grant.kind === 'thumb')
			return mockupResponse({
				status: 200,
				body: page,
				type: 'text/html; charset=utf-8',
				csp: THUMB_CSP
			});
		return mockupResponse({
			status: 200,
			body: injectPinScript(page),
			type: 'text/html; charset=utf-8'
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
		const [settings] = await tx
			.select({ screens: mockupProject.screens })
			.from(mockupProject)
			.where(eq(mockupProject.projectId, found.projectId));
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
			screens: settings?.screens ?? ['wide', 'laptop', 'tablet', 'phone']
		};
	});
}

/** The page of a public link, sandboxed and without the pin script. The same plain page answers every kind of failure. */
export async function servePublicMockup(
	deps: Deps,
	token: string,
	version?: number,
	screenshot = false
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
		return mockupResponse({
			status: 200,
			body: await withKit(deps, found.orgId, found.projectId, new TextDecoder().decode(bytes)),
			type: 'text/html; charset=utf-8',
			extra: referrer
		});
	} catch (e) {
		console.error('Public mockup failed', e instanceof Error ? e.message : e);
		return mockupResponse(unavailable(500, referrer));
	}
}

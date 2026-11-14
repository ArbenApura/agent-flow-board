// APP DOM INSPECTION TARGET RESOLUTION (STEP B.5, AFB-20261113-1008)
// Opens a registered app target (dev registration or site URL, with optional saved --profile sign-in),
// drives screen/state/width, waits until settled, and returns the exact same InspectDump format as mockup inspect.

// IMPORTED MODULES
import { ensureDevServer } from './devServer.js';
import { inspectUrl, type InspectUrlResult } from './inspect.js';
import { liveSiteGuardOptions } from './live.js';
import type { ElementPairSpec, StateDriver } from './pairing.js';
import { configFor, listRegistrations, verifyDevConfigApproval } from './registry.js';
import { newLocalRunId, RunScope } from './scope.js';
import { stateNeedles } from './signin.js';
import { chooseSignin, sealedKey } from './signinChoice.js';

// -- TYPES -- //

export type InspectRegistrationOptions = {
	org: string;
	registration: string;
	profile?: string;
	routePath?: string;
	screen?: string;
	state?: string;
	width?: number;
	height?: number;
	driver?: StateDriver;
	pairs?: ElementPairSpec[];
	captureScreenshot?: boolean;
	headed?: boolean;
	log?: (line: string) => void;
};

// -- FUNCTIONS -- //

/**
 * Resolves a registration (devUrl or site URL, plus optional saved sign-in profile),
 * runs `inspectUrl` against it cleanly in a scoped context, and returns the DOM dump (+ optional screenshot).
 */
export async function inspectAppRegistration(
	opts: InspectRegistrationOptions
): Promise<InspectUrlResult> {
	const log = opts.log ?? (() => undefined);
	const all = listRegistrations(opts.org);
	const reg = all.find((r) => r.name.toLowerCase() === opts.registration.toLowerCase());
	if (!reg) {
		const list = all.map((r) => r.name).join(', ') || 'none';
		throw new Error(
			`There is no registration ${opts.registration.slice(0, 40)} in ${opts.org}. Registrations of ${opts.org}: ${list}.`
		);
	}
	const cfg = configFor(reg);
	const isDev = Boolean(cfg.devUrl);
	if (isDev) verifyDevConfigApproval(reg);
	const scope = new RunScope(newLocalRunId(), log);
	scope.start();
	try {
		let baseOrigin: string;
		if (isDev) {
			const dev = await ensureDevServer(reg, scope, { cwd: cfg.repo || process.cwd(), log });
			baseOrigin = dev.origin;
		} else if (cfg.url) {
			baseOrigin = cfg.url;
		} else {
			throw new Error(
				`Registration "${reg.name}" needs --dev-url or --url to run DOM inspection directly.`
			);
		}
		const expectedOrigin = new URL(baseOrigin).origin;
		let targetUrl = baseOrigin;
		if (opts.routePath) {
			if (
				!opts.routePath.startsWith('/') ||
				opts.routePath.startsWith('//') ||
				opts.routePath.includes('\\')
			) {
				throw new Error(
					`Refused unsafe route path "${opts.routePath}": use a single-origin relative path starting with "/".`
				);
			}
			const parsedTarget = new URL(opts.routePath, expectedOrigin);
			if (parsedTarget.origin !== expectedOrigin) {
				throw new Error(
					`Refused off-origin route path "${opts.routePath}" (resolved to "${parsedTarget.origin}").`
				);
			}
			targetUrl = parsedTarget.toString();
		}

		const extraHosts = cfg.url ? liveSiteGuardOptions(cfg).extraHosts : (cfg.extraHosts ?? []);
		const profileName =
			opts.driver?.mode === 'profile' ? (opts.driver.profile ?? opts.profile) : opts.profile;
		let storageState: unknown = undefined;
		if (profileName || !isDev) {
			const signin = chooseSignin({
				org: opts.org,
				registration: reg,
				scriptRegistration: reg.name,
				profile: profileName,
				named: Boolean(profileName),
				previewBaseUrl: expectedOrigin,
				sealedHost: sealedKey(extraHosts),
				throwawayDatabase: false
			});
			if (signin.failure) throw new Error(signin.failure);
			storageState = signin.state ?? undefined;
		}

		return await inspectUrl({
			url: targetUrl,
			expectedOrigin,
			target: 'app',
			screen: opts.screen,
			state: opts.state,
			width: opts.width,
			height: opts.height,
			driver: opts.driver,
			pairs: opts.pairs,
			storageState,
			isDev,
			dedicated: !isDev && Boolean(cfg.url),
			allowWrites: Boolean(cfg.allowWrites),
			writeAllowlist: cfg.writeAllowlist,
			extraHosts,
			needles: stateNeedles(storageState),
			captureScreenshot: opts.captureScreenshot,
			headed: opts.headed
		});
	} finally {
		await scope.close();
	}
}

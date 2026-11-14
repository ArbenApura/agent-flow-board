// CHECK COMPARE: RUNS MOCKUP AND APP AT MATCHING SCREENS, STATES AND WIDTHS IN TWO ISOLATED CONTEXTS (STEP B.6, AFB-20261113-1008)
// Captures picture pairs per (screen, state, width), dumps DOM measurements for both, applies structured Free rules (from design-brief)
// and per-plan overrides (with reason), evaluates tight pixel/colour/font tolerances via pairing.ts, and returns a ranked diff + saved evidence.

// -- DEP-MODULES -- //
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
// -- TYPES -- //
import type { Fetch } from '../device.js';
import type { CheckJob, RunReport } from './board.js';
import type { CompareResult, MismatchEntry, PairingManifest, StateDriver } from './pairing.js';
import type { ProjectConfig, Registration } from './types.js';
// -- MODULES -- //
import { BoardError, RunnerBoard } from './board.js';
import { slotsHeader } from './broker.js';
import { ensureBrowser } from './browser.js';
import { ensureDevServer } from './devServer.js';
import { JPEG_MAGIC, MAX_SHOT_BYTES, readPlainFile } from './evidence.js';
import { inspectUrl } from './inspect.js';
import { liveSiteGuardOptions } from './live.js';
import { LocalSink, type BoardLike } from './localSink.js';
import { pictureUploadAllowed } from './login.js';
import { parseMockupRef, resolveMockupTarget } from './mockupTarget.js';
import { compareInspections, parseFreeRulesFromBrief } from './pairing.js';
import { ORG_SLUG, assertName, runsDir } from './paths.js';
import { startPreview } from './preview.js';
import { redact } from './redact.js';
import { configFor, listRegistrations, verifyDevConfigApproval } from './registry.js';
import { auditHeaders, registrationsHeaderFor, requestRunOnBoard } from './run.js';
import { newLocalRunId, RunScope } from './scope.js';
import { signInWithPassword, stateNeedles } from './signin.js';
import { chooseSignin, sealedKey } from './signinChoice.js';
import { sanitiseReport, withBranch } from './wire.js';

// -- TYPES -- //

export type CompareScreenSpec = {
	name: string;
	screen?: string;
	path?: string;
};

export type CompareOptions = {
	mode?: 'board' | 'local';
	server: string;
	org: string;
	mockup: string;
	registration?: string;
	/** Direct app URL override (for unit tests without a saved registration). */
	appUrl?: string;
	profile?: string;
	screens?: CompareScreenSpec[];
	states?: string[];
	widths?: number[];
	manifest?: PairingManifest;
	briefText?: string;
	dir: string;
	item?: string;
	key?: string;
	step?: string;
	runId?: string;
	runnerToken: string;
	personalToken: string | null;
	fetch: Fetch;
	log: (line: string) => void;
	headed?: boolean;
};

export type ComparePairRecord = {
	screen: string;
	state: string;
	width: number;
	mockupShot: string | null;
	appShot: string | null;
	mockupHash: string | null;
	appHash: string | null;
	diff: CompareResult;
	rankedLines: string[];
};

export type CompareReportOutput = {
	schema: 1;
	passed: boolean;
	mockupId: string;
	mockupVersion: number;
	screenCount: number;
	pairCount: number;
	totalMismatches: number;
	totalNotCompared: number;
	totalWaived: number;
	signedInPicturesWithheld: boolean;
	pairs: ComparePairRecord[];
	summary: string;
};

export type CompareOutcome = {
	exitCode: 0 | 1 | 2;
	runId: string | null;
	resultPath: string | null;
	report: CompareReportOutput | null;
	message: string;
};

// -- CONSTANTS -- //

const MAX_EVIDENCE_PAIRS = 4;
const MAX_RANKED_LINES = 12;
const MAX_COMPARE_CELLS = 24;
const BEAT_EVERY_MS = 30_000;

// -- FUNCTIONS -- //

const safeSlug = (v: string) => {
	const cleaned =
		(v || 'default')
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'default';
	if (cleaned.length <= 24) return cleaned;
	const suffix = createHash('sha256').update(v).digest('hex').slice(0, 6);
	return `${cleaned.slice(0, 24)}-${suffix}`;
};

const sha256Hex = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Formats the top ranked mismatches and any notCompared reasons as concise plain lines. */
export function formatRankedMismatches(diff: CompareResult, limit = MAX_RANKED_LINES): string[] {
	const lines: string[] = [];
	const sevLabel = (s: MismatchEntry['severity']) => s.toUpperCase();
	for (const m of diff.mismatches.slice(0, limit)) {
		const deltaNote = m.delta !== undefined ? ` (delta=${m.delta}, max=${m.tolerance ?? 0})` : '';
		lines.push(
			`[${sevLabel(m.severity)}] ${m.ref} (${m.appSelector}) ${m.property}: mockup=${JSON.stringify(m.mockupValue)} app=${JSON.stringify(m.appValue)}${deltaNote}`
		);
	}
	if (diff.mismatches.length > limit) {
		lines.push(`... and ${diff.mismatches.length - limit} more mismatch(es).`);
	}
	for (const nc of diff.notCompared) {
		lines.push(`[NOT-COMPARED] ${nc.ref} (${nc.reason}): ${nc.detail}`);
	}
	return lines;
}

/** Merges design-brief `Free:` exemptions and manifest rules, checking every override has an explicit reason. */
export function buildEffectiveManifest(
	manifest: PairingManifest | undefined,
	briefText: string | undefined
): PairingManifest {
	const base: PairingManifest = manifest ? { ...manifest } : { pairs: [] };
	for (const ov of base.overrides ?? []) {
		if (!ov.reason?.trim()) {
			throw new Error(
				`Compare override for "${ov.ref}" property "${ov.property}" is missing a reason.`
			);
		}
	}
	const briefFree = briefText ? parseFreeRulesFromBrief(briefText) : [];
	const mergedFree = [...(base.free ?? []), ...briefFree];
	for (const fr of mergedFree) {
		if (!fr.reason?.trim()) {
			throw new Error(`Free exemption for "${fr.ref}" property "${fr.property}" needs a reason.`);
		}
	}
	return {
		...base,
		free: mergedFree
	};
}

/** Executes `check compare` end-to-end across two strictly isolated browser contexts. */
export async function runCompare(o: CompareOptions): Promise<CompareOutcome> {
	const local = o.mode !== 'board';
	const stop = (message: string, runId: string | null = null): CompareOutcome => ({
		exitCode: 2,
		runId,
		resultPath: null,
		report: null,
		message
	});

	let runId: string | null = null;
	let board: BoardLike | null = null;
	let scope: RunScope | null = null;
	let beatTimer: ReturnType<typeof setInterval> | undefined;
	let claimed = false;
	let finished = false;
	const needlesAll: string[] = [];
	const reasonFor = (t: string) => redact(t, needlesAll).slice(0, 1900);

	try {
		if (!ORG_SLUG.test(o.org))
			return stop('--org takes an organisation slug: lowercase letters, digits and dashes.');
		const mockupRef = parseMockupRef(o.mockup);
		if (!local) {
			if (!o.item || !o.key)
				return stop('Board compare needs --item <ref> and --key <check> (or pass --local).');
			assertName(o.item, 'item reference');
			assertName(o.key, 'check key');
		}
		if (!o.registration && !o.appUrl)
			return stop('Say which app target to compare against (--registration NAME).');

		let preRegistration: Registration | null = null;
		let preCfg: ProjectConfig | null = null;
		if (o.registration) {
			const all = listRegistrations(o.org);
			preRegistration =
				all.find((r) => r.name.toLowerCase() === o.registration!.toLowerCase()) ?? null;
			if (!preRegistration) {
				const names = all.map((r) => r.name).join(', ') || 'none';
				return stop(
					`There is no registration ${o.registration.slice(0, 40)} in ${o.org}. Available: ${names}.`
				);
			}
			preCfg = configFor(preRegistration);
		}
		const requestTarget: 'dev' | 'preview' | 'deployed' = preCfg?.devUrl
			? 'dev'
			: preCfg?.url
				? 'deployed'
				: 'preview';

		const effectiveManifest = buildEffectiveManifest(o.manifest, o.briefText);

		board = local
			? new LocalSink()
			: new RunnerBoard(o.server, o.runnerToken, o.fetch, () => ({
					'x-afb-tool-slots': slotsHeader(),
					...auditHeaders(),
					...registrationsHeaderFor(o.org)
				}));
		if (local) {
			runId = newLocalRunId();
		} else {
			runId =
				o.runId ??
				(await requestRunOnBoard({
					server: o.server,
					org: o.org,
					item: o.item!,
					key: o.key!,
					target: requestTarget,
					step: o.step,
					personalToken: o.personalToken,
					fetch: o.fetch
				}));
			const job: CheckJob | null = await board.claim(runId);
			if (!job) return stop(`The board did not give this machine the run ${runId}.`, runId);
			claimed = true;
			beatTimer = setInterval(() => {
				if (board && runId && claimed && !finished) {
					void board.beat(runId).catch(() => undefined);
				}
			}, BEAT_EVERY_MS);
			beatTimer.unref?.();
		}

		scope = new RunScope(runId, o.log);
		scope.start();
		await ensureBrowser(o.log);

		// Context 1 metadata: isolated signed mockup URL (NEVER receives sign-in cookies/storageState).
		const minted = await resolveMockupTarget({
			server: o.server,
			org: o.org,
			ref: mockupRef,
			runnerToken: !local && o.runnerToken ? o.runnerToken : undefined,
			personalToken: o.personalToken,
			fetch: o.fetch,
			log: o.log
		});

		// Context 2 metadata: resolve app registration (devUrl / url / preview) and optional sealed sign-in.
		let registration: Registration | null = null;
		let cfg: ProjectConfig | null = null;
		let appBaseOrigin = o.appUrl ?? '';
		let isDev = false;
		let commit: string | null = null;
		let diffHash: string | null = null;
		let testUser: { email: string; password: string } | null = null;
		let throwawayDatabase = false;
		let extraHosts: string[] = [];

		if (o.registration) {
			const all = listRegistrations(o.org);
			registration =
				all.find((r) => r.name.toLowerCase() === o.registration!.toLowerCase()) ?? null;
			if (!registration) {
				const names = all.map((r) => r.name).join(', ') || 'none';
				return stop(
					`There is no registration ${o.registration.slice(0, 40)} in ${o.org}. Available: ${names}.`,
					runId
				);
			}
			cfg = configFor(registration);
			isDev = Boolean(cfg.devUrl);
			if (isDev) {
				verifyDevConfigApproval(registration);
				const dev = await ensureDevServer(registration, scope, {
					cwd: cfg.repo || o.dir,
					log: o.log
				});
				appBaseOrigin = dev.origin;
				o.log(
					dev.owned
						? `Compare app target: started dev server at ${dev.origin}.`
						: `Compare app target: reusing dev server at ${dev.origin}.`
				);
			} else if (cfg.url) {
				appBaseOrigin = cfg.url;
				extraHosts = liveSiteGuardOptions(cfg).extraHosts;
			} else {
				const preview = await startPreview(cfg, {
					runId,
					scope,
					log: o.log,
					needles: needlesAll
				});
				appBaseOrigin = preview.baseUrl;
				commit = preview.commit;
				diffHash = preview.diffHash;
				testUser = preview.testUser;
				throwawayDatabase = Boolean(preview.throwawayDatabase);
				extraHosts = preview.extraHosts ?? [];
				needlesAll.push(...preview.secrets);
			}
		}

		let storageState: unknown = null;
		let usedSavedSignIn = false;
		if (registration) {
			const signin = chooseSignin({
				org: o.org,
				registration,
				scriptRegistration: registration.name,
				profile: o.profile,
				named: Boolean(o.profile),
				previewBaseUrl: appBaseOrigin,
				sealedHost: sealedKey(extraHosts),
				throwawayDatabase
			});
			if (signin.failure) throw new Error(signin.failure);
			storageState = signin.state;
			usedSavedSignIn = storageState !== null;
		}
		if (!storageState && testUser) {
			storageState = await signInWithPassword(appBaseOrigin, testUser);
		}
		const needles = [
			...needlesAll,
			...(testUser ? [testUser.password, testUser.email] : []),
			...stateNeedles(storageState)
		];
		for (const n of needles) {
			if (!needlesAll.includes(n)) needlesAll.push(n);
		}

		const screens: CompareScreenSpec[] = o.screens?.length
			? o.screens
			: [{ name: 'default', screen: '', path: '/' }];
		const states = o.states?.length ? o.states : ['default'];
		const widths = o.widths?.length ? o.widths : [1280];
		const totalCells = screens.length * states.length * widths.length;
		if (totalCells > MAX_COMPARE_CELLS) {
			throw new Error(
				`Compare matrix (${totalCells} cells) exceeds the limit of ${MAX_COMPARE_CELLS} screen/state/width pairs per run.`
			);
		}
		const appExpectedOrigin = new URL(appBaseOrigin).origin;
		const isLiveSite = !isDev && Boolean(cfg?.url);
		const profileStates = new Map<string, { state: unknown; usedSaved: boolean }>();

		const runDir = join(runsDir(), runId);
		const shotsDir = join(runDir, 'shots');
		mkdirSync(shotsDir, { recursive: true });

		const pairRecords: ComparePairRecord[] = [];
		let totalMismatches = 0;
		let totalNotCompared = 0;
		let totalWaived = 0;
		let allPassed = true;

		for (const scr of screens) {
			const screenName = scr.screen ?? (scr.name === 'default' ? '' : scr.name);
			let appEntryUrl = appBaseOrigin;
			if (scr.path) {
				if (!scr.path.startsWith('/') || scr.path.startsWith('//') || scr.path.includes('\\')) {
					throw new Error(
						`Refused unsafe screen path "${scr.path}": use a single-origin relative path starting with "/".`
					);
				}
				const parsedEntry = new URL(scr.path, appExpectedOrigin);
				if (parsedEntry.origin !== appExpectedOrigin) {
					throw new Error(
						`Refused off-origin screen path "${scr.path}" (resolved to "${parsedEntry.origin}").`
					);
				}
				appEntryUrl = parsedEntry.toString();
			}

			for (const state of states) {
				const driver: StateDriver | undefined =
					effectiveManifest.stateDrivers?.find((d) => d.state === state) ??
					(state ? { state, mode: 'query' } : undefined);

				let stateStorage = storageState;
				if (driver?.mode === 'profile') {
					const profName = driver.profile ?? o.profile;
					if (registration && profName) {
						let cached = profileStates.get(profName);
						if (!cached) {
							const s = chooseSignin({
								org: o.org,
								registration,
								scriptRegistration: registration.name,
								profile: profName,
								named: true,
								previewBaseUrl: appExpectedOrigin,
								sealedHost: sealedKey(extraHosts),
								throwawayDatabase: false
							});
							if (s.failure) throw new Error(s.failure);
							cached = { state: s.state, usedSaved: s.state !== null };
							profileStates.set(profName, cached);
							if (cached.usedSaved) usedSavedSignIn = true;
							for (const n of stateNeedles(cached.state)) {
								if (!needles.includes(n)) needles.push(n);
								if (!needlesAll.includes(n)) needlesAll.push(n);
							}
						}
						stateStorage = cached.state;
					}
				}

				for (const width of widths) {
					const slug = `${safeSlug(scr.name)}-${safeSlug(state)}-${width}px`;
					const mockupRes = await inspectUrl({
						url: minted.url,
						expectedOrigin: minted.origin,
						target: 'mockup',
						screen: screenName,
						state,
						width,
						pairs: effectiveManifest.pairs,
						driver,
						captureScreenshot: true,
						headed: o.headed
					});
					const appRes = await inspectUrl({
						url: appEntryUrl,
						expectedOrigin: appExpectedOrigin,
						target: 'app',
						screen: screenName,
						state,
						width,
						pairs: effectiveManifest.pairs,
						driver,
						storageState: stateStorage ?? undefined,
						isDev,
						dedicated: isLiveSite,
						allowWrites: Boolean(cfg?.allowWrites),
						writeAllowlist: cfg?.writeAllowlist,
						extraHosts,
						needles,
						captureScreenshot: true,
						headed: o.headed
					});

					const cellManual = mockupRes.manualRequired || appRes.manualRequired;
					if (!cellManual && (!mockupRes.screenshot || !appRes.screenshot)) {
						throw new Error(
							`Missing picture pair for screen="${scr.name}" state="${state}" width=${width}. Both mockup and app pictures are required.`
						);
					}

					const mockupFile = mockupRes.screenshot ? `mockup-${slug}.jpg` : null;
					const appFile = appRes.screenshot ? `app-${slug}.jpg` : null;
					if (mockupRes.screenshot && mockupFile) {
						writeFileSync(join(shotsDir, mockupFile), mockupRes.screenshot);
					}
					if (appRes.screenshot && appFile) {
						writeFileSync(join(shotsDir, appFile), appRes.screenshot);
					}

					const diff = cellManual
						? {
								screen: scr.name,
								state,
								width,
								passed: false,
								comparedCount: 0,
								matchedCount: 0,
								mismatches: [],
								waived: [],
								notCompared: [
									{
										ref: '*',
										reason: 'manual-state-required' as const,
										detail: driver?.instructions ?? `State "${state}" requires manual verification.`
									}
								],
								summary: 'manual state skipped'
							}
						: compareInspections(mockupRes.dump, appRes.dump, effectiveManifest);
					const rankedLines = formatRankedMismatches(diff);
					totalMismatches += diff.mismatches.length;
					totalNotCompared += diff.notCompared.length;
					totalWaived += diff.waived.length;
					if (!diff.passed) allPassed = false;

					pairRecords.push({
						screen: scr.name,
						state,
						width,
						mockupShot: mockupFile,
						appShot: appFile,
						mockupHash: mockupRes.screenshot ? sha256Hex(mockupRes.screenshot) : null,
						appHash: appRes.screenshot ? sha256Hex(appRes.screenshot) : null,
						diff,
						rankedLines
					});
				}
			}
		}

		const uploadPictures = pictureUploadAllowed(
			registration ?? { uploadSignedInPictures: false },
			usedSavedSignIn
		);
		const withheld = usedSavedSignIn && !uploadPictures;

		const summaryText = `${pairRecords.length} pair(s), ${totalMismatches} mismatch(es), ${totalNotCompared} notCompared, ${totalWaived} waived`;
		const compareReport: CompareReportOutput = {
			schema: 1,
			passed: allPassed && pairRecords.length > 0,
			mockupId: minted.mockupId,
			mockupVersion: minted.version,
			screenCount: screens.length,
			pairCount: pairRecords.length,
			totalMismatches,
			totalNotCompared,
			totalWaived,
			signedInPicturesWithheld: withheld,
			pairs: pairRecords,
			summary: summaryText
		};

		const reportPath = join(runDir, 'compare-result.json');
		writeFileSync(reportPath, JSON.stringify(compareReport, null, 2));

		const evidenceIds: string[] = [];
		if (!local && board && runId) {
			if (withheld) {
				o.log(
					'Signed-in app compare pictures and raw DOM text are withheld because uploadSignedInPictures is off (storing hashes and counts only).'
				);
				const redactedCounts = {
					schema: 1,
					signedIn: usedSavedSignIn,
					signedInPicturesWithheld: true,
					mockupId: minted.mockupId,
					mockupVersion: minted.version,
					diffHash: diffHash ?? null,
					passed: compareReport.passed,
					pairCount: compareReport.pairCount,
					totalMismatches,
					totalNotCompared,
					totalWaived,
					pairs: pairRecords.map((p) => ({
						screen: p.screen,
						state: p.state,
						width: p.width,
						passed: p.diff.passed,
						comparedCount: p.diff.comparedCount,
						mismatchCount: p.diff.mismatches.length,
						notComparedCount: p.diff.notCompared.length,
						mockupHash: p.mockupHash,
						appHash: p.appHash
					}))
				};
				evidenceIds.push(
					await board.upload(runId, {
						filename: 'compare-summary.json',
						caption: `Compare summary (${summaryText})`.slice(0, 120),
						bytes: Buffer.from(JSON.stringify(redactedCounts, null, 2), 'utf8'),
						signedIn: usedSavedSignIn,
						uploadSignedInPictures: uploadPictures
					})
				);
			} else {
				const pairsToUpload = pairRecords
					.filter((p) => p.mockupShot !== null && p.appShot !== null)
					.slice(0, MAX_EVIDENCE_PAIRS);
				for (const p of pairsToUpload) {
					if (!p.mockupShot || !p.appShot) continue;
					const mRead = readPlainFile(shotsDir, p.mockupShot, {
						maxBytes: MAX_SHOT_BYTES,
						magic: JPEG_MAGIC
					});
					const aRead = readPlainFile(shotsDir, p.appShot, {
						maxBytes: MAX_SHOT_BYTES,
						magic: JPEG_MAGIC
					});
					if ('refused' in mRead || 'refused' in aRead) {
						throw new Error(
							`Compare picture pair verification failed for ${p.screen} ${p.state} ${p.width}px.`
						);
					}
					if (
						needles.some(
							(n) =>
								n.length >= 6 &&
								(Buffer.from(mRead.bytes).includes(n) || Buffer.from(aRead.bytes).includes(n))
						)
					) {
						o.log(
							`Skipped uploading pair ${p.screen} ${p.state} ${p.width}px because a secret value was detected.`
						);
						continue;
					}
					evidenceIds.push(
						await board.upload(runId, {
							filename: p.mockupShot,
							caption: `Mockup ${p.screen} ${p.state} @ ${p.width}px`.slice(0, 120),
							bytes: mRead.bytes,
							signedIn: usedSavedSignIn,
							uploadSignedInPictures: uploadPictures
						})
					);
					evidenceIds.push(
						await board.upload(runId, {
							filename: p.appShot,
							caption: `App ${p.screen} ${p.state} @ ${p.width}px`.slice(0, 120),
							bytes: aRead.bytes,
							signedIn: usedSavedSignIn,
							uploadSignedInPictures: uploadPictures
						})
					);
				}
				evidenceIds.push(
					await board.upload(runId, {
						filename: 'compare-diff.json',
						caption: `Compare diff (${summaryText})`.slice(0, 120),
						bytes: Buffer.from(redact(JSON.stringify(compareReport, null, 2), needlesAll), 'utf8'),
						signedIn: usedSavedSignIn,
						uploadSignedInPictures: uploadPictures
					})
				);
			}

			const logLines = [
				`Compare ${minted.mockupId} v${minted.version}: ${summaryText}`,
				...pairRecords.flatMap((p) => [
					`--- ${p.screen} / ${p.state} @ ${p.width}px (${p.diff.passed ? 'PASS' : 'FAIL'}: ${p.diff.summary}) ---`,
					...(withheld ? [`Counts: ${p.diff.summary}`] : p.rankedLines)
				])
			];
			const wire = registration ? withBranch(registration) : null;
			const finishReport: RunReport = sanitiseReport({
				result: compareReport.passed ? 'pass' : 'fail',
				...(registration
					? {
							registration: registration.name,
							...(registration.repo ? { repoName: basename(registration.repo) } : {}),
							...(wire?.branch ? { branch: wire.branch } : {})
						}
					: {}),
				durationMs: 0,
				url: appBaseOrigin.slice(0, 300),
				commit,
				diffHash,
				...(compareReport.passed ? {} : { reason: reasonFor(`Compare failed: ${summaryText}`) }),
				...(commit ? {} : { unverified: true }),
				log: redact(logLines.join('\n'), needlesAll).slice(0, 390_000),
				signedIn: usedSavedSignIn,
				uploadSignedInPictures: uploadPictures,
				evidence: evidenceIds
			});
			await board.finish(runId, finishReport);
			finished = true;
			claimed = false;
		}

		for (const p of pairRecords) {
			o.log(
				`${p.screen} / ${p.state} @ ${p.width}px -> ${p.diff.passed ? 'PASS' : 'FAIL'} (${p.diff.summary})`
			);
			for (const l of p.rankedLines) o.log(`  ${l}`);
		}

		return {
			exitCode: compareReport.passed ? 0 : 1,
			runId,
			resultPath: existsSync(reportPath) ? reportPath : null,
			report: compareReport,
			message: compareReport.passed
				? `Compare passed (${summaryText}).`
				: `Compare found drift (${summaryText}).`
		};
	} catch (e) {
		const said = e instanceof Error ? e.message : String(e);
		if (board && runId && claimed && !finished) {
			await board
				.finish(runId, {
					result: 'error',
					reason: reasonFor(said)
				})
				.catch(() => undefined);
		}
		return stop(reasonFor(said), runId);
	} finally {
		if (beatTimer) clearInterval(beatTimer);
		if (scope) await scope.close().catch(() => undefined);
	}
}

export const COMPARE_VALUE_FLAGS = new Set([
	'--org',
	'--server',
	'--mockup',
	'--registration',
	'--profile',
	'--screens',
	'--states',
	'--widths',
	'--path',
	'--manifest',
	'--brief',
	'--item',
	'--key',
	'--step',
	'--run',
	'--dir'
]);

/** Ensures every BoardError message is readable while avoiding uncaught rejections. */
export { BoardError };

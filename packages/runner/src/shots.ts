// RUNS A UI SHOTS OR MEASURE JOB FROM THE BOARD: GET THE TARGET READY, COLLECT, REPORT (SPEC 10.1, ADR-031)
// The numbers go back to the server, which holds the scale and works out the flags itself. The collecting itself is in
// collect.ts, which the local `yarn ui-shots` shares.

// -- MODULES -- //
import type { ShotsJob } from '../../../src/lib/server/ops/uiShots';
import { UI_LEVELS } from '../../../src/lib/shared/uiChange';
import { maskSecrets, type Needle } from '../../../src/lib/shared/scan';
import { NeedsApproval } from './approvals';
import type { Account } from './api';
import type { Deps } from './checks';
import { Shooter } from './collect';
import { changedPaths, headCommit } from './git';
import { SignInFailed } from './signin';
import { TargetUnavailable } from './targets';

// -- FUNCTIONS -- //

export async function runShotsJob(job: ShotsJob, deps: Deps, repo: string): Promise<void> {
	const { api, browser, targets, config, log } = deps;
	let needles: Needle[] = [];
	const fail = (reason: string) =>
		api
			.finish('shots', job.id, {
				state: 'failed',
				reason: maskSecrets(reason, needles).slice(0, 1900)
			})
			.catch(() => undefined);
	try {
		const prepared = await targets.prepare({
			project: job.project.key,
			target: job.afterTarget,
			url: job.afterUrl,
			versionPath: null
		});
		if (prepared.note) log(`  ${prepared.note}`);
		const accounts: Record<string, Account> = job.accounts.length
			? await api.accounts('shots', job.id)
			: {};
		needles = Object.entries(accounts).map(([name, a]) => ({
			label: `the password of "${name}"`,
			value: a.password
		}));
		const shooter = new Shooter({
			browser,
			config,
			afterUrl: prepared.baseUrl,
			beforeUrl: job.beforeUrl,
			accounts,
			log,
			store: ({ filename, caption, bytes }) =>
				api.upload('shots', job.id, { filename, caption, bytes })
		});
		const results =
			job.kind === 'measure'
				? await shooter.reference({
						pages: job.project.referencePages,
						themes: job.project.themes,
						levels: [...UI_LEVELS],
						account: Object.keys(accounts)[0] ? 'default' : 'none'
					})
				: await shooter.rows(job.rows);
		await api.finish('shots', job.id, {
			state: 'done',
			reason: [
				prepared.note,
				job.beforeUrl
					? 'Before is the deployed site; its commit is not known to the runner.'
					: 'No deployed site to compare with, so there is no before.'
			]
				.filter(Boolean)
				.join(' '),
			beforeTarget: job.beforeUrl ? 'deployed' : null,
			afterCommit: prepared.commit ?? headCommit(repo),
			diffHash: prepared.diffHash,
			changedPaths: changedPaths(repo),
			outsideCalls: shooter.aborted.outside,
			abortedWrites: shooter.aborted.writes,
			results
		});
	} catch (e) {
		const message =
			e instanceof NeedsApproval || e instanceof TargetUnavailable || e instanceof SignInFailed
				? e.message
				: `The runner could not finish: ${(e as Error).message.split('\n')[0]}`;
		await fail(message);
	}
}

<script lang="ts">
	// IMPORTED DEP-MODULES
	import { untrack } from 'svelte';
	import { deserialize } from '$app/forms';
	import { invalidate } from '$app/navigation';
	// IMPORTED MODULES
	import { approvalSentence, approvalState } from '#lib/settings/approvalText.js';
	import Badge from '#lib/ui/Badge.svelte';
	import { askConfirm } from '#lib/ui/confirm.svelte.js';
	import Switch from '#lib/ui/Switch.svelte';

	// -- TYPES -- //

	type Past = {
		id: string;
		action: string;
		target: string;
		status: string;
		at: string;
		machine: string;
	};

	// -- REQUIRED PROPS -- //

	let {
		enabled,
		since,
		canManage,
		history
	}: {
		/** This person's own switch, as the server holds it. */
		enabled: boolean;
		since: string | null;
		canManage: boolean;
		history: Past[];
	} = $props();

	// -- STATES -- //

	let shown = $state(false);
	let busy = $state(false);
	let problem = $state('');

	// -- REACTIVE STATEMENTS -- //

	// The switch follows the server: after a refresh, in another tab, or when a change was refused
	$effect(() => {
		const server = enabled;
		untrack(() => (shown = server));
	});

	// -- FUNCTIONS -- //

	async function post(on: boolean): Promise<boolean> {
		const body = new FormData();
		body.set('on', String(on));
		try {
			const res = await fetch('?/autoApprove', {
				method: 'POST',
				body,
				headers: { 'x-sveltekit-action': 'true' }
			});
			const result = deserialize(await res.text());
			if (result.type === 'success') return true;
			problem =
				result.type === 'failure'
					? String(
							(result.data as { message?: string } | undefined)?.message ?? 'That did not save.'
						)
					: 'That did not save.';
		} catch {
			problem = 'That did not save. Check your connection and try again.';
		}
		return false;
	}

	/** The switch moved. Turning it on waits for the one-time warning; a cancel or a refusal puts it back. */
	async function changed(next: boolean) {
		problem = '';
		busy = true;
		try {
			if (next) {
				const yes = await askConfirm({
					title: 'Let your agent handle approvals on its own?',
					body: 'From now on your agent can add folders, register live sites, import test keys and use .env settings without asking you. If it reads something with a hidden instruction, such as a file or a comment, it could do these things without you knowing. You can see everything it did below, and turn this off at any time.',
					confirmLabel: 'Turn on',
					tone: 'primary'
				});
				if (!yes) {
					shown = false;
					return;
				}
			}
			if (await post(next)) await invalidate('afb:settings');
			else shown = !next;
		} finally {
			busy = false;
		}
	}
</script>

{#if !canManage}
	<p class="text-sm text-muted" data-testid="agent-access-readonly">
		Only managers can turn this on. It lets their own agent add folders, live sites and test keys
		without asking.
	</p>
{:else}
	<div class="rounded-lg border border-line px-3" data-testid="agent-access">
		<Switch
			label="Let my agent handle approvals on its own"
			hint={shown
				? `On${since ? ` since ${new Date(since).toLocaleDateString()}` : ''}. Your agent does not ask you.`
				: 'Off. Your agent asks you before it adds folders, live sites or test keys.'}
			bind:checked={shown}
			disabled={busy}
			onchange={(next) => void changed(next)}
			class="py-2"
		/>
	</div>
	{#if problem}<p class="text-sm text-danger" role="alert">{problem}</p>{/if}
	<p class="text-sm text-muted">
		To sign your agent in to a site, it opens a window on your computer and you sign in once, with
		whatever your site asks for.
	</p>
	<div class="flex flex-col gap-1.5" data-testid="agent-access-history">
		<span class="text-sm font-medium">What your agent did on its own</span>
		{#each history as h (h.id)}
			{@const s = approvalState(h.status)}
			<div class="flex flex-wrap items-center gap-2 text-xs text-muted">
				<Badge tone={s.tone}>{s.label}</Badge>
				<span>{approvalSentence(h.action).before}</span>
				<span class="font-mono break-all text-ink">{h.target}</span>
				<span>{new Date(h.at).toLocaleString()}</span>
			</div>
		{:else}
			<p class="text-sm text-muted">Nothing yet.</p>
		{/each}
	</div>
{/if}

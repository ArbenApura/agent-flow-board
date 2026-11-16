<script lang="ts">
	// IMPORTED DEP-MODULES
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	// IMPORTED MODULES
	import { cn } from '#lib/ui/cn.js';
	import { toastEnhance } from '#lib/ui/toastEnhance.js';
	// IMPORTED DEP-COMPONENTS
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import Clock from '@lucide/svelte/icons/clock';
	import KeyRound from '@lucide/svelte/icons/key-round';
	// IMPORTED COMPONENTS
	import Button from '#lib/ui/Button.svelte';
	import Card from '#lib/ui/Card.svelte';
	import Checkbox from '#lib/ui/Checkbox.svelte';
	import CopyButton from '#lib/ui/CopyButton.svelte';
	import Notice from '#lib/ui/Notice.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import TextField from '#lib/ui/TextField.svelte';

	// -- REQUIRED PROPS -- //

	let {
		orgSlug,
		orgName,
		roleLabel,
		address,
		caps,
		created,
		message
	}: {
		orgSlug: string;
		orgName: string;
		/** The person's role here, for example Owner: the token never holds more than it allows. */
		roleLabel: string;
		address: string;
		/** What the person's role allows, in the order the board lists them. */
		caps: string[];
		/** The token just made. It is shown once and never again. */
		created: { token: string; name: string; expiresAt: string } | null;
		message: string | null;
	} = $props();

	// -- CONSTANTS -- //

	const DAYS = [7, 30, 60, 90] as const;
	const DAY_MS = 86_400_000;
	// A hint for each capability, in plain words, and the two that deserve a second look
	const HINTS: Record<string, string> = {
		read: 'See plans, tasks and notes',
		comment: 'Add comments',
		write: 'Create and edit items',
		complete: 'Mark steps and items done',
		delete: 'Move things to the trash',
		manage: 'Change settings and members'
	};
	const CAREFUL = new Set(['delete', 'manage']);

	// -- STATES -- //

	let open = $state(false);
	let name = $state('');
	let days = $state<number>(30);
	let busy = $state(false);
	// The token the person already closed the dialog on, so it is never shown a second time
	let closedOn = $state<string | null>(null);
	// The moment used for the worked example, read on the client so the server and the page agree
	let now = $state(Date.now());

	// -- REACTIVE STATES -- //

	const ends = $derived(new Date(now + days * DAY_MS).toISOString().slice(0, 16).replace('T', ' '));
	const shownToken = $derived(created && created.token !== closedOn ? created : null);

	// -- FUNCTIONS -- //

	function onclose() {
		if (created) closedOn = created.token;
		open = false;
	}

	function openDialog() {
		now = Date.now();
		name = '';
		open = true;
	}

	// -- LIFECYCLES -- //

	onMount(() => {
		now = Date.now();
	});
</script>

<!-- PERSONAL ACCESS TOKEN: FOR A SCRIPT THAT CANNOT SIGN IN THROUGH A BROWSER. IT SITS LAST, IT IS THE ONE FOR A FEW -->
<Card
	id="token"
	class="scroll-mt-[65px] md:scroll-mt-[73px]"
	data-testid="token-card"
	icon={KeyRound}
	title="Personal access token"
	description={`For scripts and tools that cannot sign in through a browser. It works only in ${orgName}.`}
>
	<p class="mb-3 text-sm text-muted">
		The token is shown once. It lasts at most 90 days and never holds more than your role ({roleLabel})
		in {orgName} allows. Send it as a bearer header to
		<span class="font-mono text-xs break-all">{address}</span>.
	</p>
	<Button variant="secondary" onclick={openDialog}>Make a token</Button>
</Card>

<!-- THE TOKEN FORM IS A DIALOG, SO THE PAGE STAYS WHERE IT IS. THE SAME DIALOG SHOWS THE TOKEN ONCE IT IS MADE -->
<ResponsiveModal {open} {onclose} {busy} title={shownToken ? 'Your token' : 'Make a token'}>
	<div data-testid="token-form">
		{#if shownToken}
			<div
				role="status"
				class="enter rounded-lg border border-line bg-success-soft p-3"
				data-testid="token-created"
			>
				<p class="mb-2 flex items-center gap-2 text-sm text-success">
					<CircleCheck size={16} class="shrink-0" aria-hidden="true" />Copy it now. It will not be
					shown again.
				</p>
				<pre
					class="mb-2 overflow-x-auto rounded-md bg-surface p-2 font-mono text-xs leading-5 break-all whitespace-pre-wrap"
					data-testid="token-value">{shownToken.token}</pre>
				<CopyButton text={shownToken.token} label="Copy token" size="sm" />
			</div>
			<div class="mt-4"><Button variant="secondary" onclick={onclose}>Done</Button></div>
		{:else}
			{#if message}
				<Notice tone="danger" class="mb-3">{message}</Notice>
			{/if}
			<form
				method="POST"
				action="?/createToken"
				class="flex flex-col gap-4"
				use:enhance={toastEnhance({
					id: 'create-token',
					loading: 'Making the token...',
					// The text is fixed on purpose: the token itself is shown once in the dialog, never in a toast
					success: 'Token made. Copy it now, it is shown once.',
					inline: true,
					onStart: () => (busy = true),
					onDone: () => (busy = false)
				})}
			>
				<input type="hidden" name="org" value={orgSlug} />
				<TextField
					label="What is it for?"
					name="name"
					bind:value={name}
					placeholder="CI runner"
					required
				/>
				<!-- HOW LONG IT LASTS: FOUR CHOICES, AND THE DAY IT ENDS WORKED OUT FROM THE CHOICE -->
				<div class="flex flex-col gap-1.5">
					<span class="text-xs font-medium text-ink" id="days-label">How long does it last?</span>
					<div role="radiogroup" aria-labelledby="days-label" class="grid grid-cols-4 gap-2">
						{#each DAYS as d (d)}
							<button
								type="button"
								role="radio"
								aria-checked={days === d}
								onclick={() => (days = d)}
								class={cn(
									'min-h-10 cursor-pointer rounded-lg border text-sm font-medium transition-colors max-sm:min-h-11',
									days === d
										? 'border-accent bg-accent-soft text-accent-text'
										: 'border-line bg-surface text-ink hover:border-muted'
								)}>{d} d</button
							>
						{/each}
					</div>
					<input type="hidden" name="days" value={days} />
					<p
						class="flex items-center gap-2 text-xs text-muted"
						aria-live="polite"
						data-testid="token-ends"
					>
						<Clock size={14} class="shrink-0" aria-hidden="true" />
						<span
							>Made now, it ends on <span class="font-medium text-ink tabular-nums">{ends}</span
							>.</span
						>
					</p>
				</div>
				<fieldset class="flex flex-col">
					<legend class="mb-1 text-xs font-medium text-muted">What it may do</legend>
					{#each caps as c (c)}
						<Checkbox
							label={c}
							name="permission"
							value={c}
							checked={c === 'read' || c === 'write'}
							hint={HINTS[c]}
							badge={CAREFUL.has(c) ? 'Careful' : undefined}
						/>
					{/each}
				</fieldset>
				<!-- CREATE TOKEN IS THE ONLY PRIMARY BUTTON OF THE DIALOG -->
				<div><Button type="submit" variant="primary" loading={busy}>Create token</Button></div>
			</form>
		{/if}
	</div>
</ResponsiveModal>

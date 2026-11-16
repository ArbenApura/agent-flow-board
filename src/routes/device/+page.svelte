<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { PageProps } from './$types';
	// IMPORTED ENVS
	import { enhance } from '$app/forms';
	// IMPORTED MODULES
	import Notice from '#lib/ui/Notice.svelte';
	import { ROLE_LABEL } from '#lib/shared/roles.js';
	import AuthShell from '#lib/ui/AuthShell.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Checkbox from '#lib/ui/Checkbox.svelte';
	import SelectField from '#lib/ui/SelectField.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	import { toastEnhance } from '#lib/ui/toastEnhance.js';

	// -- CONSTANTS -- //

	const CAP_TEXT: Record<string, string> = {
		read: 'Read items, plans and comments',
		comment: 'Add comments',
		write: 'Create and change items, steps and documents',
		complete: 'Set an item to COMPLETED where the project allows it',
		delete: 'Move items to the trash',
		manage: 'Change project settings'
	};
	const DEFAULT_ON = ['read', 'write'];

	// -- REQUIRED PROPS -- //

	let { form }: PageProps = $props();

	// -- TYPES -- //

	type Confirm = {
		step: 'confirm';
		typed: string;
		info: { client: string; origin: string | null; expiresInSeconds: number };
		orgs: {
			id: string;
			name: string;
			role: 'owner' | 'admin' | 'member' | 'viewer' | 'guest';
			caps: string[];
		}[];
		// Set when the tool asked for one organisation. The server decides locked and blocked, the page only shows them
		requested: { slug: string; locked: boolean; blocked: boolean } | null;
		account: string;
	};

	// -- STATES -- //

	let typed = $state('');
	let orgId = $state('');

	// -- REACTIVE STATES -- //

	const confirm = $derived(
		form && 'step' in form && form.step === 'confirm' ? (form as unknown as Confirm) : null
	);
	// The first organisation is shown selected, which is the one the form sends. A requested organisation is the only one offered, and a blocked request offers none
	$effect(() => {
		if (confirm && !orgId) orgId = confirm.orgs[0]?.id ?? '';
	});
	const org = $derived(confirm?.orgs.find((o) => o.id === orgId) ?? confirm?.orgs[0]);
	const locked = $derived(!!confirm?.requested?.locked);
	const blocked = $derived(!!confirm?.requested?.blocked);
</script>

<svelte:head><title>Approve a tool</title></svelte:head>

<AuthShell
	title="Approve a tool"
	note="Approving gives that tool your access until you revoke it in Your settings."
	subtitle="Type the code your tool printed. It works once, for a few minutes. You can open this page on any computer or phone. Never approve a code you did not just start yourself."
>
	{#if form && 'step' in form && form.step === 'done'}
		<p
			role="status"
			class="rounded-lg border border-line bg-success-soft p-3 text-sm text-success"
			data-testid="device-done"
		>
			{form.approved
				? `${form.client} is connected. You can go back to it.`
				: `${form.client} was refused.`}
		</p>
	{:else if confirm}
		<div class="mb-3 rounded-lg border border-line bg-raised p-3 text-sm" data-testid="device-info">
			<strong>{confirm.info.client}</strong> asked to sign in{confirm.info.origin
				? ` from ${confirm.info.origin}`
				: ''}. The code works for {Math.floor(confirm.info.expiresInSeconds / 60)} minutes, once.
		</div>
		{#if blocked && confirm.requested}
			<!-- THE TOOL ASKED FOR AN ORGANISATION THIS ACCOUNT CANNOT USE: ONE WORDING FOR EVERY REASON, NOTHING TO APPROVE -->
			<Notice tone="danger" class="mb-3" data-testid="device-org-blocked">
				This tool asked to connect to <span class="font-mono text-xs">{confirm.requested.slug}</span
				>, but you are signed in as {confirm.account}, and that account is not in an organisation
				with that name. Refuse this request, then sign in with the right account or start the sign
				in again.
			</Notice>
		{:else}
			<form
				method="POST"
				action="?/approve"
				use:enhance={toastEnhance({
					id: 'device-approve',
					loading: 'Approving the tool...',
					success: 'Tool approved.',
					inline: true,
					reset: true
				})}
				class="flex flex-col gap-3"
			>
				<input type="hidden" name="code" value={confirm.typed} />
				<input type="hidden" name="org" value={org?.id ?? ''} />
				{#if locked && org}
					<!-- THE TOOL NAMED ONE ORGANISATION, SO THERE IS NOTHING TO PICK -->
					<p class="text-sm" data-testid="device-org-locked">
						<span class="text-muted">Connecting to</span>
						<span class="font-medium">{org.name}</span>
						<span class="text-muted">({ROLE_LABEL[org.role]})</span>
					</p>
				{:else}
					<SelectField
						label="Organisation"
						options={confirm.orgs.map((o) => ({
							value: o.id,
							label: `${o.name} (${ROLE_LABEL[o.role]})`
						}))}
						bind:value={orgId}
					/>
				{/if}
				<fieldset class="flex flex-col">
					<legend class="mb-1 text-xs font-medium text-muted">What it may do</legend>
					{#key org?.id}
						{#each org?.caps ?? [] as c (c)}
							<Checkbox
								label={CAP_TEXT[c] ?? c}
								name="scope"
								value={c}
								checked={DEFAULT_ON.includes(c)}
							/>
						{/each}
					{/key}
				</fieldset>
				<Button type="submit" variant="primary" class="w-full">Approve</Button>
			</form>
		{/if}
		<form
			method="POST"
			action="?/deny"
			use:enhance={toastEnhance({
				id: 'device-deny',
				loading: 'Refusing the request...',
				success: 'Request refused.',
				inline: true,
				reset: true
			})}
			class="mt-2"
		>
			<input type="hidden" name="code" value={confirm.typed} />
			<Button type="submit" class="w-full">Refuse</Button>
		</form>
	{:else}
		{#if form && 'message' in form && form.message}
			<Notice tone="danger" class="mb-3" data-testid="device-error">{form.message}</Notice>
		{/if}
		<form
			method="POST"
			action="?/lookup"
			use:enhance={toastEnhance({
				id: 'device-lookup',
				loading: 'Checking the code...',
				// The next step on the page is the feedback
				success: null,
				inline: true,
				reset: true
			})}
			class="flex flex-col gap-3"
		>
			<TextField
				label="Code from your tool"
				name="code"
				bind:value={typed}
				placeholder="ABCD-EFGH"
				autocomplete="off"
				autocapitalize="characters"
				required
			/>
			<Button type="submit" variant="primary" class="w-full">Continue</Button>
		</form>
	{/if}
</AuthShell>

<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	// -- ENVS -- //
	import { enhance } from '$app/forms';
	// -- MODULES -- //
	import Notice from '#lib/ui/Notice.svelte';
	import { ROLE_LABEL } from '#lib/shared/roles.js';
	import AuthShell from '#lib/ui/AuthShell.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Checkbox from '#lib/ui/Checkbox.svelte';
	import SelectField from '#lib/ui/SelectField.svelte';
	import TextField from '#lib/ui/TextField.svelte';

	// -- CONSTANTS -- //

	const CAP_TEXT: Record<string, string> = {
		read: 'Read items, plans and comments',
		comment: 'Add comments',
		write: 'Create and change items, steps and documents',
		complete: 'Set an item to COMPLETED where the project allows it',
		delete: 'Move items to the trash',
		publish: 'Publish to GitHub',
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
	};

	// -- STATES -- //

	let typed = $state('');
	let orgId = $state('');

	// -- REACTIVE STATES -- //

	const confirm = $derived(
		form && 'step' in form && form.step === 'confirm' ? (form as unknown as Confirm) : null
	);
	// The first organisation is shown selected, which is the one the form sends
	$effect(() => {
		if (confirm && !orgId) orgId = confirm.orgs[0]?.id ?? '';
	});
	const org = $derived(confirm?.orgs.find((o) => o.id === orgId) ?? confirm?.orgs[0]);
</script>

<svelte:head><title>Approve a tool</title></svelte:head>

<AuthShell
	title="Approve a tool"
	note="Approving gives that tool your access until you revoke it in Your settings."
	subtitle="Type the code your tool shows. Never approve a code you did not just start yourself."
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
				: ''}. The code expires in {Math.ceil(confirm.info.expiresInSeconds / 60)} minutes.
		</div>
		<form method="POST" action="?/approve" use:enhance class="flex flex-col gap-3">
			<input type="hidden" name="code" value={confirm.typed} />
			<input type="hidden" name="org" value={org?.id ?? ''} />
			<SelectField
				label="Organisation"
				options={confirm.orgs.map((o) => ({
					value: o.id,
					label: `${o.name} (${ROLE_LABEL[o.role]})`
				}))}
				bind:value={orgId}
			/>
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
		<form method="POST" action="?/deny" use:enhance class="mt-2">
			<input type="hidden" name="code" value={confirm.typed} />
			<Button type="submit" class="w-full">Refuse</Button>
		</form>
	{:else}
		{#if form && 'message' in form && form.message}
			<Notice tone="danger" class="mb-3" data-testid="device-error">{form.message}</Notice>
		{/if}
		<form method="POST" action="?/lookup" use:enhance class="flex flex-col gap-3">
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

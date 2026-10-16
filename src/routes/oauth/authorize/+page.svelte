<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	// -- MODULES -- //
	import Notice from '#lib/ui/Notice.svelte';
	import { ROLE_LABEL } from '#lib/shared/roles.js';
	import AuthShell from '#lib/ui/AuthShell.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Checkbox from '#lib/ui/Checkbox.svelte';
	import SelectField from '#lib/ui/SelectField.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';
	import { LOADING_MS } from '#lib/ui/toastEnhance.js';

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

	// -- REQUIRED PROPS -- //

	let { data }: PageProps = $props();

	// -- STATES -- //

	// The first organisation is selected on screen as well as in the form, so what is approved is what is shown
	let orgId = $state('');
	$effect(() => {
		if (!orgId) orgId = data.orgs[0]?.id ?? '';
	});

	// -- REACTIVE STATES -- //

	const org = $derived(data.orgs.find((o) => o.id === orgId) ?? data.orgs[0]);
	const caps = $derived(org ? org.caps : []);
	const asked = $derived(data.request?.scopes ?? []);

	// -- FUNCTIONS -- //

	// The answer is a full page POST that ends on the tool's own address, so the toast only covers the wait
	function answering(text: string) {
		return () => {
			// A private-scheme redirect leaves this page open, so the toast must not wait for ever
			toast.loading(text, { duration: LOADING_MS });
		};
	}
</script>

<svelte:head><title>Connect a tool</title></svelte:head>

<AuthShell title={data.request ? `Connect ${data.request.clientName}?` : 'Connection problem'}>
	{#if data.problem || !data.request}
		<Notice tone="danger" data-testid="oauth-problem">{data.problem}</Notice>
	{:else}
		<div class="mb-3 flex flex-wrap items-center gap-2">
			{#if data.request.verified}<Badge tone="success">Verified</Badge>{:else}<Badge tone="warning"
					>Unverified</Badge
				>{/if}
			<span class="text-sm text-muted">It will return to {data.request.redirectHost}</span>
		</div>
		<p class="mb-3 text-sm text-muted">
			{data.request.clientName} introduced itself. Anyone can register a tool under any name, so connect
			only a tool you started yourself.
		</p>
		{#if data.notice}
			<Notice tone="danger" class="mb-3" data-testid="oauth-notice">{data.notice}</Notice>
		{/if}
		{#if data.orgs.length === 0}
			<p class="text-sm">
				You are not in an organisation yet, so there is nothing to connect. Create one first.
			</p>
			<div class="mt-3">
				<Button href="/" variant="primary" class="w-full">Go to your organisations</Button>
			</div>
		{:else}
			<form
				method="POST"
				action="/oauth/authorize/decision"
				class="flex flex-col gap-3"
				data-testid="consent-form"
				onsubmit={answering('Connecting...')}
			>
				{#each Object.entries(data.raw) as [k, v] (k)}<input
						type="hidden"
						name={k}
						value={v}
					/>{/each}
				<input type="hidden" name="org" value={org?.id ?? ''} />
				<SelectField
					label="Organisation"
					options={data.orgs.map((o) => ({
						value: o.id,
						label: `${o.name} (${ROLE_LABEL[o.role]})`
					}))}
					bind:value={orgId}
				/>
				<fieldset class="flex flex-col">
					<legend class="mb-1 text-xs font-medium text-muted">What it may do</legend>
					{#key org?.id}
						{#each caps as c (c)}
							<Checkbox
								label={CAP_TEXT[c] ?? c}
								name="scope"
								value={c}
								checked={asked.includes(c as never)}
							/>
						{/each}
					{/key}
				</fieldset>
				<input type="hidden" name="decision" value="approve" />
				<Button type="submit" variant="primary" class="w-full"
					>Connect {data.request.clientName}</Button
				>
			</form>
			<form
				method="POST"
				action="/oauth/authorize/decision"
				class="mt-2"
				onsubmit={answering('Cancelling...')}
			>
				{#each Object.entries(data.raw) as [k, v] (k)}<input
						type="hidden"
						name={k}
						value={v}
					/>{/each}
				<input type="hidden" name="decision" value="deny" />
				<Button type="submit" class="w-full">Cancel</Button>
			</form>
		{/if}
	{/if}
</AuthShell>

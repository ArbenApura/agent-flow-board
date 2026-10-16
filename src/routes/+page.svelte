<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	// -- DEP-MODULES -- //
	import { enhance } from '$app/forms';
	// -- MODULES -- //
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import { ROLE_LABEL } from '#lib/shared/roles.js';
	import Avatar from '#lib/ui/Avatar.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Card from '#lib/ui/Card.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import Mark from '#lib/ui/Mark.svelte';
	import PageHeader from '#lib/ui/PageHeader.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	// -- DEP-COMPONENTS -- //
	import Plus from 'phosphor-svelte/lib/Plus';

	// -- REQUIRED PROPS -- //

	let { data, form }: PageProps = $props();

	// -- STATES -- //

	let name = $state('');
	let slug = $state('');
	let busy = $state(false);
	let creating = $state(false);

	// -- FUNCTIONS -- //

	// The address follows the name until the person types their own
	function suggest(value: string) {
		slug = value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 38);
	}
</script>

<svelte:head><title>Your organisations</title></svelte:head>

<PageFrame tag="main" class="pb-12">
	<div class="flex items-center justify-between gap-3 pt-6">
		<div class="flex items-center gap-2.5 text-base font-semibold">
			<Mark size={28} /> agent-flow-board
		</div>
		<form method="POST" action="/sign-out" class="flex items-center gap-3">
			<span class="text-sm text-muted max-sm:hidden" data-testid="signed-in-as"
				>{data.user.email}</span
			>
			<Button type="submit" size="sm">Sign out</Button>
		</form>
	</div>

	<PageHeader
		title="Your organisations"
		context={`Hello ${data.user.name}. Pick an organisation or start a new one.`}
		testid="home-title"
	>
		{#snippet actions()}
			{#if data.orgs.length}
				<Button variant="primary" onclick={() => (creating = true)} data-testid="new-org">
					<Plus size={16} /> New organisation
				</Button>
			{/if}
		{/snippet}
	</PageHeader>

	{#if data.orgs.length === 0}
		<div class="grid gap-6 md:grid-cols-2">
			<EmptyState
				kind="welcome"
				title="You are not in an organisation yet"
				text="Create one, or open an invitation link from your email."
			/>
			<Card>
				{#snippet header()}<h2 class="text-lg font-semibold">New organisation</h2>{/snippet}
				{@render orgForm()}
			</Card>
		</div>
	{:else}
		<ul class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{#each data.orgs as o (o.id)}
				<li data-row>
					<a
						href={`/${o.slug}`}
						class="flex items-center gap-4 rounded-xl border border-line bg-surface p-5 transition-colors hover:border-muted"
					>
						<Avatar name={o.name} size={40} kind="agent" />
						<span class="flex min-w-0 flex-1 flex-col gap-1">
							<span class="truncate text-base font-medium">{o.name}</span>
							<span class="text-sm text-muted">/{o.slug}</span>
						</span>
						<Badge>{ROLE_LABEL[o.role]}</Badge>
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</PageFrame>

<ResponsiveModal open={creating} onclose={() => (creating = false)} title="New organisation" {busy}>
	{@render orgForm()}
</ResponsiveModal>

{#snippet orgForm()}
	<form
		method="POST"
		action="?/createOrg"
		class="flex flex-col gap-4"
		use:enhance={() => {
			busy = true;
			return async ({ update }) => {
				await update({ reset: false });
				busy = false;
			};
		}}
	>
		<TextField
			label="Organisation name"
			name="name"
			bind:value={name}
			oninput={() => suggest(name)}
			required
			placeholder="Acme"
		/>
		<TextField
			label="Address"
			name="slug"
			bind:value={slug}
			required
			hint="Lowercase letters, digits and dashes. It becomes part of every link."
			error={form?.message}
		/>
		<div><Button type="submit" variant="primary" loading={busy}>Create organisation</Button></div>
	</form>
{/snippet}

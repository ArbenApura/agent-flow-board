<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	// -- DEP-MODULES -- //
	import { enhance } from '$app/forms';
	// -- MODULES -- //
	import { ROLE_LABEL } from '#lib/shared/roles.js';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Card from '#lib/ui/Card.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import Mark from '#lib/ui/Mark.svelte';
	import TextField from '#lib/ui/TextField.svelte';

	// -- REQUIRED PROPS -- //

	let { data, form }: PageProps = $props();

	// -- STATES -- //

	let name = $state('');
	let slug = $state('');
	let busy = $state(false);

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

<div class="mx-auto flex max-w-[720px] flex-col gap-6 px-4 py-6 max-sm:px-3.5">
	<header class="flex items-center justify-between gap-3">
		<div class="flex items-center gap-2 font-bold"><Mark size={24} /> agent-flow-board</div>
		<form method="POST" action="/sign-out">
			<span class="mr-2 text-sm text-muted max-sm:hidden" data-testid="signed-in-as"
				>{data.user.email}</span
			>
			<Button type="submit" size="sm">Sign out</Button>
		</form>
	</header>

	<div>
		<h1 class="text-xl leading-7 font-semibold sm:text-2xl sm:leading-8">Your organisations</h1>
		<p class="text-sm leading-[22px] text-muted">
			Hello {data.user.name}. Pick an organisation or start a new one.
		</p>
	</div>

	<Card padded={false}>
		{#if data.orgs.length === 0}
			<EmptyState
				title="You are not in an organisation yet"
				text="Create one below, or open an invitation link from your email."
			/>
		{:else}
			<ul>
				{#each data.orgs as o (o.id)}
					<li data-row class="border-b border-line last:border-b-0">
						<a
							href={`/${o.slug}`}
							class="flex min-h-12 items-center justify-between gap-3 px-4 py-2 hover:bg-raised"
						>
							<span class="font-medium">{o.name}</span>
							<Badge>{ROLE_LABEL[o.role]}</Badge>
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	</Card>

	<Card>
		{#snippet header()}<h2 class="text-base leading-6 font-semibold sm:text-lg sm:leading-[26px]">
				New organisation
			</h2>{/snippet}
		<form
			method="POST"
			action="?/createOrg"
			class="flex flex-col gap-3"
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
	</Card>
</div>

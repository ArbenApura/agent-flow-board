<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { PageProps } from './$types';
	// IMPORTED DEP-MODULES
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	// IMPORTED MODULES
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import { ROLE_LABEL } from '#lib/shared/roles.js';
	import OrgTile from '#lib/board/OrgTile.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import PageHeader from '#lib/ui/PageHeader.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	import { toastEnhance } from '#lib/ui/toastEnhance.js';
	// IMPORTED DEP-COMPONENTS
	import Building2 from '@lucide/svelte/icons/building-2';
	import FolderKanban from '@lucide/svelte/icons/folder-kanban';
	import Plug from '@lucide/svelte/icons/plug';
	import Plus from '@lucide/svelte/icons/plus';

	// -- REQUIRED PROPS -- //

	let { data, form }: PageProps = $props();

	// -- CONSTANTS -- //

	const NEXT_STEPS = [
		{
			icon: Building2,
			title: 'Create your organisation',
			text: 'A home for your team and its work.'
		},
		{
			icon: FolderKanban,
			title: 'Add a project',
			text: 'Plans, steps and checks live in projects.'
		},
		{ icon: Plug, title: 'Connect your agents', text: 'They record progress as they work.' }
	];

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

	// -- LIFECYCLES -- //

	// Remember the shape of this page, so the loading placeholder draws the same one next time
	onMount(() => {
		try {
			localStorage.setItem('afb-home', data.orgs.length ? 'orgs' : 'empty');
		} catch {
			/* Storage can be blocked, the placeholder falls back to a row of cards */
		}
	});
</script>

<svelte:head><title>Your organisations</title></svelte:head>

<PageFrame class={data.orgs.length ? 'pb-12' : 'flex flex-1 flex-col pb-12'}>
	{#if data.orgs.length}
		<PageHeader
			title="Your organisations"
			context={`Hello ${data.me.name}. Pick an organisation or start a new one.`}
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
	{/if}

	{#if data.orgs.length === 0}
		<!-- THE FIRST VISIT. ONE CARD IN TWO PANES. ON THE LEFT A WELCOME AND THE THREE STEPS AHEAD, ON THE RIGHT THE FORM FOR THE FIRST STEP, BOTH THE SAME HEIGHT -->
		<div class="flex flex-1 items-center py-8">
			<div
				class="mx-auto grid w-full max-w-[980px] overflow-hidden rounded-2xl border border-line bg-surface shadow-[var(--elev-2)] md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]"
				data-card
			>
				<div
					class="flex flex-col justify-between gap-10 border-b border-line bg-gradient-to-br from-accent-soft/60 via-raised/40 to-surface p-8 max-sm:p-5 md:border-r md:border-b-0"
				>
					<div class="flex flex-col gap-2">
						<p class="text-xs font-medium tracking-wide text-accent-text uppercase">
							Welcome, {data.me.name.split(' ')[0]}
						</p>
						<h1
							class="font-display text-2xl font-semibold tracking-tight text-ink"
							data-testid="home-title"
						>
							Set up your first organisation
						</h1>
						<p class="text-sm text-muted">It takes a minute. Here is what comes next.</p>
					</div>
					<ol class="flex flex-col">
						{#each NEXT_STEPS as step, i (step.title)}
							<li class="relative flex gap-4 pb-6 last:pb-0">
								{#if i < NEXT_STEPS.length - 1}
									<span class="absolute top-9 bottom-1 left-[17px] w-px bg-line" aria-hidden="true"
									></span>
								{/if}
								<span
									class="relative inline-flex size-9 shrink-0 items-center justify-center rounded-full border {i ===
									0
										? 'border-accent bg-accent text-accent-ink'
										: 'border-line bg-surface text-muted'}"
									aria-hidden="true"><step.icon size={16} /></span
								>
								<span class="flex flex-col pt-0.5">
									<span class="text-sm font-semibold {i === 0 ? 'text-ink' : 'text-muted'}"
										>{step.title}</span
									>
									<span class="text-sm text-muted">{step.text}</span>
								</span>
							</li>
						{/each}
					</ol>
					<p class="text-sm text-muted">
						Have an invitation? Open the link from your email instead.
					</p>
				</div>
				<div class="flex flex-col justify-center gap-6 p-8 max-sm:p-5">
					<div class="flex flex-col gap-1">
						<h2 class="font-display text-lg font-semibold text-ink">Create your organisation</h2>
						<p class="text-sm text-muted">Your team and its projects live here.</p>
					</div>
					{@render orgForm()}
				</div>
			</div>
		</div>
	{:else}
		<ul class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
			{#each data.orgs as o (o.id)}
				<li>
					<a
						href={o.deleted ? `/deleted/${o.slug}` : `/${o.slug}`}
						data-card
						class="flex items-center gap-4 rounded-xl border border-line bg-surface p-5 shadow-[var(--elev-1)] transition-colors hover:border-muted"
					>
						<OrgTile name={o.name} logo={o.logo} palette={o.palette} size={40} />
						<span class="flex min-w-0 flex-1 flex-col gap-1">
							<span class="truncate text-base font-medium">{o.name}</span>
							<span class="text-sm text-muted">/{o.slug}</span>
						</span>
						{#if o.deleted}
							<Badge tone="warning">Scheduled for deletion</Badge>
						{:else}
							<Badge>{ROLE_LABEL[o.role]}</Badge>
						{/if}
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
		use:enhance={toastEnhance({
			id: 'create-org',
			loading: 'Creating the organisation...',
			success: 'Organisation created.',
			inline: true,
			onStart: () => (busy = true),
			onDone: () => (busy = false)
		})}
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
			placeholder="acme"
			required
			hint={`Your link will be ${page.url.host}/${slug || 'acme'}. Lowercase letters, digits and dashes.`}
			error={form?.message}
		/>
		<Button type="submit" variant="primary" loading={busy} class="h-11 w-full"
			>Create organisation</Button
		>
	</form>
{/snippet}

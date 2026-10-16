<script lang="ts">
	// -- DEP-TYPES -- //
	import type { Component, Snippet } from 'svelte';
	// -- MODULES -- //
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import { useTabs } from '#lib/settings/tabs.svelte.js';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';

	// -- REQUIRED PROPS -- //

	let {
		title,
		text,
		icon: Icon,
		group,
		id,
		children,
		dirty = false,
		saving = false,
		saved = false,
		error = '',
		onsave,
		saveLabel = 'Save',
		readonly = false
	}: {
		title: string;
		/** One plain sentence saying what this section controls. */
		text?: string;
		/** A small icon in the tile before the title, and in the navigation. */
		icon?: Component<{ size?: number; class?: string }>;
		/** The heading its tab sits under in the navigation. Without one the tab is in a flat list. */
		group?: string;
		/** The address anchor and test id of the section, for example "palette". */
		id: string;
		children: Snippet;
		/** True while there is a change not saved yet. The button is off until then. */
		dirty?: boolean;
		saving?: boolean;
		/** Shows "Saved" until the next change. */
		saved?: boolean;
		error?: string;
		/** Without it the section has no save button (a read only list, or one that saves as you go). */
		onsave?: () => void | Promise<void>;
		saveLabel?: string;
		/** A person who may only look sees the section without a save button. */
		readonly?: boolean;
	} = $props();

	// -- CONSTANTS -- //

	const tabs = useTabs();
	untrack(() => tabs?.add({ id, title, icon: Icon, group }));

	// -- REACTIVE STATES -- //

	// Inside a settings shell only the open tab shows. It stays mounted, so unsaved edits are kept when someone looks at another tab
	const shown = $derived(!tabs || (page.url.searchParams.get('tab') || tabs.items[0]?.id) === id);
	// The pill in the header says where the section stands. A section with no save bar and no read only mark has none
	const pill = $derived(
		readonly
			? ({ tone: 'neutral', label: 'Read only' } as const)
			: onsave && dirty
				? ({ tone: 'warning', label: 'Unsaved changes' } as const)
				: onsave && saved && !error
					? ({ tone: 'success', label: 'Saved' } as const)
					: null
	);
</script>

<!-- ONE SETTINGS SECTION: ITS OWN CARD AND ITS OWN SAVE, SO CHANGING ONE NEVER SAVES ANOTHER (ADR-015) -->
<section
	{id}
	hidden={!shown}
	data-testid={`section-${id}`}
	class="enter flex scroll-mt-20 flex-col gap-4 rounded-xl border border-line bg-surface p-6 shadow-[var(--elev-1),inset_0_1px_0_color-mix(in_srgb,var(--ink)_6%,transparent)] max-sm:p-3.5"
	data-card
	aria-labelledby={`${id}-title`}
>
	<!-- THE HEADER: THE SAME OUTLINED ACCENT TILE ON EVERY SECTION, SO THE CARDS READ AS ONE FAMILY -->
	<div class="flex items-start gap-3">
		{#if Icon}
			<span
				aria-hidden="true"
				class="inline-flex size-10 shrink-0 items-center justify-center rounded-lg border border-accent/35 bg-accent/12 text-accent-text"
				><Icon size={20} /></span
			>
		{/if}
		<div class="min-w-0 flex-1">
			<h2 id={`${id}-title`} class="text-lg font-semibold">{title}</h2>
			{#if text}<p class="text-sm text-muted">{text}</p>{/if}
		</div>
		{#if pill}
			<Badge tone={pill.tone} class="shrink-0">
				{#if pill.label === 'Saved'}
					<svg
						viewBox="0 0 12 12"
						class="afb-check size-3"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"><path d="M2 6.5 4.5 9 10 3.5" pathLength="1" /></svg
					>
				{/if}
				{pill.label}
			</Badge>
		{/if}
	</div>
	<div class="flex flex-col gap-3">
		{@render children()}
	</div>
	{#if onsave && !readonly}
		<!-- THE SAVE BAR: A RULE ABOVE IT, SO IT READS AS THE FOOT OF THE CARD, AND A PLAIN SAYING OF WHERE THINGS STAND -->
		<div
			class="z-10 -mx-6 -mb-6 flex flex-wrap items-center gap-3 rounded-b-xl border-t border-line bg-surface px-6 py-3 shadow-[var(--elev-2)] max-sm:-mx-3.5 max-sm:-mb-3.5 max-sm:px-3.5 sm:sticky sm:bottom-0"
		>
			<Button
				variant="primary"
				disabled={!dirty}
				loading={saving}
				onclick={() => void onsave()}
				data-testid={`save-${id}`}>{saveLabel}</Button
			>
			{#if error}
				<span class="text-sm text-danger" role="alert" data-testid={`error-${id}`}>{error}</span>
			{:else if saved && !dirty}
				<span class="text-sm text-success" role="status" data-testid={`saved-${id}`}
					>Your changes are saved.</span
				>
			{:else if dirty}
				<span class="text-sm text-warning">You have changes that are not saved.</span>
			{:else}
				<span class="text-sm text-muted">Nothing to save yet.</span>
			{/if}
		</div>
	{:else if readonly}
		<div class="text-xs text-muted">Only an admin or owner can change this.</div>
	{/if}
</section>

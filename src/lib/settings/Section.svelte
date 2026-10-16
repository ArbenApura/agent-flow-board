<script lang="ts">
	// -- DEP-TYPES -- //
	import type { Component, Snippet } from 'svelte';
	// -- MODULES -- //
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import { useTabs } from '#lib/settings/tabs.svelte.js';
	import Button from '#lib/ui/Button.svelte';

	// -- REQUIRED PROPS -- //

	let {
		title,
		text,
		icon: Icon,
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
		/** A small icon before the title. */
		icon?: Component<{ size?: number; class?: string }>;
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
	untrack(() => tabs?.add(id, title));

	// -- REACTIVE STATES -- //

	// Inside a settings shell only the open tab shows. It stays mounted, so unsaved edits are kept when someone looks at another tab
	const shown = $derived(!tabs || (page.url.searchParams.get('tab') || tabs.items[0]?.id) === id);
</script>

<!-- ONE SETTINGS SECTION: ITS OWN CARD AND ITS OWN SAVE, SO CHANGING ONE NEVER SAVES ANOTHER (ADR-015) -->
<section
	{id}
	hidden={!shown}
	data-testid={`section-${id}`}
	class="flex scroll-mt-20 flex-col gap-4 rounded-xl border border-line bg-surface p-6 shadow-[var(--elev-1)] max-sm:p-4"
	data-card
	aria-labelledby={`${id}-title`}
>
	<div>
		<h2 id={`${id}-title`} class="flex items-center gap-2 text-lg font-semibold">
			{#if Icon}<span aria-hidden="true" class="inline-flex text-muted"><Icon size={18} /></span
				>{/if}
			{title}
		</h2>
		{#if text}<p class="text-sm text-muted">{text}</p>{/if}
	</div>
	<div class="flex flex-col gap-3">
		{@render children()}
	</div>
	{#if onsave && !readonly}
		<!-- THE SAVE BAR: A RULE ABOVE IT, SO IT READS AS THE FOOT OF THE CARD, AND A PLAIN SAYING OF WHERE THINGS STAND -->
		<div
			class="z-10 -mx-6 -mb-6 flex flex-wrap items-center gap-3 rounded-b-xl border-t border-line bg-surface px-6 py-3 shadow-[var(--elev-2)] max-sm:-mx-4 max-sm:-mb-4 max-sm:px-4 sm:sticky sm:bottom-0"
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
				<span class="text-sm text-success" role="status" data-testid={`saved-${id}`}>Saved</span>
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

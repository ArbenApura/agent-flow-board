<script lang="ts">
	// IMPORTED MODULES
	import ColorPanel from '#lib/settings/ColorPanel.svelte';
	import ModePreview from '#lib/settings/ModePreview.svelte';
	import { checkPalette, generatePalette } from '#lib/theme/palette.js';
	import { DEFAULT_ACCENT, PRESETS } from '#lib/theme/presets.js';
	import Button from '#lib/ui/Button.svelte';
	import Popover from '#lib/ui/Popover.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let {
		value = $bindable(null),
		label = 'Accent colour',
		disabled = false
	}: {
		/** A six digit colour, or null for the default palette. */
		value?: string | null;
		label?: string;
		disabled?: boolean;
	} = $props();

	// -- STATES -- //

	let invalid = $state('');
	let panelOpen = $state(false);

	// -- REACTIVE STATES -- //

	// The text box follows the choice when a preset or the picker changes it, and holds what is typed until it is a colour
	let text = $derived(value ?? '');
	const shown = $derived(value ?? DEFAULT_ACCENT);
	const palette = $derived(generatePalette(shown));
	const failing = $derived(checkPalette(palette).filter((c) => !c.pass));

	// -- FUNCTIONS -- //

	function pick(hex: string | null) {
		invalid = '';
		value = hex;
	}

	function typed(v: string) {
		text = v;
		if (/^#[0-9a-fA-F]{6}$/.test(v.trim())) {
			invalid = '';
			value = v.trim().toLowerCase();
		} else invalid = 'Use a six digit colour that starts with a hash';
	}
</script>

<div class="flex flex-col gap-3" data-testid="palette-picker">
	<div class="flex flex-col gap-1">
		<span class="text-xs font-medium text-muted" id="palette-label">{label}</span>
		<div class="flex flex-wrap gap-2" role="radiogroup" aria-labelledby="palette-label">
			{#each PRESETS as p (p.hex)}
				<button
					type="button"
					role="radio"
					aria-checked={shown.toLowerCase() === p.hex}
					aria-label={p.name}
					{disabled}
					onclick={() => pick(p.hex)}
					class={cn(
						'relative size-11 cursor-pointer rounded-lg border-2 border-line disabled:cursor-not-allowed disabled:opacity-50',
						'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
						shown.toLowerCase() === p.hex && 'border-ink'
					)}
				>
					<!-- DYNAMIC RUNTIME COLOUR OF THE PRESET -->
					<span class="absolute inset-1 rounded-md" style="background:{p.hex}"></span>
				</button>
			{/each}
		</div>
	</div>
	<div class="flex flex-wrap items-end gap-2">
		<TextField
			label="Or a colour of your own"
			value={text}
			oninput={(e) => typed(e.currentTarget.value)}
			error={invalid}
			placeholder={DEFAULT_ACCENT}
			{disabled}
			class="w-44"
			data-testid="palette-hex"
		/>
		<Popover bind:open={panelOpen} label="Pick a colour" class="p-3">
			{#snippet trigger({ props, toggle })}
				<button
					{...props}
					type="button"
					aria-label="Pick a colour"
					{disabled}
					onclick={toggle}
					class="relative size-10 cursor-pointer rounded-lg border border-line bg-surface p-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 max-sm:size-11"
				>
					<!-- DYNAMIC RUNTIME COLOUR OF THE CHOICE -->
					<span class="block size-full rounded-md" style="background:{shown}"></span>
				</button>
			{/snippet}
			<ColorPanel value={shown} onchange={pick} />
		</Popover>
		<Button
			onclick={() => pick(null)}
			disabled={disabled || value === null}
			data-testid="palette-reset">Use the default</Button
		>
	</div>

	<!-- THE LIVE PREVIEW IN BOTH MODES: EACH DRAWING CARRIES ITS OWN MODE, SO THE TOKENS OF THAT MODE APPLY INSIDE IT -->
	<div class="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="palette-preview">
		{#each ['light', 'dark'] as const as mode (mode)}
			<div class="flex flex-col gap-1.5">
				<ModePreview {mode} {palette} data-testid={`preview-${mode}`} />
				<div class="text-xs font-medium text-muted">{mode === 'light' ? 'Light' : 'Dark'}</div>
			</div>
		{/each}
	</div>
	{#if palette.adjusted}
		<div class="text-xs text-muted">
			This colour is a little light for white text, so the buttons use a slightly deeper shade of
			it.
		</div>
	{/if}
	{#if failing.length}
		<p class="text-sm text-danger" role="alert">
			{failing.length} colour {failing.length === 1 ? 'pair does' : 'pairs do'} not reach the contrast
			needed to read comfortably.
		</p>
	{:else}
		<div class="text-xs text-muted" data-testid="palette-contrast">
			Every colour pair reaches the contrast needed to read comfortably.
		</div>
	{/if}
</div>

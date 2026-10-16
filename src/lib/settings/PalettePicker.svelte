<script lang="ts">
	// -- MODULES -- //
	import { paletteVars } from '#lib/theme/css.js';
	import { checkPalette, generatePalette } from '#lib/theme/palette.js';
	import { DEFAULT_ACCENT, PRESETS } from '#lib/theme/presets.js';
	import Button from '#lib/ui/Button.svelte';
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
		<span class="text-xs leading-4 font-medium text-muted" id="palette-label">{label}</span>
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
		<input
			type="color"
			aria-label="Pick a colour"
			value={shown}
			{disabled}
			oninput={(e) => pick(e.currentTarget.value.toLowerCase())}
			class="h-11 w-14 cursor-pointer rounded-lg border border-line bg-surface p-1 disabled:cursor-not-allowed disabled:opacity-50"
		/>
		<Button
			onclick={() => pick(null)}
			disabled={disabled || value === null}
			data-testid="palette-reset">Use the default</Button
		>
	</div>

	<!-- THE LIVE PREVIEW IN BOTH MODES: EACH PANEL CARRIES ITS OWN MODE, SO THE TOKENS OF THAT MODE APPLY INSIDE IT -->
	<div class="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="palette-preview">
		{#each ['light', 'dark'] as const as mode (mode)}
			<!-- DYNAMIC RUNTIME PALETTE VARIABLES -->
			<div
				data-mode={mode}
				data-testid={`preview-${mode}`}
				style={Object.entries(paletteVars(palette, mode))
					.map(([k, v]) => `${k}:${v}`)
					.join(';')}
				class="flex flex-col gap-2 rounded-xl border border-line bg-bg p-3 text-ink"
			>
				<div class="text-xs font-medium text-muted">{mode === 'light' ? 'Light' : 'Dark'}</div>
				<div class="flex flex-wrap items-center gap-2">
					<span
						class="inline-flex h-8 items-center rounded-lg bg-accent px-3 text-sm font-medium text-accent-ink"
						>Primary action</span
					>
					<span
						class="inline-flex items-center rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent-text"
						>Running</span
					>
					<span class="text-sm font-medium text-accent-text underline">A link</span>
				</div>
				<div class="h-1.5 w-full overflow-hidden rounded-full bg-raised">
					<div class="h-full w-2/3 rounded-full bg-accent"></div>
				</div>
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

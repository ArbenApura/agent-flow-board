<script lang="ts">
	// -- DEP-TYPES -- //
	import type { SelectOption } from '#lib/ui/Select.svelte';
	// -- MODULES -- //
	import Select from '#lib/ui/Select.svelte';
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let {
		label,
		options,
		value = $bindable(),
		hint,
		error,
		placeholder,
		onchange,
		class: extra
	}: {
		label: string;
		options: SelectOption[];
		value?: string;
		hint?: string;
		error?: string;
		placeholder?: string;
		onchange?: (value: string) => void;
		class?: string;
	} = $props();
</script>

<div class={cn('flex flex-col gap-1', extra)}>
	<span class="text-xs font-medium text-muted">{label}</span>
	<Select {options} bind:value {label} {placeholder} {onchange} invalid={!!error} />
	{#if error}
		<p role="alert" class="text-xs text-danger">{error}</p>
	{:else if hint}
		<p class="text-xs text-muted">{hint}</p>
	{/if}
</div>

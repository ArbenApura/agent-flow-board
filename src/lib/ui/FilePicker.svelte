<script lang="ts">
	// -- MODULES -- //
	import { cn } from '#lib/ui/cn.js';
	// -- DEP-COMPONENTS -- //
	import Upload from '@lucide/svelte/icons/upload';

	// -- REQUIRED PROPS -- //

	let {
		label,
		hint,
		accept,
		multiple = false,
		required = false,
		disabled = false,
		el = $bindable(),
		onchange,
		onfiles,
		class: extra,
		...rest
	}: {
		label: string;
		/** One line under the field, for example the size limit. */
		hint?: string;
		accept?: string;
		/** Lets the person pick several files at once. They arrive together in onfiles. */
		multiple?: boolean;
		required?: boolean;
		disabled?: boolean;
		/** The native input, so a form can read its files and clear it. */
		el?: HTMLInputElement;
		onchange?: (file: File | undefined) => void;
		/** Every file picked, for a picker that takes several. */
		onfiles?: (files: File[]) => void;
		class?: string;
		'data-testid'?: string;
	} = $props();

	// -- STATES -- //

	let name = $state('');

	// -- CONSTANTS -- //

	const uid = $props.id();
</script>

<!-- THE NATIVE INPUT STAYS FOR THE KEYBOARD AND THE SYSTEM DIALOG, HIDDEN BEHIND A BUTTON AND THE CHOSEN FILE NAME -->
<div class={cn('flex min-w-0 flex-col gap-1.5', extra)}>
	<span class="text-xs font-medium text-ink" id={`${uid}-label`}>{label}</span>
	<div
		class="relative flex min-h-11 items-center gap-3 rounded-lg border border-line bg-surface px-3 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent {disabled
			? 'opacity-50'
			: 'hover:bg-raised'}"
	>
		<Upload size={18} class="shrink-0 text-muted" aria-hidden="true" />
		<span class="min-w-0 flex-1 truncate text-sm {name ? 'text-ink' : 'text-muted'}"
			>{name || (multiple ? 'Choose files' : 'Choose a file')}</span
		>
		<span class="shrink-0 text-sm font-medium text-accent-text">Browse</span>
		<input
			bind:this={el}
			type="file"
			{accept}
			{multiple}
			{required}
			{disabled}
			aria-labelledby={`${uid}-label`}
			class="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
			onchange={(e) => {
				const all = [...(e.currentTarget.files ?? [])];
				const f = all[0];
				name = all.length > 1 ? `${all.length} files` : (f?.name ?? '');
				onchange?.(f);
				onfiles?.(all);
			}}
			{...rest}
		/>
	</div>
	{#if hint}<span class="text-xs text-muted">{hint}</span>{/if}
</div>

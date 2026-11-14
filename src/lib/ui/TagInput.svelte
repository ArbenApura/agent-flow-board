<script lang="ts">
	// IMPORTED MODULES
	import { cn } from '#lib/ui/cn.js';
	// IMPORTED DEP-COMPONENTS
	import X from '@lucide/svelte/icons/x';

	// -- REQUIRED PROPS -- //

	let {
		label,
		tags = $bindable([]),
		hint,
		placeholder = 'Type and press Enter',
		validate,
		onremove,
		removeLabel,
		disabled = false,
		class: extra
	}: {
		label: string;
		tags?: string[];
		hint?: string;
		placeholder?: string;
		/** Returns an error message for a refused tag, or null when it is fine. */
		validate?: (tag: string, current: string[]) => string | null;
		/** Asked before a tag is removed. Returning false keeps it (a confirmation can sit here). */
		onremove?: (tag: string) => boolean | Promise<boolean>;
		/** The accessible name of a tag's remove button, so two lists with the same tag stay apart. */
		removeLabel?: (tag: string) => string;
		/** A person who may only look: no removing, no typing. */
		disabled?: boolean;
		class?: string;
	} = $props();

	// -- CONSTANTS -- //

	const uid = $props.id();

	// -- STATES -- //

	let draft = $state('');
	let error = $state<string | null>(null);

	// -- FUNCTIONS -- //

	function add() {
		const tag = draft.trim();
		if (!tag) return;
		const refusal = validate?.(tag, tags) ?? (tags.includes(tag) ? 'Already added' : null);
		if (refusal) {
			error = refusal;
			return;
		}
		tags = [...tags, tag];
		draft = '';
		error = null;
	}

	async function remove(tag: string) {
		if (disabled) return;
		if (onremove && !(await onremove(tag))) return;
		tags = tags.filter((t) => t !== tag);
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ',') {
			e.preventDefault();
			add();
		} else if (e.key === 'Backspace' && draft === '' && tags.length) {
			void remove(tags[tags.length - 1]);
		}
	}
</script>

<div class={cn('flex flex-col gap-1', extra)}>
	<label for={uid} class="text-xs font-medium text-muted">{label}</label>
	<div
		class={cn(
			'flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border bg-surface px-2 py-1.5 focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-accent',
			error ? 'border-danger' : 'border-line'
		)}
	>
		{#each tags as tag (tag)}
			<span
				class="inline-flex items-center gap-1 rounded-md bg-raised py-0.5 pr-0.5 pl-2 text-xs text-ink"
			>
				{tag}
				{#if !disabled}
					<button
						type="button"
						data-expanded-hit
						class="relative inline-flex size-6 cursor-pointer items-center justify-center rounded text-muted before:absolute before:-inset-2.5 before:content-[''] hover:text-ink"
						aria-label={removeLabel ? removeLabel(tag) : `Remove ${tag}`}
						onclick={() => void remove(tag)}
					>
						<X size={12} />
					</button>
				{:else}
					<span class="pr-1.5"></span>
				{/if}
			</span>
		{/each}
		<input
			id={uid}
			bind:value={draft}
			onkeydown={onKey}
			onblur={add}
			{placeholder}
			{disabled}
			class="h-8 min-w-24 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-muted"
			aria-invalid={error ? 'true' : undefined}
		/>
	</div>
	{#if error}
		<p role="alert" class="text-xs text-danger">{error}</p>
	{:else if hint}
		<p class="text-xs text-muted">{hint}</p>
	{/if}
</div>

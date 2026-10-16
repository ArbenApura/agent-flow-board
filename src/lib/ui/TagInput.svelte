<script lang="ts">
	// -- MODULES -- //
	import { cn } from '#lib/ui/cn.js';
	// -- DEP-COMPONENTS -- //
	import X from 'phosphor-svelte/lib/X';

	// -- REQUIRED PROPS -- //

	let {
		label,
		tags = $bindable([]),
		hint,
		placeholder = 'Type and press Enter',
		validate,
		class: extra
	}: {
		label: string;
		tags?: string[];
		hint?: string;
		placeholder?: string;
		/** Returns an error message for a refused tag, or null when it is fine. */
		validate?: (tag: string, current: string[]) => string | null;
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

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ',') {
			e.preventDefault();
			add();
		} else if (e.key === 'Backspace' && draft === '' && tags.length) {
			tags = tags.slice(0, -1);
		}
	}
</script>

<div class={cn('flex flex-col gap-1', extra)}>
	<label for={uid} class="text-xs leading-4 font-medium text-muted">{label}</label>
	<div
		class={cn(
			'flex min-h-11 flex-wrap items-center gap-1.5 rounded-lg border bg-bg px-2 py-1.5 focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-accent',
			error ? 'border-danger' : 'border-line'
		)}
	>
		{#each tags as tag (tag)}
			<span
				class="inline-flex items-center gap-1 rounded-md bg-raised py-0.5 pr-0.5 pl-2 text-xs leading-4 text-ink"
			>
				{tag}
				<button
					type="button"
					data-expanded-hit
					class="relative inline-flex size-6 cursor-pointer items-center justify-center rounded text-muted before:absolute before:-inset-2.5 before:content-[''] hover:text-ink"
					aria-label={`Remove ${tag}`}
					onclick={() => (tags = tags.filter((t) => t !== tag))}
				>
					<X size={12} />
				</button>
			</span>
		{/each}
		<input
			id={uid}
			bind:value={draft}
			onkeydown={onKey}
			onblur={add}
			{placeholder}
			class="h-8 min-w-24 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-muted"
			aria-invalid={error ? 'true' : undefined}
		/>
	</div>
	{#if error}
		<p role="alert" class="text-xs leading-4 text-danger">{error}</p>
	{:else if hint}
		<p class="text-xs leading-4 text-muted">{hint}</p>
	{/if}
</div>

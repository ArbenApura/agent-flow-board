<script lang="ts">
	// IMPORTED MODULES
	import { cn } from '#lib/ui/cn.js';
	import { strengthOf } from '#lib/ui/passwordStrength.js';

	// -- REQUIRED PROPS -- //

	let { value, min = 10, class: extra }: { value: string; min?: number; class?: string } = $props();

	// -- REACTIVE STATES -- //

	const s = $derived(strengthOf(value, min));
</script>

<!-- A FOUR PART METER UNDER A NEW PASSWORD FIELD. IT ADVISES, IT NEVER BLOCKS: THE SERVER KEEPS THE ONE RULE (THE MINIMUM LENGTH) -->
{#if value}
	<div class={cn('flex flex-col gap-1', extra)} data-testid="password-strength">
		<div class="flex gap-1" aria-hidden="true">
			{#each [1, 2, 3, 4] as n (n)}
				<span
					class={cn(
						'h-1 flex-1 rounded-full transition-colors',
						// One background class per segment, so two utilities never compete
						n > s.score && 'bg-raised',
						n <= s.score && s.tone === 'danger' && 'bg-danger',
						n <= s.score && s.tone === 'warning' && 'bg-warning',
						n <= s.score && s.tone === 'success' && 'bg-success'
					)}
				></span>
			{/each}
		</div>
		<p
			class={cn(
				'text-xs',
				s.tone === 'danger' && 'text-danger',
				s.tone === 'warning' && 'text-warning',
				s.tone === 'success' && 'text-success'
			)}
			role="status"
		>
			{s.label}
		</p>
	</div>
{/if}

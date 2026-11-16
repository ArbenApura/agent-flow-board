<script lang="ts">
	// IMPORTED CONSTANTS
	import { ROLE_ICON } from './memberModel.js';
	import { ROLE_INFO, ROLE_LABEL, ROLES } from '#lib/shared/roles.js';
	// IMPORTED DEP-COMPONENTS
	import Info from '@lucide/svelte/icons/info';
	// IMPORTED COMPONENTS
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';

	// -- REQUIRED PROPS -- //

	let { open, onclose }: { open: boolean; onclose: () => void } = $props();
</script>

<!-- WHAT EACH ROLE MEANS, IN PLAIN WORDS, FOR ANYONE WHO IS ABOUT TO GIVE ONE -->
<ResponsiveModal {open} {onclose} title="What the roles mean" size="lg">
	<div class="flex flex-col gap-4">
		<ul class="overflow-hidden rounded-lg border border-line">
			{#each ROLES as r (r)}
				{@const Icon = ROLE_ICON[r]}
				<li class="flex flex-wrap items-start gap-3 border-b border-line px-3 py-3 last:border-b-0">
					<span
						class="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-raised text-muted"
					>
						<Icon size={16} />
					</span>
					<div class="min-w-40 flex-1">
						<span class="block text-sm font-medium text-ink">{ROLE_LABEL[r]}</span>
						<span class="block text-xs text-muted">{ROLE_INFO[r].description}</span>
						<span class="mt-1.5 flex flex-wrap gap-1.5">
							{#each ROLE_INFO[r].scope as chip (chip)}<Badge>{chip}</Badge>{/each}
						</span>
					</div>
				</li>
			{/each}
		</ul>
		<p class="flex items-start gap-2 text-xs text-muted">
			<Info size={14} class="mt-0.5 shrink-0" />
			<span>
				Owners and admins keep their role in every project. A single project can give a member,
				viewer or guest a different role there, from Project access.
			</span>
		</p>
	</div>
	{#snippet footer()}
		<Button variant="secondary" onclick={onclose}>Close</Button>
	{/snippet}
</ResponsiveModal>

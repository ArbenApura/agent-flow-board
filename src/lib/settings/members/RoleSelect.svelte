<script lang="ts">
	// IMPORTED TYPES
	import type { Role } from '#lib/shared/roles.js';
	// IMPORTED CONSTANTS
	import { ROLE_ICON } from './memberModel.js';
	import {
		ROLE_INFO,
		ROLE_LABEL,
		ROLES,
		canAssignRole,
		whyNotAssignable
	} from '#lib/shared/roles.js';
	// IMPORTED DEP-COMPONENTS
	import Check from '@lucide/svelte/icons/check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import CircleHelp from '@lucide/svelte/icons/circle-help';
	import Lock from '@lucide/svelte/icons/lock';
	// IMPORTED COMPONENTS
	import Popover from '#lib/ui/Popover.svelte';
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let {
		name,
		role,
		viewerRole,
		onpick,
		onguide
	}: {
		/** Whose role it is, for the heading and the label of the button. */
		name: string;
		role: Role;
		/** The role of the person looking: it decides which roles are offered. */
		viewerRole: Role;
		onpick: (role: Role) => void;
		onguide: () => void;
	} = $props();

	// -- STATES -- //

	let open = $state(false);

	// -- REACTIVE STATES -- //

	const Current = $derived(ROLE_ICON[role]);
</script>

<!-- THE ROLE BUTTON AND ITS MENU: EVERY ROLE WITH WHAT IT MEANS, THE ONES THIS PERSON MAY NOT GIVE DIMMED WITH THE REASON -->
<Popover
	bind:open
	placement="bottom-start"
	role="menu"
	label={`Role of ${name}`}
	offset={6}
	class="max-h-[min(36rem,calc(100vh-24px))] w-[340px] max-w-[calc(100vw-1.5rem)]"
>
	{#snippet trigger({ props, toggle })}
		<button
			type="button"
			onclick={toggle}
			aria-label={`Role of ${name}`}
			{...props}
			class="inline-flex h-10 w-36 cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface px-3 text-sm text-ink shadow-[var(--elev-1)] transition-[border-color] duration-150 hover:border-muted focus-visible:border-accent focus-visible:ring-4 focus-visible:ring-accent-soft focus-visible:outline-none max-sm:h-11"
		>
			<Current size={16} class="shrink-0 text-muted" />
			<span class="flex-1 truncate text-left">{ROLE_LABEL[role]}</span>
			<ChevronDown size={16} class="shrink-0 text-muted" />
		</button>
	{/snippet}
	{#snippet children({ close })}
		<div class="px-3 pt-2 pb-1.5 text-xs font-medium text-muted">Role of {name}</div>
		{#each ROLES as r (r)}
			{@const allowed = canAssignRole(viewerRole, role, r)}
			{@const selected = r === role}
			{@const Icon = ROLE_ICON[r]}
			<button
				type="button"
				role="menuitemradio"
				aria-checked={selected}
				aria-disabled={!allowed}
				onclick={() => {
					if (!allowed) return;
					close();
					if (!selected) onpick(r);
				}}
				class={cn(
					'flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left',
					allowed ? 'cursor-pointer hover:bg-raised' : 'cursor-not-allowed opacity-55',
					selected && 'bg-accent-soft hover:bg-accent-soft'
				)}
			>
				<span
					class={cn(
						'mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg',
						selected ? 'bg-accent text-accent-ink' : 'bg-raised text-muted'
					)}
				>
					<Icon size={16} />
				</span>
				<span class="min-w-0 flex-1">
					<span class="flex items-center gap-1.5 text-sm font-medium text-ink">
						{ROLE_LABEL[r]}
						{#if !allowed}<Lock size={12} class="text-muted" aria-hidden="true" />{/if}
					</span>
					<span class="block text-xs text-muted">
						{allowed ? ROLE_INFO[r].description : whyNotAssignable(viewerRole, r)}
					</span>
				</span>
				{#if selected}<Check size={16} class="mt-1.5 shrink-0 text-accent-text" />{/if}
			</button>
		{/each}
		<div class="mt-1 border-t border-line p-1">
			<button
				type="button"
				onclick={() => {
					close();
					onguide();
				}}
				class="flex min-h-10 w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-xs text-muted hover:bg-raised hover:text-ink max-sm:min-h-11"
			>
				<CircleHelp size={14} /> What the roles mean
			</button>
		</div>
	{/snippet}
</Popover>

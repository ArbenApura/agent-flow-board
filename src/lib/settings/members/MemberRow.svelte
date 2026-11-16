<script lang="ts">
	// IMPORTED TYPES
	import type { Role } from '#lib/shared/roles.js';
	import type { MemberView } from './memberModel.js';
	// IMPORTED CONSTANTS
	import { ROLE_ICON, TABLE_ROW } from './memberModel.js';
	import { ROLE_LABEL, canManageMembers, memberLock } from '#lib/shared/roles.js';
	// IMPORTED MODULES
	import { formatUtcDate } from '#lib/board/when.js';
	import { cn } from '#lib/ui/cn.js';
	// IMPORTED DEP-COMPONENTS
	import Folder from '@lucide/svelte/icons/folder';
	import Lock from '@lucide/svelte/icons/lock';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	// IMPORTED COMPONENTS
	import Avatar from '#lib/ui/Avatar.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import MoreMenu from './MoreMenu.svelte';
	import RoleSelect from './RoleSelect.svelte';

	// -- REQUIRED PROPS -- //

	let {
		person,
		viewerRole,
		viewerId,
		access,
		flash = false,
		ownerCount = 1,
		onrole,
		onremove,
		onaccess,
		onguide
	}: {
		person: MemberView;
		viewerRole: Role;
		viewerId: string;
		/** The access line: All projects, 4 projects, 1 shared project. Empty for a person who cannot see project roles. */
		access: string;
		/** True for a moment after this person's role changed, so the row shows where it happened. */
		flash?: boolean;
		/** How many owners the organisation has: with more than one, an owner may step down. */
		ownerCount?: number;
		onrole: (role: Role) => void;
		onremove: () => void;
		onaccess: () => void;
		onguide: () => void;
	} = $props();

	// -- STATES -- //

	/** On while the tint is applied at once, off while it fades away. */
	let tinted = $state(false);

	// -- REACTIVE STATES -- //

	const lock = $derived(memberLock(viewerRole, viewerId, person, ownerCount));
	const mine = $derived(person.userId === viewerId);
	const edit = $derived(canManageMembers(viewerRole) && !lock);
	// An owner or admin is that role in every project, so there is no per project sheet for them
	const fixed = $derived(person.role === 'owner' || person.role === 'admin');
	const joined = $derived(person.joinedAt ? formatUtcDate(person.joinedAt) : '');
	const RoleIcon = $derived(ROLE_ICON[person.role]);

	// -- REACTIVE STATEMENTS -- //

	// The tint goes on at once and fades off over 1.2 seconds, so a changed row is easy to find
	$effect(() => {
		if (!flash) return;
		tinted = true;
		let inner = 0;
		const outer = requestAnimationFrame(
			() => (inner = requestAnimationFrame(() => (tinted = false)))
		);
		return () => {
			cancelAnimationFrame(outer);
			cancelAnimationFrame(inner);
		};
	});
</script>

<!-- ONE ROW OF THE MEMBERS TABLE. EVERY ROW IS TWO LINES AND USES THE SAME FOUR COLUMNS AS THE HEADER LINE -->
<li
	data-item
	data-row
	data-testid="member"
	class={cn(
		TABLE_ROW,
		tinted
			? 'bg-accent-soft'
			: 'transition-colors duration-[1200ms] ease-out motion-reduce:transition-none'
	)}
>
	<!-- PERSON -->
	<div class="flex min-w-0 items-center gap-3">
		<span class="inline-flex shrink-0 items-center">
			<Avatar name={person.name} userId={person.userId} v={person.imageV} />
		</span>
		<div class="min-w-0 flex-1 text-sm">
			<span class="block truncate font-medium text-ink">
				{person.name}
				{#if mine}<Badge tone="accent" class="ml-1.5 align-middle">You</Badge>{/if}
			</span>
			<span class="block truncate text-xs text-muted">{person.email}</span>
			<!-- ON A PHONE THE THIRD LINE SAYS WHY A ROW IS LOCKED, OR WHEN THEY JOINED -->
			{#if lock}
				<span class="flex items-start gap-1.5 text-xs text-muted md:hidden">
					<Lock size={12} class="mt-1 shrink-0" aria-hidden="true" />
					<span>{lock.reason}</span>
				</span>
			{:else}
				<span class="block truncate text-xs text-muted md:hidden">
					{[joined ? `Joined ${joined}` : '', access].filter(Boolean).join(' · ')}
				</span>
			{/if}
		</div>
	</div>

	<!-- ROLE AND MORE: ONE GROUP ON A PHONE, TWO COLUMNS OF THE GRID FROM MD UP -->
	<div class="flex items-center gap-2 max-md:w-full max-md:pl-11 md:contents">
		{#if edit}
			<RoleSelect name={person.name} role={person.role} {viewerRole} onpick={onrole} {onguide} />
			<div class="md:order-4">
				<MoreMenu label={`More for ${person.name}`} heading={person.name}>
					{#snippet items({ close })}
						{#if fixed}
							<div class="flex min-h-10 w-full items-center gap-2.5 px-3 text-sm text-muted">
								<Folder size={16} class="shrink-0" />
								{ROLE_LABEL[person.role]} in every project
							</div>
						{:else}
							<button
								type="button"
								role="menuitem"
								onclick={() => {
									close();
									onaccess();
								}}
								class="flex min-h-10 w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 text-left text-sm text-ink hover:bg-raised max-sm:min-h-11"
							>
								<Folder size={16} class="shrink-0 text-muted" /> Project access
							</button>
						{/if}
						<div class="my-1 border-t border-line"></div>
						<button
							type="button"
							role="menuitem"
							onclick={() => {
								close();
								onremove();
							}}
							class="flex min-h-10 w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 text-left text-sm text-danger hover:bg-raised max-sm:min-h-11"
						>
							<Trash2 size={16} class="shrink-0" /> Remove from organisation
						</button>
					{/snippet}
				</MoreMenu>
			</div>
		{:else}
			<!-- A ROW THAT CANNOT BE CHANGED SHOWS THE ROLE AS PLAIN ICON AND NAME, IN THE SAME COLUMN AS THE ROLE BUTTON -->
			<span class="inline-flex h-10 w-36 items-center gap-2 px-3 text-sm text-muted max-sm:h-11">
				<RoleIcon size={16} class="shrink-0" />
				<span class="truncate">{ROLE_LABEL[person.role]}</span>
			</span>
			<span aria-hidden="true" class="size-10 max-md:hidden md:order-4"></span>
		{/if}
	</div>

	<!-- ACCESS: THE PROJECTS THEY CAN OPEN OVER THE DATE THEY JOINED, OR THE SHORT REASON A ROW IS LOCKED -->
	<div class="hidden min-w-0 text-sm md:order-3 md:block" title={lock?.reason}>
		{#if lock}
			<span class="flex items-center gap-1.5 truncate text-muted">
				<Lock size={14} class="shrink-0" aria-hidden="true" />
				{lock.short}
			</span>
		{:else if access}
			<span class="block truncate text-ink">{access}</span>
		{/if}
		{#if joined}<span class="block truncate text-xs text-muted">Joined {joined}</span>{/if}
	</div>
</li>

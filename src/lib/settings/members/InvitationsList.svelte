<script lang="ts">
	// IMPORTED TYPES
	import type { InviteView, MemberView } from './memberModel.js';
	// IMPORTED CONSTANTS
	import { ROLE_ICON, TABLE_ROW } from './memberModel.js';
	import { ROLE_LABEL } from '#lib/shared/roles.js';
	// IMPORTED MODULES
	import { ago } from '#lib/board/status.js';
	// IMPORTED DEP-COMPONENTS
	import Lock from '@lucide/svelte/icons/lock';
	import Mail from '@lucide/svelte/icons/mail';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import UserPlus from '@lucide/svelte/icons/user-plus';
	// IMPORTED COMPONENTS
	import Button from '#lib/ui/Button.svelte';
	import MoreMenu from './MoreMenu.svelte';
	import TableHead from './TableHead.svelte';

	// -- REQUIRED PROPS -- //

	let {
		invites,
		members,
		oninvite,
		onwithdraw
	}: {
		invites: InviteView[];
		/** Where the name of the person who sent an invitation is read from. */
		members: MemberView[];
		oninvite: () => void;
		onwithdraw: (invite: InviteView) => void;
	} = $props();

	// -- FUNCTIONS -- //

	// A person who sent an invitation and has left is still named plainly, never as a blank
	const sender = (i: InviteView) =>
		members.find((m) => m.userId === i.invitedBy)?.name ?? 'Someone who has left';
</script>

<!-- PENDING INVITATIONS. THE SAME FOUR COLUMNS AS THE MEMBERS TABLE: WHO WAS INVITED, THEIR ROLE, WHO SENT IT AND WHEN, MORE -->
{#if invites.length}
	<ul class="overflow-hidden rounded-lg border border-line" data-testid="invite-list">
		<TableHead person="Invited" role="Role" access="Sent" />
		{#each invites as i (i.id)}
			{@const RoleIcon = ROLE_ICON[i.role]}
			<li data-item data-row class={TABLE_ROW}>
				<div class="flex min-w-0 items-center gap-3">
					<span class="inline-flex shrink-0 items-center">
						<span
							class="inline-flex size-8 items-center justify-center rounded-full border border-dashed border-line text-muted"
							aria-hidden="true"><Mail size={16} /></span
						>
					</span>
					<div class="min-w-0 flex-1 text-sm">
						<span class="block truncate font-medium text-ink">{i.email}</span>
						<span class="block truncate text-xs text-muted max-md:hidden">Waiting for a reply</span>
						<span class="block truncate text-xs text-muted md:hidden">
							Sent {ago(i.createdAt)} by {sender(i)}
						</span>
					</div>
				</div>
				<div class="flex items-center gap-2 max-md:w-full max-md:pl-11 md:contents">
					<span
						class="inline-flex h-10 w-36 items-center gap-2 px-3 text-sm text-muted max-sm:h-11"
					>
						<RoleIcon size={16} class="shrink-0" />
						<span class="truncate">{ROLE_LABEL[i.role]}</span>
					</span>
					<div class="md:order-4">
						<MoreMenu label={`More for ${i.email}`} heading={i.email}>
							{#snippet items({ close })}
								<button
									type="button"
									role="menuitem"
									onclick={() => {
										close();
										onwithdraw(i);
									}}
									class="flex min-h-10 w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 text-left text-sm text-danger hover:bg-raised max-sm:min-h-11"
								>
									<Trash2 size={16} class="shrink-0" /> Withdraw invitation
								</button>
							{/snippet}
						</MoreMenu>
					</div>
				</div>
				<div class="hidden min-w-0 text-sm md:order-3 md:block">
					<span class="block truncate text-ink">{sender(i)}</span>
					<span class="block truncate text-xs text-muted">{ago(i.createdAt)}</span>
				</div>
			</li>
		{/each}
	</ul>
	<p class="flex items-center gap-2 text-xs text-muted">
		<Lock size={14} class="shrink-0" aria-hidden="true" />
		Each link is mailed once and works only for the address it was sent to.
	</p>
{:else}
	<!-- NOTHING WAITING -->
	<div
		class="flex flex-col items-center gap-1 rounded-lg border border-dashed border-line px-4 py-10 text-center"
	>
		<span
			class="mb-1 inline-flex size-10 items-center justify-center rounded-full bg-raised text-muted"
		>
			<Mail size={20} />
		</span>
		<p class="text-sm font-medium text-ink">No invitations waiting</p>
		<p class="mb-3 max-w-sm text-xs text-muted">
			When you invite someone, they show here until they reply or you withdraw the invitation.
		</p>
		<Button onclick={oninvite}><UserPlus size={16} /> Invite people</Button>
	</div>
{/if}

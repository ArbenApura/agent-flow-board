<script lang="ts">
	// IMPORTED TYPES
	import type { Role } from '#lib/shared/roles.js';
	// IMPORTED CONSTANTS
	import { ROLE_ICON, looksLikeEmail, splitEmails } from './memberModel.js';
	import {
		ROLE_INFO,
		ROLE_LABEL,
		ROLES,
		canAssignRole,
		whyNotAssignable
	} from '#lib/shared/roles.js';
	// IMPORTED DEP-MODULES
	import { untrack } from 'svelte';
	// IMPORTED MODULES
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import { cn } from '#lib/ui/cn.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	// IMPORTED DEP-COMPONENTS
	import Check from '@lucide/svelte/icons/check';
	import Lock from '@lucide/svelte/icons/lock';
	import Mail from '@lucide/svelte/icons/mail';
	import Send from '@lucide/svelte/icons/send';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import X from '@lucide/svelte/icons/x';
	// IMPORTED COMPONENTS
	import Button from '#lib/ui/Button.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';

	// -- REQUIRED PROPS -- //

	let {
		open,
		onclose,
		org,
		viewerRole,
		allowGuests,
		onsent
	}: {
		/** Always mounted with this flag, so the dialog fades out. */
		open: boolean;
		onclose: () => void;
		/** The organisation address, for the invitations API. */
		org: string;
		/** The role of the person inviting: it decides which role cards can be chosen. */
		viewerRole: Role;
		/** The organisation setting that lets guests be invited at all. */
		allowGuests: boolean;
		/** Runs after at least one invitation was sent, so the page reads the waiting list again. */
		onsent: () => void | Promise<void>;
	} = $props();

	// -- STATES -- //

	let chips = $state<string[]>([]);
	let draft = $state('');
	let role = $state<Role>('member');
	let busy = $state(false);
	/** Why some addresses were not sent, in plain words. Their chips stay so they can be fixed. */
	let failure = $state('');
	let input = $state<HTMLInputElement>();
	let prevOpen = false;

	// -- REACTIVE STATES -- //

	const invalid = $derived(chips.filter((c) => !looksLikeEmail(c)));
	const valid = $derived(chips.filter((c) => looksLikeEmail(c)));
	const sendLabel = $derived(
		valid.length > 1 ? `Send ${valid.length} invitations` : 'Send invitation'
	);

	// -- REACTIVE STATEMENTS -- //

	// A fresh dialog each time it opens. The writes are untracked, so typing is never wiped by this effect running again
	$effect(() => {
		const now = open;
		if (now && !prevOpen) {
			untrack(() => {
				chips = [];
				draft = '';
				role = 'member';
				failure = '';
			});
		}
		prevOpen = now;
	});

	$effect(() => {
		if (open && input) input.focus();
	});

	// -- FUNCTIONS -- //

	/** Why a role card cannot be chosen, or an empty string. */
	function blocked(r: Role): string {
		if (r === 'guest' && !allowGuests) return 'Guests are switched off in Security limits.';
		return canAssignRole(viewerRole, null, r) ? '' : whyNotAssignable(viewerRole, r);
	}

	function add(raw: string) {
		// Addresses are not case sensitive, so A@x.io and a@x.io are one chip
		for (const email of splitEmails(raw).map((e) => e.toLowerCase()))
			if (!chips.includes(email)) chips.push(email);
		draft = '';
		failure = '';
	}

	function onkey(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
			if (draft.trim()) {
				e.preventDefault();
				add(draft);
			} else if (e.key === 'Enter') e.preventDefault();
		} else if (e.key === 'Backspace' && !draft && chips.length) {
			chips.pop();
		}
	}

	function onpaste(e: ClipboardEvent) {
		const text = e.clipboardData?.getData('text') ?? '';
		// Several addresses pasted at once become several chips
		if (splitEmails(text).length > 1) {
			e.preventDefault();
			add(text);
		}
	}

	async function send() {
		// A second press while the first is running, or a role that stopped being allowed meanwhile, sends nothing
		if (busy || blocked(role)) return;
		if (draft.trim()) add(draft);
		if (!valid.length || invalid.length) return;
		busy = true;
		failure = '';
		const sent: string[] = [];
		const problems: string[] = [];
		// One invitation for each address, one after the other, so a refusal names the address it belongs to
		for (const email of valid) {
			try {
				const r = await api<{ emailFailed?: boolean; data?: { emailFailed?: boolean } }>(
					org,
					'/invites',
					{ body: { email, role }, key: newKey() }
				);
				sent.push(email);
				if (r?.emailFailed ?? r?.data?.emailFailed)
					toast.warning(`The invitation for ${email} was made, but the email could not be sent.`);
			} catch (e) {
				problems.push(`${email}: ${e instanceof ApiError ? e.message : 'That did not work.'}`);
			}
		}
		busy = false;
		if (sent.length) {
			toast.success(sent.length > 1 ? `${sent.length} invitations sent.` : 'Invitation sent.');
			chips = chips.filter((c) => !sent.includes(c));
			try {
				await onsent();
			} catch {
				// The invitations were sent. Reading the page again failed, and the dialog still closes or says what is left
			}
		}
		if (problems.length) failure = problems.join(' ');
		else onclose();
	}
</script>

<!-- INVITE PEOPLE: ADDRESSES AS CHIPS, THE ROLE AS CARDS. ONLY WHAT THE PERSON INVITING MAY GIVE CAN BE CHOSEN -->
<ResponsiveModal {open} {onclose} title="Invite people" {busy} size="lg">
	<div class="flex flex-col gap-5">
		<!-- ADDRESSES -->
		<div class="flex flex-col gap-1.5">
			<label for="invite-addresses" class="text-xs font-medium text-ink">Email addresses</label>
			<div
				class="flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-line bg-surface p-1.5 shadow-[var(--elev-1)] transition-[border-color,box-shadow] duration-150 focus-within:border-accent focus-within:ring-4 focus-within:ring-accent-soft hover:border-muted"
				data-testid="invite-chips"
			>
				{#each chips as chip (chip)}
					<span
						class={cn(
							'inline-flex h-7 items-center gap-1 rounded-full pr-1 pl-2.5 text-xs',
							looksLikeEmail(chip) ? 'bg-raised text-ink' : 'bg-danger-soft text-danger'
						)}
					>
						{chip}
						<button
							type="button"
							aria-label={`Remove ${chip}`}
							onclick={() => (chips = chips.filter((c) => c !== chip))}
							class="inline-flex size-5 cursor-pointer items-center justify-center rounded-full hover:bg-ink/10"
						>
							<X size={12} />
						</button>
					</span>
				{/each}
				<input
					id="invite-addresses"
					bind:this={input}
					bind:value={draft}
					type="email"
					autocomplete="off"
					placeholder={chips.length ? '' : 'name@company.com'}
					onkeydown={onkey}
					{onpaste}
					onblur={() => draft.trim() && add(draft)}
					data-testid="invite-email"
					class="h-7 min-w-32 flex-1 bg-transparent px-1.5 text-sm text-ink outline-none placeholder:text-muted"
				/>
			</div>
			{#if invalid.length}
				<p role="alert" class="text-xs text-danger">
					“{invalid[0]}” is not an email address. Fix or remove it to send.
				</p>
			{/if}
			{#if failure}<p role="alert" class="text-xs text-danger">{failure}</p>{/if}
			<p class="text-xs text-muted">
				Separate several addresses with a comma or a space. Each person gets their own link.
			</p>
		</div>

		<!-- ROLE -->
		<fieldset class="flex flex-col gap-2">
			<legend class="mb-1.5 text-xs font-medium text-ink">Role</legend>
			<div role="radiogroup" aria-label="Role of the invited people" class="flex flex-col gap-2">
				{#each ROLES as r (r)}
					{@const why = blocked(r)}
					{@const on = role === r && !why}
					{@const Icon = ROLE_ICON[r]}
					<button
						type="button"
						role="radio"
						aria-checked={on}
						aria-disabled={!!why}
						onclick={() => {
							if (!why) role = r;
						}}
						class={cn(
							'flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
							on
								? 'border-accent bg-accent-soft'
								: why
									? 'cursor-not-allowed border-line bg-surface opacity-55'
									: 'cursor-pointer border-line bg-surface hover:bg-raised'
						)}
					>
						<span
							class={cn(
								'mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg',
								on ? 'bg-accent text-accent-ink' : 'bg-raised text-muted'
							)}
						>
							<Icon size={16} />
						</span>
						<span class="min-w-0 flex-1">
							<span class="flex items-center gap-1.5 text-sm font-medium text-ink">
								{ROLE_LABEL[r]}
								{#if why}<Lock size={12} class="text-muted" aria-hidden="true" />{/if}
							</span>
							<span class="block text-xs text-muted">{why || ROLE_INFO[r].description}</span>
						</span>
						<span
							class={cn(
								'mt-1 inline-flex size-4 shrink-0 items-center justify-center rounded-full border',
								on ? 'border-accent bg-accent text-accent-ink' : 'border-line'
							)}
						>
							{#if on}<Check size={10} />{/if}
						</span>
					</button>
				{/each}
			</div>
			{#if role === 'owner' && !blocked('owner')}
				<div
					class="flex items-start gap-2.5 rounded-lg bg-warning-soft px-3 py-2.5 text-xs text-warning"
				>
					<TriangleAlert size={16} class="mt-0.5 shrink-0" />
					<span>
						An owner can do everything you can, including changing other owners and deleting this
						organisation.
					</span>
				</div>
			{/if}
		</fieldset>

		<p class="flex items-start gap-2 text-xs text-muted">
			<Mail size={14} class="mt-0.5 shrink-0" />
			<span>
				They get an email with a link that works once and only for that address. You can withdraw it
				from the waiting list until they reply.
			</span>
		</p>
	</div>
	{#snippet footer()}
		<Button variant="secondary" disabled={busy} onclick={onclose}>Cancel</Button>
		<Button
			variant="primary"
			loading={busy}
			disabled={!valid.length || invalid.length > 0}
			onclick={send}
			data-testid="invite-submit"
		>
			<Send size={16} />
			{sendLabel}
		</Button>
	{/snippet}
</ResponsiveModal>

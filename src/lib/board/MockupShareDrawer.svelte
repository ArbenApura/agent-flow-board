<script lang="ts">
	// -- MODULES -- //
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import Button from '#lib/ui/Button.svelte';
	import Notice from '#lib/ui/Notice.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import Switch from '#lib/ui/Switch.svelte';
	import { askConfirm } from '#lib/ui/confirm.svelte.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	// -- DEP-COMPONENTS -- //
	import Copy from '@lucide/svelte/icons/copy';

	// -- REQUIRED PROPS -- //

	let {
		open,
		onclose,
		org,
		mockupId,
		linkOn,
		blocked,
		canManage,
		onchange
	}: {
		open: boolean;
		onclose: () => void;
		org: string;
		mockupId: string;
		/** The public link is on right now. */
		linkOn: boolean;
		/** The mockup belongs to a private plan, so it cannot have a public link. */
		blocked: boolean;
		/** Only admins and owners switch the link on or off. */
		canManage: boolean;
		/** Called after a change, so the page reads the mockup again. */
		onchange: () => Promise<void>;
	} = $props();

	// -- STATES -- //

	let busy = $state(false);
	/** Bumped when a switch change did not happen, so the switch is drawn again in its true position. */
	let nonce = $state(0);
	/** The address exists in clear text only in the answer that made it, so it is kept here until the drawer is closed. */
	let address = $state<string | null>(null);

	// -- FUNCTIONS -- //

	async function setLink(on: boolean) {
		busy = true;
		try {
			const res = await toast.promise(
				api<{ url: string | null }>(org, `/mockups/${mockupId}/public-link`, {
					method: 'POST',
					body: { on },
					key: newKey()
				}),
				{
					loading: on ? 'Switching the link on...' : 'Switching the link off...',
					success: on ? 'The public link is on.' : 'The public link is off.',
					error: (e) => (e instanceof ApiError ? e.message : 'The link was not changed.')
				}
			);
			address = on ? (res.url ?? null) : null;
			await onchange();
		} catch {
			// The promise toast already shows the failure
			nonce++;
		} finally {
			busy = false;
		}
	}

	/** Switching on asks first: anyone with the address can see the mockup without signing in, until it is switched off. */
	async function toggle(next: boolean) {
		if (!next) return setLink(false);
		const yes = await askConfirm({
			title: 'Switch the public link on?',
			body: 'Anyone who has the address can look at this mockup without signing in, and cannot change it. It stays on until you switch it off. It goes off by itself if the plan becomes private or this mockup goes to the trash.',
			confirmLabel: 'Switch it on'
		});
		if (yes) await setLink(true);
		else nonce++;
	}

	async function copy() {
		if (!address) return;
		try {
			await navigator.clipboard.writeText(address);
			toast.success('Link copied.');
		} catch {
			toast.error('The link could not be copied. Select it and copy by hand.');
		}
	}

	// -- REACTIVE STATEMENTS -- //

	// A closed drawer forgets the address, which the server cannot show again
	$effect(() => {
		if (!open) address = null;
	});
</script>

<!-- SHARE: THE PUBLIC LINK. VIEW ONLY, OFF BY DEFAULT, A NEW ADDRESS EVERY TIME IT IS SWITCHED ON -->
<ResponsiveModal {open} {onclose} title="Share" variant="drawer" {busy}>
	<div class="flex flex-col gap-4">
		{#if blocked}
			<Notice tone="warning" data-testid="share-blocked">
				This mockup belongs to a private plan, so it cannot have a public link. Make the plan public
				first.
			</Notice>
		{/if}
		{#key nonce}
			<Switch
				label="Public link"
				hint="Anyone with the address can look, without signing in. They cannot change anything."
				checked={linkOn}
				disabled={!canManage || blocked || busy}
				onchange={(v) => toggle(v)}
			/>
		{/key}
		{#if !canManage}
			<p class="text-sm text-muted">Only an admin or owner can switch the public link on or off.</p>
		{/if}
		{#if linkOn && address}
			<div class="flex flex-col gap-2" data-testid="share-address">
				<p class="text-xs font-medium text-ink">Address</p>
				<p
					class="rounded-lg border border-line bg-raised px-3 py-2 font-mono text-xs [overflow-wrap:anywhere] text-ink"
				>
					{address}
				</p>
				<div><Button onclick={copy}><Copy size={16} /> Copy the link</Button></div>
				<p class="text-xs text-muted">Copy it now. The address is shown only when it is made.</p>
			</div>
		{:else if linkOn}
			<div class="flex flex-col gap-2">
				<p class="text-sm text-muted">
					The link is on. For safety the board keeps only a fingerprint of the address, so it cannot
					show it again. Make a new address to see one. The old address stops at once.
				</p>
				{#if canManage}
					<div>
						<Button disabled={busy} onclick={() => setLink(true)} data-testid="share-new-address"
							>Make a new address</Button
						>
					</div>
				{/if}
			</div>
		{/if}
	</div>
</ResponsiveModal>

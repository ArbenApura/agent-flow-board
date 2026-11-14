<script lang="ts">
	// IMPORTED MODULES
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import { askConfirm } from '#lib/ui/confirm.svelte.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	// IMPORTED DEP-COMPONENTS
	import Copy from '@lucide/svelte/icons/copy';
	// IMPORTED COMPONENTS
	import Button from '#lib/ui/Button.svelte';
	import Notice from '#lib/ui/Notice.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import Switch from '#lib/ui/Switch.svelte';

	// -- REQUIRED PROPS -- //

	let {
		open,
		onclose,
		org,
		project,
		note,
		linkOn,
		blocked,
		canManage,
		onchange
	}: {
		open: boolean;
		onclose: () => void;
		org: string;
		/** The project key. */
		project: string;
		/** The note reference, for example N-12. */
		note: string;
		/** The public link is on right now. */
		linkOn: boolean;
		/** The note is private, so it cannot have a public link. */
		blocked: boolean;
		/** Only people who manage the project switch the link on or off. */
		canManage: boolean;
		/** Called after a change, so the page reads the note again. */
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
				api<{ url: string | null; token: string | null }>(
					org,
					`/projects/${project}/notes/${note}/public-link`,
					{ method: 'POST', body: { on }, key: newKey() }
				),
				{
					loading: on ? 'Switching the link on...' : 'Switching the link off...',
					success: on ? 'The public link is on.' : 'The public link is off.',
					error: (e) => (e instanceof ApiError ? e.message : 'The link was not changed.')
				}
			);
			// A server with no public address of its own answers the token only, so the page builds the address
			address = on ? (res.url ?? (res.token ? `${location.origin}/n/${res.token}` : null)) : null;
			await onchange();
		} catch {
			// The promise toast already shows the failure
			nonce++;
		} finally {
			busy = false;
		}
	}

	/** Switching on asks first: anyone with the address can read the note without signing in, until it is switched off. */
	async function toggle(next: boolean) {
		if (!next) return setLink(false);
		const yes = await askConfirm({
			title: 'Switch the public link on?',
			body: 'Anyone who has the address can read this note without signing in, and cannot change it. It stays on until you switch it off. It goes off by itself if the note becomes private or goes to the trash, and a restore does not switch it back on.',
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
				This note is private, so it cannot have a public link. Share it with the project first.
			</Notice>
		{/if}
		{#key nonce}
			<Switch
				label="Public link"
				hint="Anyone with the address can read, without signing in. They cannot change anything."
				checked={linkOn}
				disabled={!canManage || blocked || busy}
				onchange={(v) => toggle(v)}
			/>
		{/key}
		{#if !canManage}
			<p class="text-sm text-muted">
				Only people who manage the project can switch the public link on or off.
			</p>
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

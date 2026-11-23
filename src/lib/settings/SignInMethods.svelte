<script lang="ts">
	// IMPORTED DEP-MODULES
	import { deserialize } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { untrack } from 'svelte';
	import { fly } from 'svelte/transition';
	// IMPORTED MODULES
	import { createFollower } from '#lib/settings/follow.js';
	import Section from '#lib/settings/Section.svelte';
	import CopyButton from '#lib/ui/CopyButton.svelte';
	import GoogleLogo from '#lib/ui/GoogleLogo.svelte';
	import Notice from '#lib/ui/Notice.svelte';
	import Switch from '#lib/ui/Switch.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';
	// IMPORTED DEP-COMPONENTS
	import KeyRound from '@lucide/svelte/icons/key-round';
	import Mail from '@lucide/svelte/icons/mail';

	// -- REQUIRED PROPS -- //

	let {
		methods,
		group
	}: {
		/** What is saved: which methods are on, the Google client ID, whether a secret is kept, and the address to add in Google Cloud. */
		methods: {
			password: boolean;
			google: boolean;
			googleClientId: string;
			googleSecretSet: boolean;
			redirectUrl: string;
		};
		group?: string;
	} = $props();

	// -- CONSTANTS -- //

	const LAST_ONE = 'At least one way to sign in must stay on. Turn the other one on first.';

	// -- STATES -- //

	// The first values are the saved ones, so the server render and the first paint already match; the follower keeps them in step after a save
	let password = $state(untrack(() => methods.password));
	let google = $state(untrack(() => methods.google));
	let clientId = $state(untrack(() => methods.googleClientId));
	/** Typed only to replace the kept secret. Never filled from the server. */
	let clientSecret = $state('');
	let refusal = $state('');
	let saving = $state(false);
	let saved = $state(false);
	let error = $state('');

	// -- REACTIVE STATES -- //

	const dirty = $derived(
		password !== methods.password ||
			google !== methods.google ||
			clientId.trim() !== methods.googleClientId ||
			clientSecret.trim() !== ''
	);
	// What the person will see at the sign in page: a live worked example before anything is saved
	const example = $derived(
		password && google
			? 'People will see an email and password form, and a Continue with Google button.'
			: password
				? 'People will see only the email and password form. The Google button is hidden.'
				: 'People will see only the Continue with Google button. Nobody can sign in with a password.'
	);
	// A short fade when the Google fields open, none for a person who asked for less motion
	const fadeMs = $derived(
		typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
			? 0
			: 160
	);

	// -- FUNCTIONS -- //

	// The fields follow the saved values whenever the page data is replaced
	const follow = createFollower();
	$effect(() => {
		follow('password', methods.password, (v) => (password = v));
		follow('google', methods.google, (v) => (google = v));
		follow('clientId', methods.googleClientId, (v) => (clientId = v));
	});

	// The switches are bound through a getter and a setter, so a refused change leaves them drawn as they were
	/** Turning a method off is refused when it would leave nobody able to sign in. */
	function setPassword(next: boolean) {
		if (!next && !google) {
			refusal = LAST_ONE;
			return;
		}
		refusal = '';
		saved = false;
		password = next;
	}

	function setGoogle(next: boolean) {
		if (!next && !password) {
			refusal = LAST_ONE;
			return;
		}
		refusal = '';
		saved = false;
		google = next;
	}

	/** Sends the section to its own form action, so a refusal of the server shows under the save button. */
	async function save() {
		saving = true;
		error = '';
		const body = new FormData();
		body.set('passwordEnabled', password ? '1' : '0');
		body.set('googleEnabled', google ? '1' : '0');
		body.set('googleClientId', clientId.trim());
		body.set('googleClientSecret', clientSecret.trim());
		try {
			await toast.promise(
				(async () => {
					const res = await fetch('?/saveMethods', {
						method: 'POST',
						body,
						headers: { 'x-sveltekit-action': 'true' }
					});
					const result = deserialize(await res.text());
					if (result.type === 'failure')
						throw new Error(String(result.data?.message ?? 'That was not saved.'));
					if (result.type !== 'success') throw new Error('That was not saved.');
				})(),
				{
					id: 'save-signin-methods',
					loading: 'Saving...',
					success: 'Sign-in methods saved.',
					error: (e) => (e instanceof Error ? e.message : 'That was not saved.')
				}
			);
			// The page data is read again first, so the card never shows Unsaved changes between the save and the reload
			await invalidateAll().catch(() => undefined);
			clientSecret = '';
			saved = true;
		} catch (e) {
			error = e instanceof Error ? e.message : 'That was not saved.';
		} finally {
			saving = false;
		}
	}
</script>

<!-- SIGN IN METHODS: WHICH WAYS OF SIGNING IN ARE ON, FOR THE WHOLE BOARD. OWNERS ONLY, THE SERVER CHECKS IT AGAIN -->
<Section
	id="signin-methods"
	icon={KeyRound}
	{group}
	title="Sign-in methods"
	text="How people sign in to this board. It applies to everyone who uses it, not only this organisation."
	{dirty}
	{saving}
	{saved}
	{error}
	onsave={save}
>
	{#if refusal}
		<Notice tone="danger" data-testid="signin-methods-refusal">{refusal}</Notice>
	{/if}

	<!-- THE TWO METHODS, EACH WITH ITS OWN SWITCH -->
	<div class="divide-y divide-line rounded-lg border border-line px-4">
		<Switch
			label="Email and password"
			hint="People sign in with their email address and a password."
			bind:checked={() => password, setPassword}
			data-testid="switch-password"
		>
			{#snippet lead()}<Mail size={16} class="shrink-0 text-muted" aria-hidden="true" />{/snippet}
		</Switch>
		<Switch
			label="Google"
			hint="People sign in or sign up with their Google account."
			bind:checked={() => google, setGoogle}
			data-testid="switch-google"
		>
			{#snippet lead()}<GoogleLogo />{/snippet}
		</Switch>
	</div>

	<!-- GOOGLE CLIENT: ONLY WHILE GOOGLE IS ON -->
	{#if google}
		<div
			class="flex flex-col gap-3"
			in:fly={{ y: -4, duration: fadeMs }}
			data-testid="google-fields"
		>
			<TextField
				label="Google client ID"
				bind:value={clientId}
				autocomplete="off"
				spellcheck={false}
				data-testid="google-client-id"
			/>
			<TextField
				label="Google client secret"
				type="password"
				bind:value={clientSecret}
				autocomplete="off"
				placeholder={methods.googleSecretSet
					? 'Saved. Type a new one to replace it.'
					: 'Paste the client secret'}
				hint="The secret is kept encrypted and is never shown again."
				data-testid="google-client-secret"
			/>
			<!-- THE ADDRESS TO PASTE INTO GOOGLE CLOUD, WITH ITS COPY BUTTON BESIDE THE FIELD -->
			<div class="flex flex-col gap-1.5">
				<div class="flex items-end gap-2">
					<TextField
						label="Redirect address to add in Google Cloud"
						value={methods.redirectUrl}
						readonly
						class="min-w-0 flex-1"
						data-testid="google-redirect"
					/>
					<CopyButton text={methods.redirectUrl} label="Copy" data-testid="copy-redirect" />
				</div>
				<p class="text-xs text-muted">
					Paste it under Authorised redirect URIs for your OAuth client.
				</p>
			</div>
		</div>
	{/if}

	<!-- THE WORKED EXAMPLE: WHAT PEOPLE WILL SEE AT THE SIGN IN PAGE -->
	<p
		class="rounded-lg border border-line bg-raised/50 p-3 text-sm text-ink"
		data-testid="signin-methods-example"
	>
		{example}
	</p>
</Section>

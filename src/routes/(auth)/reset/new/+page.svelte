<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	// -- DEP-MODULES -- //
	import { enhance } from '$app/forms';
	// -- MODULES -- //
	import Notice from '#lib/ui/Notice.svelte';
	import AuthShell from '#lib/ui/AuthShell.svelte';
	import Button from '#lib/ui/Button.svelte';
	import PasswordStrength from '#lib/ui/PasswordStrength.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	import { toastEnhance } from '#lib/ui/toastEnhance.js';
	// -- DEP-COMPONENTS -- //
	import Lock from '@lucide/svelte/icons/lock';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';

	// -- REQUIRED PROPS -- //

	let { data, form }: PageProps = $props();

	// -- STATES -- //

	let password = $state('');
	let busy = $state(false);
</script>

<svelte:head><title>Choose a new password</title></svelte:head>

<AuthShell title="Choose a new password" icon={ShieldCheck}>
	{#if data.invalid || form?.expired}
		<Notice tone="danger" data-testid="reset-invalid"
			>This link has expired or was already used.</Notice
		>
		<div class="mt-4">
			<Button href="/reset" variant="primary" class="w-full">Ask for a new link</Button>
		</div>
	{:else}
		<form
			method="POST"
			class="flex flex-col gap-3"
			use:enhance={toastEnhance({
				id: 'reset-password',
				loading: 'Saving your password...',
				success: 'Password changed.',
				inline: true,
				onStart: () => (busy = true),
				onDone: () => (busy = false)
			})}
		>
			<input type="hidden" name="token" value={data.token} />
			<TextField
				icon={Lock}
				large
				label="New password"
				name="password"
				type="password"
				autocomplete="new-password"
				required
				minlength={data.minPassword}
				bind:value={password}
				hint={password ? undefined : `At least ${data.minPassword} characters.`}
				error={form?.message}
			/>
			<PasswordStrength value={password} min={data.minPassword} class="-mt-1" />
			<Button type="submit" variant="primary" loading={busy} class="h-11 w-full"
				>Save password</Button
			>
		</form>
	{/if}
</AuthShell>

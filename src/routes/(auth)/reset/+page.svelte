<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	// -- DEP-MODULES -- //
	import { enhance } from '$app/forms';
	// -- MODULES -- //
	import AuthShell from '#lib/ui/AuthShell.svelte';
	import Button from '#lib/ui/Button.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	// -- DEP-COMPONENTS -- //
	import KeyRound from '@lucide/svelte/icons/key-round';
	import Mail from '@lucide/svelte/icons/mail';

	// -- REQUIRED PROPS -- //

	let { form }: PageProps = $props();

	// -- STATES -- //

	let email = $state('');
	let busy = $state(false);
</script>

<svelte:head><title>Reset your password</title></svelte:head>

<AuthShell
	icon={KeyRound}
	title="Reset your password"
	subtitle="Enter your email and we send a link to choose a new password."
>
	{#if form?.sent}
		<p
			role="status"
			class="rounded-lg border border-line bg-success-soft p-3 text-sm text-success"
			data-testid="reset-sent"
		>
			If an account uses {form.email}, a link is on its way. It works for one hour.
		</p>
	{:else}
		<form
			method="POST"
			class="flex flex-col gap-3"
			use:enhance={() => {
				busy = true;
				return async ({ update }) => {
					await update({ reset: false });
					busy = false;
				};
			}}
		>
			<TextField
				icon={Mail}
				large
				label="Email"
				name="email"
				type="email"
				autocomplete="email"
				required
				bind:value={email}
				error={form?.message}
			/>
			<Button type="submit" variant="primary" loading={busy} class="h-11 w-full"
				>Send the link</Button
			>
		</form>
	{/if}
	{#snippet footer()}
		Remembered it? <a href="/sign-in" class="font-medium text-accent-text hover:underline"
			>Sign in</a
		>
	{/snippet}
</AuthShell>

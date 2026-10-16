<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	// -- DEP-MODULES -- //
	import { enhance } from '$app/forms';
	// -- MODULES -- //
	import AuthShell from '#lib/ui/AuthShell.svelte';
	import Button from '#lib/ui/Button.svelte';
	import TextField from '#lib/ui/TextField.svelte';

	// -- REQUIRED PROPS -- //

	let { data, form }: PageProps = $props();

	// -- STATES -- //

	let email = $state('');
	let password = $state('');
	let busy = $state(false);

	// -- REACTIVE STATEMENTS -- //

	// A failed sign in gives the email back, so it is not typed again
	$effect(() => {
		if (form?.email) email = form.email;
	});
</script>

<svelte:head><title>Sign in</title></svelte:head>

<AuthShell title="Sign in" subtitle="Use your work email or your Google account.">
	{#if data.reset}
		<p
			role="status"
			class="mb-4 rounded-lg border border-line bg-success-soft p-3 text-sm text-success"
		>
			Your password was changed. Sign in with the new one.
		</p>
	{/if}
	{#if form?.message}
		<p
			role="alert"
			class="mb-4 rounded-lg border border-line bg-danger-soft p-3 text-sm text-danger"
			data-testid="auth-error"
		>
			{form.message}
		</p>
	{/if}
	<form
		method="POST"
		action="?/signIn"
		class="flex flex-col gap-3"
		use:enhance={() => {
			busy = true;
			return async ({ update }) => {
				await update({ reset: false });
				busy = false;
			};
		}}
	>
		<input type="hidden" name="next" value={data.next} />
		<TextField
			label="Email"
			name="email"
			type="email"
			autocomplete="email"
			required
			bind:value={email}
		/>
		<TextField
			label="Password"
			name="password"
			type="password"
			autocomplete="current-password"
			required
			bind:value={password}
		/>
		<Button type="submit" variant="primary" loading={busy} class="w-full">Sign in</Button>
		<a href="/reset" class="text-sm text-accent-text hover:underline">Forgot your password?</a>
	</form>
	{#if form?.code === 'UNVERIFIED'}
		<form method="POST" action="?/resend" class="mt-3">
			<input type="hidden" name="email" value={email} />
			<input type="hidden" name="next" value={data.next} />
			<Button type="submit" class="w-full">Send a new confirmation link</Button>
		</form>
	{/if}
	{#if data.google}
		<form method="POST" action="?/google" class="mt-3">
			<input type="hidden" name="next" value={data.next} />
			<Button type="submit" class="w-full">Continue with Google</Button>
		</form>
	{/if}
	{#snippet footer()}
		New here? <a href="/sign-up" class="font-medium text-accent-text hover:underline"
			>Create an account</a
		>
	{/snippet}
</AuthShell>

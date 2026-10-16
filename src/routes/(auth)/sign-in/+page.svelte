<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	// -- DEP-MODULES -- //
	import { enhance } from '$app/forms';
	// -- MODULES -- //
	import Notice from '#lib/ui/Notice.svelte';
	import AuthShell from '#lib/ui/AuthShell.svelte';
	import Button from '#lib/ui/Button.svelte';
	import GoogleLogo from '#lib/ui/GoogleLogo.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	// -- DEP-COMPONENTS -- //
	import Lock from '@lucide/svelte/icons/lock';
	import Mail from '@lucide/svelte/icons/mail';

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
		<Notice tone="danger" class="mb-4" data-testid="auth-error">{form.message}</Notice>
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
			placeholder="you@company.com"
			icon={Mail}
			large
			required
			bind:value={email}
		/>
		<TextField
			label="Password"
			name="password"
			type="password"
			autocomplete="current-password"
			icon={Lock}
			large
			required
			bind:value={password}
		>
			{#snippet labelEnd()}
				<a href="/reset" class="text-xs font-medium text-accent-text hover:underline"
					>Forgot your password?</a
				>
			{/snippet}
		</TextField>
		<Button type="submit" variant="primary" loading={busy} class="mt-1 h-11 w-full">Sign in</Button>
	</form>
	{#if form?.code === 'UNVERIFIED'}
		<form method="POST" action="?/resend" use:enhance class="mt-3">
			<input type="hidden" name="email" value={email} />
			<input type="hidden" name="next" value={data.next} />
			<Button type="submit" class="w-full">Send a new confirmation link</Button>
		</form>
	{/if}
	{#if data.google}
		<div class="my-5 flex items-center gap-3 text-xs text-muted">
			<span class="h-px flex-1 bg-line"></span>or<span class="h-px flex-1 bg-line"></span>
		</div>
		<form method="POST" action="?/google" use:enhance>
			<input type="hidden" name="next" value={data.next} />
			<Button type="submit" class="h-11 w-full"><GoogleLogo /> Continue with Google</Button>
		</form>
	{/if}
	{#snippet footer()}
		New here? <a href="/sign-up" class="font-medium text-accent-text hover:underline"
			>Create an account</a
		>
	{/snippet}
</AuthShell>

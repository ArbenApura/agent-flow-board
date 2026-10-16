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

	let name = $state('');
	let email = $state('');
	let password = $state('');
	let busy = $state(false);

	// -- REACTIVE STATEMENTS -- //

	$effect(() => {
		if (form?.name) name = form.name;
		if (form?.email) email = form.email;
	});
</script>

<svelte:head><title>Create an account</title></svelte:head>

<AuthShell
	title="Create an account"
	subtitle="Use your work email. We send one link to confirm it."
>
	<form
		method="POST"
		action="?/register"
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
			label="Your name"
			name="name"
			autocomplete="name"
			required
			bind:value={name}
			error={form?.field === 'name' ? form.message : undefined}
		/>
		<TextField
			label="Email"
			name="email"
			type="email"
			autocomplete="email"
			required
			bind:value={email}
			error={form?.field === 'email' ? form.message : undefined}
		/>
		<TextField
			label="Password"
			name="password"
			type="password"
			autocomplete="new-password"
			required
			minlength={data.minPassword}
			bind:value={password}
			hint={`At least ${data.minPassword} characters. A long sentence works well.`}
			error={form?.field === 'password' ? form.message : undefined}
		/>
		<Button type="submit" variant="primary" loading={busy} class="w-full">Create account</Button>
	</form>
	{#if data.google}
		<form method="POST" action="?/google" class="mt-3">
			<input type="hidden" name="next" value={data.next} />
			<Button type="submit" class="w-full">Continue with Google</Button>
		</form>
	{/if}
	{#snippet footer()}
		Already have an account? <a href="/sign-in" class="font-medium text-accent-text hover:underline"
			>Sign in</a
		>
	{/snippet}
</AuthShell>

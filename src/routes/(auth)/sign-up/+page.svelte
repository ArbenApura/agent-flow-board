<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	// -- DEP-MODULES -- //
	import { enhance } from '$app/forms';
	// -- MODULES -- //
	import AuthShell from '#lib/ui/AuthShell.svelte';
	import Button from '#lib/ui/Button.svelte';
	import GoogleLogo from '#lib/ui/GoogleLogo.svelte';
	import PasswordStrength from '#lib/ui/PasswordStrength.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	// -- DEP-COMPONENTS -- //
	import Lock from '@lucide/svelte/icons/lock';
	import Mail from '@lucide/svelte/icons/mail';
	import User from '@lucide/svelte/icons/user';
	import UserPlus from '@lucide/svelte/icons/user-plus';

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
	icon={UserPlus}
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
			placeholder="Olivia Owner"
			icon={User}
			large
			required
			bind:value={name}
			error={form?.field === 'name' ? form.message : undefined}
		/>
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
			error={form?.field === 'email' ? form.message : undefined}
		/>
		<TextField
			label="Password"
			name="password"
			type="password"
			autocomplete="new-password"
			placeholder="Choose a password"
			icon={Lock}
			large
			required
			minlength={data.minPassword}
			bind:value={password}
			hint={password
				? undefined
				: `At least ${data.minPassword} characters. A long sentence works well.`}
			error={form?.field === 'password' ? form.message : undefined}
		/>
		<PasswordStrength value={password} min={data.minPassword} class="-mt-1" />
		<Button type="submit" variant="primary" loading={busy} class="mt-1 h-11 w-full"
			>Create account</Button
		>
	</form>
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
		Already have an account? <a href="/sign-in" class="font-medium text-accent-text hover:underline"
			>Sign in</a
		>
	{/snippet}
</AuthShell>

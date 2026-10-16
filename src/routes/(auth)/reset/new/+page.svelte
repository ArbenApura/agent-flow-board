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

	let password = $state('');
	let busy = $state(false);
</script>

<svelte:head><title>Choose a new password</title></svelte:head>

<AuthShell title="Choose a new password">
	{#if data.invalid || form?.expired}
		<p
			role="alert"
			class="rounded-lg border border-line bg-danger-soft p-3 text-sm text-danger"
			data-testid="reset-invalid"
		>
			This link has expired or was already used.
		</p>
		<div class="mt-4">
			<Button href="/reset" variant="primary" class="w-full">Ask for a new link</Button>
		</div>
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
			<input type="hidden" name="token" value={data.token} />
			<TextField
				label="New password"
				name="password"
				type="password"
				autocomplete="new-password"
				required
				minlength={data.minPassword}
				bind:value={password}
				hint={`At least ${data.minPassword} characters.`}
				error={form?.message}
			/>
			<Button type="submit" variant="primary" loading={busy} class="w-full">Save password</Button>
		</form>
	{/if}
</AuthShell>

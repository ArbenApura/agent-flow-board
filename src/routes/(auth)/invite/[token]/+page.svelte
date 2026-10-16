<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	// -- ENVS -- //
	import { enhance } from '$app/forms';
	// -- MODULES -- //
	import Notice from '#lib/ui/Notice.svelte';
	import AuthShell from '#lib/ui/AuthShell.svelte';
	import Button from '#lib/ui/Button.svelte';
	import { ROLE_LABEL } from '#lib/shared/roles.js';

	// -- REQUIRED PROPS -- //

	let { data, form }: PageProps = $props();

	// -- REACTIVE STATES -- //

	const enc = $derived(encodeURIComponent(data.next));
</script>

<svelte:head><title>Invitation</title></svelte:head>

<AuthShell title={data.invite ? `Join ${data.invite.orgName}` : 'Invitation'}>
	{#if !data.invite}
		<Notice tone="danger" data-testid="invite-invalid"
			>This invitation link is not valid. Ask the person who invited you for a new one.</Notice
		>
	{:else if data.invite.state !== 'open'}
		<Notice tone="danger" data-testid="invite-closed"
			>{data.invite.state === 'expired'
				? 'This invitation has expired.'
				: 'This invitation was already used or was withdrawn.'} Ask for a new one.</Notice
		>
	{:else}
		<p class="text-sm">
			You are invited as <strong>{ROLE_LABEL[data.invite.role]}</strong>. The invitation is for
			<strong>{data.invite.email}</strong> only.
		</p>
		{#if form?.message}
			<Notice tone="danger" class="mt-3" data-testid="invite-error">{form.message}</Notice>
		{/if}
		{#if !data.person}
			<div class="mt-4 flex flex-col gap-2">
				<Button href={`/sign-up?next=${enc}`} variant="primary" class="w-full"
					>Create an account</Button
				>
				<Button href={`/sign-in?next=${enc}`} class="w-full">I already have an account</Button>
			</div>
			<p class="mt-3 text-xs text-muted">
				Use {data.invite.email} so the invitation matches.
			</p>
		{:else}
			<form method="POST" action="?/accept" use:enhance class="mt-4">
				<Button type="submit" variant="primary" class="w-full">Join {data.invite.orgName}</Button>
			</form>
			<p class="mt-3 text-xs text-muted">You are signed in as {data.person.email}.</p>
		{/if}
	{/if}
</AuthShell>

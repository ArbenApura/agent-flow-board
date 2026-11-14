<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { PageProps } from './$types';
	// IMPORTED DEP-MODULES
	import { enhance } from '$app/forms';
	// IMPORTED MODULES
	import Notice from '#lib/ui/Notice.svelte';
	import AuthShell from '#lib/ui/AuthShell.svelte';
	import Button from '#lib/ui/Button.svelte';
	import { toastEnhance } from '#lib/ui/toastEnhance.js';

	// -- REQUIRED PROPS -- //

	let { data, form }: PageProps = $props();

	// -- STATES -- //

	let busy = $state(false);

	// -- REACTIVE STATES -- //

	// Any refusal of the resend shows in the notice, because the toast leaves it to the page (inline)
	const failed = $derived(data.failed || (!!form && !form.resent && !!form.message));
</script>

<svelte:head><title>Check your email</title></svelte:head>

<AuthShell title={data.verified ? 'Email confirmed' : 'Check your email'}>
	{#if data.verified}
		<p class="text-sm">Your email address is confirmed.</p>
		<div class="mt-4"><Button href="/" variant="primary" class="h-11 w-full">Continue</Button></div>
	{:else}
		{#if failed}
			<Notice tone="danger" class="mb-4" data-testid="email-failed"
				>{form?.message ??
					'Your account was created, but we could not send the confirmation email.'} Use the button to
				try again.</Notice
			>
		{:else if form?.resent || data.sent}
			<p
				role="status"
				class="mb-4 rounded-lg border border-line bg-success-soft p-3 text-sm text-success"
				data-testid="email-sent"
			>
				We sent a confirmation link to {data.email || 'your email address'}. It works for one hour.
			</p>
		{/if}
		<p class="text-sm text-muted">
			Open the link in the email to finish. Nothing arrived? Check the spam folder, then send it
			again.
		</p>
		<form
			method="POST"
			action="?/resend"
			class="mt-4"
			use:enhance={toastEnhance({
				id: 'resend-verification',
				loading: 'Sending the link...',
				success: 'Verification email sent.',
				inline: true,
				onStart: () => (busy = true),
				onDone: () => (busy = false)
			})}
		>
			<input type="hidden" name="email" value={data.email} />
			<input type="hidden" name="next" value={data.next} />
			<Button
				type="submit"
				variant={failed ? 'primary' : 'secondary'}
				loading={busy}
				class="h-11 w-full">Send the link again</Button
			>
		</form>
	{/if}
	{#snippet footer()}
		Wrong address? <a href="/sign-up" class="font-medium text-accent-text hover:underline"
			>Start again</a
		>
	{/snippet}
</AuthShell>

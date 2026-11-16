<script lang="ts">
	// IMPORTED ENVS
	import { enhance } from '$app/forms';
	// IMPORTED MODULES
	import Section from '#lib/settings/Section.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import { cn } from '#lib/ui/cn.js';
	import { toastEnhance } from '#lib/ui/toastEnhance.js';
	// IMPORTED DEP-COMPONENTS
	import Bell from '@lucide/svelte/icons/bell';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import Mail from '@lucide/svelte/icons/mail';
	import MailCheck from '@lucide/svelte/icons/mail-check';
	import MailWarning from '@lucide/svelte/icons/mail-warning';
	import MailX from '@lucide/svelte/icons/mail-x';
	import Send from '@lucide/svelte/icons/send';
	import UserPlus from '@lucide/svelte/icons/user-plus';

	// -- REQUIRED PROPS -- //

	let {
		email,
		can,
		form,
		group
	}: {
		email: { configured: boolean; provider: string | null };
		/** Only a person who may change settings gets the test card. */
		can: boolean;
		/** The result of the testEmail action. */
		form?: { sent?: boolean; to?: string; message?: string } | null;
		group?: string;
	} = $props();

	// -- CONSTANTS -- //

	const FLOWS = [
		{ key: 'invitations', label: 'Invitations', icon: UserPlus },
		{ key: 'codes', label: 'Sign in codes', icon: KeyRound },
		{ key: 'alerts', label: 'Alerts', icon: Bell }
	];

	// -- STATES -- //

	let busyTest = $state(false);

	// -- REACTIVE STATES -- //

	// A real provider is green, the log sender is amber because nothing leaves the server
	const isLog = $derived(email.provider === 'log');
</script>

<Section
	id="email"
	icon={Mail}
	{group}
	title="Email sending"
	text="How this server sends invitations, sign in codes and alerts."
>
	{#if email.configured}
		<!-- THE PROVIDER CARD -->
		<div
			class="flex flex-wrap items-center gap-4 rounded-xl border border-line bg-raised/40 p-4 max-sm:p-3"
		>
			<span class="relative inline-flex size-12 shrink-0" aria-hidden="true">
				<!-- THE RING SETTLES ONCE AROUND THE TILE WHEN IT APPEARS -->
				<span
					class={cn(
						'settle-in absolute inset-0 rounded-xl border',
						isLog ? 'border-warning/35' : 'border-success/35'
					)}
				></span>
				<span
					class={cn(
						'relative inline-flex size-12 items-center justify-center rounded-xl border',
						isLog
							? 'border-warning/35 bg-warning-soft text-warning'
							: 'border-success/35 bg-success-soft text-success'
					)}
				>
					{#if isLog}<MailWarning size={24} />{:else}<MailCheck size={24} />{/if}
				</span>
			</span>
			<div class="min-w-0 flex-1 basis-56">
				<p class="text-xs text-muted">Sending through</p>
				<p class="mt-0.5 flex flex-wrap items-center gap-2 text-sm">
					<Badge tone={isLog ? 'warning' : 'success'} icon>{email.provider}</Badge>
				</p>
				{#if isLog}
					<p class="mt-1.5 text-sm text-muted" data-testid="log-note">
						The log sender only writes mail to a file, nothing leaves the server.
					</p>
				{:else}
					<p class="mt-1.5 text-sm text-muted">
						Mail leaves this server through the provider above.
					</p>
				{/if}
			</div>
		</div>

		<!-- WHAT GOES THROUGH IT -->
		<div class="flex flex-col gap-2">
			<p class="text-xs font-medium text-muted">What goes through it</p>
			<ul class="flex flex-wrap gap-2">
				{#each FLOWS as f (f.key)}
					<li
						class="inline-flex min-h-9 items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink max-sm:min-h-11"
					>
						<span class={isLog ? 'text-warning' : 'text-success'}><f.icon size={16} /></span>
						{f.label}
						<span class={cn('text-xs', isLog ? 'text-warning' : 'text-success')}
							>{isLog ? 'written to a file' : 'sent'}</span
						>
					</li>
				{/each}
			</ul>
		</div>

		{#if can}
			<!-- THE TEST CARD: ONE MESSAGE TO THE PERSON ASKING, WITH ITS RESULT NEXT TO THE BUTTON -->
			<form
				method="POST"
				action="?/testEmail"
				class="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-4 shadow-[var(--elev-1)] max-sm:p-3"
				use:enhance={toastEnhance({
					id: 'test-email',
					loading: 'Sending the test email...',
					success: 'Test email sent.',
					inline: true,
					// The form's own update keeps its default reset
					reset: true,
					onStart: () => (busyTest = true),
					onDone: () => (busyTest = false)
				})}
			>
				<span
					class="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-raised text-muted"
					aria-hidden="true"><Send size={18} /></span
				>
				<div class="min-w-0 flex-1 basis-56">
					<p class="text-sm font-medium text-ink">Try it</p>
					<p class="text-xs text-muted">Sends one message to your own address.</p>
				</div>
				<div
					class="flex flex-wrap items-center gap-3 max-sm:w-full max-sm:flex-col max-sm:items-stretch"
				>
					{#if form?.sent}
						<span
							class="inline-flex items-center gap-1.5 text-sm text-success"
							role="status"
							data-testid="test-email-result"
							><CircleCheck size={16} class="shrink-0" />Sent to {form.to}.</span
						>
					{:else if form?.message}
						<span
							class="inline-flex items-center gap-1.5 text-sm text-danger"
							role="alert"
							data-testid="test-email-result"
							><CircleAlert size={16} class="shrink-0" />{form.message}</span
						>
					{/if}
					<Button type="submit" loading={busyTest} class="max-sm:w-full" data-testid="test-email">
						{#if !busyTest}<Send size={16} />{/if}
						{busyTest ? 'Sending...' : 'Send me a test email'}
					</Button>
				</div>
			</form>
		{/if}
	{:else}
		<!-- NOT SET UP: ONE DASHED CARD SAYING SO -->
		<div
			class="flex flex-wrap items-center gap-4 rounded-xl border border-dashed border-line bg-raised/30 p-4 max-sm:p-3"
		>
			<span
				class="inline-flex size-12 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-muted"
				aria-hidden="true"><MailX size={24} /></span
			>
			<div class="min-w-0 flex-1 basis-56">
				<p class="text-sm font-medium text-ink">Email is not set up</p>
				<p class="text-sm text-muted">This server has no way to send email yet.</p>
			</div>
		</div>
	{/if}
</Section>

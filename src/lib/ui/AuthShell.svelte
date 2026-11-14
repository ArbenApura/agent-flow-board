<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { Component, Snippet } from 'svelte';
	// IMPORTED MODULES
	import Badge from '#lib/ui/Badge.svelte';
	import AuthCard from '#lib/ui/AuthCard.svelte';
	import Logo from '#lib/ui/Logo.svelte';
	import MeshField from '#lib/ui/MeshField.svelte';
	import Texture from '#lib/ui/Texture.svelte';
	// IMPORTED DEP-COMPONENTS
	import Bot from '@lucide/svelte/icons/bot';
	import Circle from '@lucide/svelte/icons/circle';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import Plug from '@lucide/svelte/icons/plug';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import Users from '@lucide/svelte/icons/users';

	// -- REQUIRED PROPS -- //

	let {
		title,
		subtitle,
		icon: Icon = KeyRound,
		note = 'Your connection is encrypted and your password is never shown to anyone.',
		children,
		footer
	}: {
		title: string;
		subtitle?: string;
		/** The badge icon at the top of the card, which says what this page is for. */
		icon?: Component<{ size?: number; class?: string }>;
		children: Snippet;
		/** The quiet line at the bottom of the card. Pages that have no password say something that fits them. */
		note?: string;
		/** A line under the card, for the link to the other page. */
		footer?: Snippet;
	} = $props();

	// -- CONSTANTS -- //

	const POINTS = [
		{ icon: Plug, title: 'Agents record as they work', text: 'Through MCP or the REST API' },
		{ icon: Users, title: 'One plan for the team', text: 'The same steps, progress and checks' }
	];
	const MESSAGES = [
		'An agent is working on step 1, phase 1',
		'An agent is working on step 2, phase 1',
		'An agent is working on step 3, phase 1',
		'Phase 1 is done and waiting for review'
	];
	const STEPS = [
		{ text: 'Write the saved cards table', done: true },
		{ text: 'Charge a saved card at checkout', done: true },
		{ text: 'Show the last four digits', done: false }
	];
</script>

<!-- THE SHARED FRAME OF EVERY SIGN IN PAGE. A BRAND PANEL ON A WIDE SCREEN, THE FORM CARD, ONE LINE UNDER IT -->
<main class="relative grid min-h-dvh lg:grid-cols-2">
	<MeshField />
	<aside
		class="auth-aside relative hidden grid-rows-[1fr_auto_1fr] justify-items-center overflow-hidden border-r border-line bg-raised/50 px-8 py-12 lg:grid"
		aria-hidden="true"
	>
		<div class="absolute inset-0"><Texture kinds={['aurora']} contained /></div>
		<div class="relative w-full max-w-[440px] self-start xl:max-w-[480px]">
			<Logo size={36} class="text-xl" />
		</div>

		<div class="relative flex w-full max-w-[440px] flex-col gap-10 xl:max-w-[480px]">
			<!-- A SMALL PICTURE OF THE PRODUCT, PLAYING A LOOP. A PLAN CARD WITH ITS RING, ITS STEPS AND AN AGENT AT WORK, A SECOND CARD BEHIND IT FOR DEPTH. THE STILL STATE (REDUCED MOTION) IS 2 OF 3 STEPS DONE -->
			<div class="auth-rise relative pb-3" style="--d: 150">
				<div
					class="absolute inset-x-5 -bottom-2 h-8 rounded-xl border border-line bg-surface"
				></div>
				<AuthCard>
					<div class="flex flex-col gap-4 p-5">
						<div class="flex items-center gap-3">
							<span class="relative inline-flex size-9 shrink-0 items-center justify-center">
								<svg width="36" height="36" viewBox="0 0 36 36" class="-rotate-90">
									<circle
										cx="18"
										cy="18"
										r="16"
										fill="none"
										stroke="var(--raised)"
										stroke-width="4"
									/>
									<circle
										class="hero-ring"
										cx="18"
										cy="18"
										r="16"
										fill="none"
										stroke="var(--info)"
										stroke-width="4"
										stroke-linecap="round"
									/>
								</svg>
								<span
									class="hero-n absolute text-[11px] leading-none font-semibold text-ink tabular-nums"
								></span>
							</span>
							<div class="min-w-0 flex-1">
								<p class="font-mono text-xs text-muted">CKT-12</p>
								<p class="truncate text-sm font-semibold text-ink">Saved cards at checkout</p>
							</div>
							<Badge tone="running" dot>in progress</Badge>
						</div>
						<ul class="flex flex-col gap-2">
							{#each STEPS as s, i (s.text)}
								<li class="flex items-center gap-2.5 text-sm">
									<span class="relative size-[18px] shrink-0">
										<Circle size={18} class="absolute inset-0 text-muted" />
										{#if i === 2}
											<span
												class="hero-work absolute -inset-1 rounded-full border-2 border-accent/40"
											></span>
										{/if}
										<span class="hero-chk-{i + 1} absolute inset-0">
											<CircleCheck size={18} class="text-accent" />
										</span>
									</span>
									<span class="hero-lab-{i + 1} relative"
										>{s.text}<span class="hero-str hero-str-{i + 1}"></span></span
									>
								</li>
							{/each}
						</ul>
						<div
							class="hero-bar flex items-center gap-2 rounded-lg bg-accent-soft px-3 py-2 text-xs text-accent-text"
						>
							<Bot size={16} class="hero-bot shrink-0" />
							<span class="grid">
								{#each MESSAGES as m, i (m)}
									<span class="hero-msg hero-msg-{i + 1}">{m}</span>
								{/each}
							</span>
						</div>
					</div>
				</AuthCard>
			</div>

			<div class="flex flex-col gap-5">
				<div
					class="auth-rise max-w-[22ch] font-display text-2xl font-semibold tracking-tight"
					style="--d: 300"
				>
					One plan your team and your agents both keep.
				</div>
				<ul class="flex flex-col gap-4">
					{#each POINTS as p, i (p.title)}
						<li class="auth-rise flex items-start gap-3" style="--d: {450 + i * 130}">
							<span
								class="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-accent-text shadow-[var(--elev-1)]"
								><p.icon size={18} /></span
							>
							<span class="flex flex-col">
								<span class="text-sm font-medium text-ink">{p.title}</span>
								<span class="text-sm text-muted">{p.text}</span>
							</span>
						</li>
					{/each}
				</ul>
			</div>
		</div>
		<p class="relative w-full max-w-[440px] self-end text-xs text-muted xl:max-w-[480px]">
			Light and dark, built for readable plans.
		</p>
	</aside>

	<div class="relative flex flex-col items-center justify-center px-4 py-10">
		<div class="relative flex w-full max-w-[440px] flex-col gap-5 xl:max-w-[480px]">
			<Logo size={32} class="text-lg lg:hidden" />
			<!-- THE CARD. AN ACCENT EDGE ON TOP, A BADGE THAT SAYS WHAT THE PAGE IS FOR, THE FORM, AND A QUIET SECURITY LINE AT THE BOTTOM -->
			<AuthCard>
				<div class="absolute inset-x-0 top-0 h-0.5 bg-accent"></div>
				<div class="p-8 max-sm:p-5">
					<span
						class="mb-5 inline-flex size-12 items-center justify-center rounded-xl border border-accent/35 bg-accent/12 text-accent-text shadow-[inset_0_1px_0_0_rgb(255_255_255/0.08)] [@media(max-height:720px)]:hidden"
						aria-hidden="true"
					>
						<Icon size={22} />
					</span>
					<h1 class="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
					{#if subtitle}<p class="mt-1 mb-6 text-sm text-muted">{subtitle}</p>{:else}<div
							class="mb-6"
						></div>{/if}
					{@render children()}
				</div>
				<div
					class="flex items-center gap-2 border-t border-line/50 bg-raised/30 px-8 py-3 text-xs text-muted max-sm:px-5 [@media(max-height:720px)]:hidden"
				>
					<ShieldCheck size={14} class="shrink-0" aria-hidden="true" />
					{note}
				</div>
			</AuthCard>
			{#if footer}<p class="text-center text-sm text-muted">{@render footer()}</p>{/if}
		</div>
	</div>
</main>

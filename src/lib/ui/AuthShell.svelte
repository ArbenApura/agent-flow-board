<script lang="ts">
	// -- DEP-TYPES -- //
	import type { Component, Snippet } from 'svelte';
	// -- MODULES -- //
	import Badge from '#lib/ui/Badge.svelte';
	import Mark from '#lib/ui/Mark.svelte';
	import ProgressRing from '#lib/ui/ProgressRing.svelte';
	import Texture from '#lib/ui/Texture.svelte';
	// -- DEP-COMPONENTS -- //
	import Bot from '@lucide/svelte/icons/bot';
	import Circle from '@lucide/svelte/icons/circle';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import GitBranch from '@lucide/svelte/icons/git-branch';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import Plug from '@lucide/svelte/icons/plug';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import Users from '@lucide/svelte/icons/users';

	// -- REQUIRED PROPS -- //

	let {
		title,
		subtitle,
		icon: Icon = KeyRound,
		children,
		footer
	}: {
		title: string;
		subtitle?: string;
		/** The badge icon at the top of the card, which says what this page is for. */
		icon?: Component<{ size?: number; class?: string }>;
		children: Snippet;
		/** A line under the card, for the link to the other page. */
		footer?: Snippet;
	} = $props();

	// -- CONSTANTS -- //

	const POINTS = [
		{ icon: Plug, title: 'Agents record as they work', text: 'Through MCP or the REST API' },
		{ icon: Users, title: 'One plan for the team', text: 'The same steps, progress and checks' },
		{ icon: GitBranch, title: 'Yours to keep', text: 'Publish plans to your own GitHub repository' }
	];
	const STEPS = [
		{ text: 'Write the saved cards table', done: true },
		{ text: 'Charge a saved card at checkout', done: true },
		{ text: 'Show the last four digits', done: false }
	];
</script>

<!-- THE SHARED FRAME OF EVERY SIGN IN PAGE. A BRAND PANEL ON A WIDE SCREEN, THE FORM CARD, ONE LINE UNDER IT -->
<main class="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
	<aside
		class="relative hidden flex-col justify-between gap-10 overflow-hidden border-r border-line bg-raised/50 p-12 lg:flex"
		aria-hidden="true"
	>
		<Texture kinds={['aurora', 'grid']} contained />
		<div class="relative flex items-center gap-2.5 text-lg font-semibold">
			<Mark size={32} />
			<span>agent-flow-board</span>
		</div>

		<div class="relative flex flex-col gap-10">
			<!-- A SMALL PICTURE OF THE PRODUCT. A PLAN CARD WITH ITS RING, ITS STEPS AND AN AGENT AT WORK, A SECOND CARD BEHIND IT FOR DEPTH -->
			<div class="relative max-w-sm">
				<div
					class="absolute inset-x-4 -bottom-3 h-full rounded-2xl border border-line bg-surface/60 shadow-[var(--elev-1)]"
				></div>
				<div
					class="relative flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5 shadow-[var(--elev-2)]"
				>
					<div class="flex items-center gap-3">
						<ProgressRing value={66} label="Example progress" size={36} />
						<div class="min-w-0 flex-1">
							<p class="font-mono text-xs text-muted">CKT-12</p>
							<p class="truncate text-sm font-semibold text-ink">Saved cards at checkout</p>
						</div>
						<Badge tone="running" dot>in progress</Badge>
					</div>
					<ul class="flex flex-col gap-2">
						{#each STEPS as s (s.text)}
							<li class="flex items-center gap-2.5 text-sm {s.done ? 'text-muted' : 'text-ink'}">
								{#if s.done}
									<CircleCheck size={18} class="shrink-0 text-accent" />
								{:else}
									<Circle size={18} class="shrink-0 text-muted" />
								{/if}
								<span class={s.done ? 'line-through' : ''}>{s.text}</span>
							</li>
						{/each}
					</ul>
					<div
						class="flex items-center gap-2 rounded-lg bg-accent-soft px-3 py-2 text-xs text-accent-text"
					>
						<Bot size={16} class="shrink-0" />
						<span>An agent is working on step 3, phase 1</span>
					</div>
				</div>
			</div>

			<div class="flex flex-col gap-5">
				<div class="max-w-[22ch] text-2xl font-semibold tracking-tight">
					One plan your team and your agents both keep.
				</div>
				<ul class="flex flex-col gap-4">
					{#each POINTS as p (p.title)}
						<li class="flex items-start gap-3">
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
		<p class="relative text-xs text-muted">Light and dark, built for readable plans.</p>
	</aside>

	<div class="relative flex flex-col items-center justify-center px-4 py-10">
		<div class="relative flex w-full max-w-[440px] flex-col gap-5">
			<div class="flex items-center gap-2.5 text-lg font-semibold lg:hidden">
				<Mark size={28} />
				<span>agent-flow-board</span>
			</div>
			<!-- THE CARD. AN ACCENT EDGE ON TOP, A BADGE THAT SAYS WHAT THE PAGE IS FOR, THE FORM, AND A QUIET SECURITY LINE AT THE BOTTOM -->
			<div
				class="relative overflow-hidden rounded-2xl border border-line bg-surface shadow-[var(--elev-2)]"
			>
				<div
					class="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-accent via-accent-text to-accent"
				></div>
				<div class="p-8 max-sm:p-5">
					<span
						class="mb-5 inline-flex size-12 items-center justify-center rounded-xl bg-accent-soft text-accent-text ring-8 ring-accent-soft/50"
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
					class="flex items-center gap-2 border-t border-line bg-raised/60 px-8 py-3 text-xs text-muted max-sm:px-5"
				>
					<ShieldCheck size={14} class="shrink-0" aria-hidden="true" />
					Your connection is encrypted and your password is never shown to anyone.
				</div>
			</div>
			{#if footer}<p class="text-center text-sm text-muted">{@render footer()}</p>{/if}
		</div>
	</div>
</main>

<script lang="ts">
	// -- DEP-TYPES -- //
	import type { Snippet } from 'svelte';
	// -- MODULES -- //
	import Illustration from '#lib/ui/Illustration.svelte';
	import Mark from '#lib/ui/Mark.svelte';
	// -- DEP-COMPONENTS -- //
	import GitBranch from 'phosphor-svelte/lib/GitBranch';
	import Plugs from 'phosphor-svelte/lib/Plugs';
	import UsersThree from 'phosphor-svelte/lib/UsersThree';

	// -- REQUIRED PROPS -- //

	let {
		title,
		subtitle,
		children,
		footer
	}: {
		title: string;
		subtitle?: string;
		children: Snippet;
		/** A line under the card, for the link to the other page. */
		footer?: Snippet;
	} = $props();

	// -- CONSTANTS -- //

	const POINTS = [
		{ icon: Plugs, text: 'Agents record their work through MCP or the REST API' },
		{ icon: UsersThree, text: 'Teams see the same plan, progress and checks' },
		{ icon: GitBranch, text: 'Publish plans to your own GitHub repository' }
	];
</script>

<!-- THE SHARED FRAME OF EVERY SIGN IN PAGE. A BRAND PANEL ON A WIDE SCREEN, THE FORM CARD, ONE LINE UNDER IT -->
<main class="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
	<aside
		class="relative hidden flex-col justify-between gap-10 border-r border-line bg-raised/50 p-12 lg:flex"
		aria-hidden="true"
	>
		<div class="flex items-center gap-2.5 text-lg font-semibold">
			<Mark size={32} />
			<span>agent-flow-board</span>
		</div>
		<div class="flex flex-col gap-8">
			<Illustration kind="welcome" class="h-auto w-64" />
			<div class="flex flex-col gap-3">
				<div class="max-w-[22ch] text-2xl font-semibold tracking-tight">
					One plan your team and your agents both keep.
				</div>
				<ul class="flex flex-col gap-3">
					{#each POINTS as p (p.text)}
						<li class="flex items-center gap-3 text-sm text-muted">
							<span
								class="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-text"
								><p.icon size={18} /></span
							>
							{p.text}
						</li>
					{/each}
				</ul>
			</div>
		</div>
		<p class="text-xs text-muted">Light and dark, built for readable plans.</p>
	</aside>
	<div class="flex flex-col items-center justify-center px-4 py-10">
		<div class="flex w-full max-w-[420px] flex-col gap-5">
			<div class="flex items-center gap-2.5 text-lg font-semibold lg:hidden">
				<Mark size={28} />
				<span>agent-flow-board</span>
			</div>
			<div class="rounded-2xl border border-line bg-surface p-8 max-sm:p-5">
				<h1 class="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
				{#if subtitle}<p class="mt-1 mb-6 text-sm text-muted">{subtitle}</p>{:else}<div
						class="mb-6"
					></div>{/if}
				{@render children()}
			</div>
			{#if footer}<p class="text-sm text-muted">{@render footer()}</p>{/if}
		</div>
	</div>
</main>

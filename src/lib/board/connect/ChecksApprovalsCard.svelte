<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { Component } from 'svelte';
	// IMPORTED MODULES
	import { cn } from '#lib/ui/cn.js';
	// IMPORTED DEP-COMPONENTS
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import FileText from '@lucide/svelte/icons/file-text';
	import FolderTree from '@lucide/svelte/icons/folder-tree';
	import Image from '@lucide/svelte/icons/image';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import Link from '@lucide/svelte/icons/link';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	// IMPORTED COMPONENTS
	import Badge from '#lib/ui/Badge.svelte';
	import Card from '#lib/ui/Card.svelte';

	// -- REQUIRED PROPS -- //

	let { settingsHref }: { settingsHref: string } = $props();

	// -- CONSTANTS -- //

	// The five things an approval can be for, in the words of the bridge README
	const KINDS: { name: string; icon: Component<{ size?: number }>; title: string; text: string }[] =
		[
			{
				name: 'roots',
				icon: FolderTree,
				title: 'Folders checks may live in',
				text: 'At most 5 parent folders. A project folder must sit inside one.'
			},
			{
				name: 'register',
				icon: Link,
				title: 'Register a project or a live site',
				text: 'Links a board project to a folder, or to a site address.'
			},
			{
				name: 'secrets',
				icon: KeyRound,
				title: 'Seal test keys',
				text: 'Test database and mail values, sealed for one project. Only names are ever shown.'
			},
			{
				name: 'adopt-env',
				icon: FileText,
				title: 'Use a .env file',
				text: 'Lets a project run with its own .env. It is asked again when the folder changes.'
			},
			{
				name: 'pictures',
				icon: Image,
				title: 'Keep pictures of a run',
				text: 'Lets the screenshots of a run be kept and shown on the item.'
			}
		];

	// -- STATES -- //

	let open = $state(false);
</script>

<!-- WHO APPROVES WHAT: THE OWNER'S SWITCH IS SHOWN HERE, NEVER CHANGED. NO ACTION, TOOL OR TOKEN TURNS IT ON -->
<Card
	padded={false}
	data-testid="checks-approvals"
	icon={ShieldCheck}
	title="Who approves what"
	description="A check can reach folders, live sites and test keys, so some actions need a single-use code that lasts 10 minutes."
>
	<div class="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 max-sm:px-3.5">
		<div class="min-w-48 flex-1">
			<p class="text-sm font-medium text-ink">Let my agent handle approvals on its own</p>
			<p class="text-xs text-muted">
				Only you can turn this on, for yourself, in a project's Settings under Agent access, after
				one warning. No tool, API call or token can.
			</p>
		</div>
		<a
			href={settingsHref}
			class="inline-flex min-h-11 cursor-pointer items-center gap-1.5 text-sm font-medium text-accent-text hover:underline"
			>Open your projects<ArrowRight size={16} aria-hidden="true" /></a
		>
	</div>
	<ul>
		{#each KINDS as k (k.name)}
			{@const Icon = k.icon}
			<li class="flex gap-3 border-b border-line px-4 py-3 last:border-b-0 max-sm:px-3.5">
				<span
					class="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-raised text-muted"
					aria-hidden="true"><Icon size={18} /></span
				>
				<span class="flex min-w-0 flex-col gap-0.5">
					<span class="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
						{k.title}
						<Badge class="font-mono">{k.name}</Badge>
					</span>
					<span class="text-xs text-muted">{k.text}</span>
				</span>
			</li>
		{/each}
	</ul>
	<div class="border-t border-line px-4 pt-1 pb-3 max-sm:px-3.5">
		<button
			type="button"
			aria-expanded={open}
			aria-controls="approvals-limits"
			onclick={() => (open = !open)}
			class="flex min-h-11 w-full cursor-pointer items-center gap-2 text-left text-sm text-ink"
		>
			<ChevronDown
				size={16}
				class={cn(
					'shrink-0 text-muted transition-transform motion-reduce:transition-none',
					!open && '-rotate-90'
				)}
				aria-hidden="true"
			/>What the switch protects, and what it does not
		</button>
		<div id="approvals-limits" hidden={!open} class="flex flex-col gap-2 text-xs text-muted">
			<p>
				It covers the agents on the computers you own, and you lose it by losing Manage. Each
				approval is still single use, for one action and one target on one machine.
			</p>
			<p>
				The risk you accept: anything that holds your Manage token, or a hidden instruction in text
				the agent reads, can make the agent add folders, register sites or import test keys without
				anyone being asked. The board's history shows what was done.
			</p>
			<p>
				An agent that runs as your own computer user can read the local approval key. The switch
				stops an agent that goes through the bridge and the board, not one that edits local files.
			</p>
		</div>
	</div>
</Card>

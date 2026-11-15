<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { Component } from 'svelte';
	// IMPORTED DEP-COMPONENTS
	import FileText from '@lucide/svelte/icons/file-text';
	import FolderTree from '@lucide/svelte/icons/folder-tree';
	import Image from '@lucide/svelte/icons/image';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import Link from '@lucide/svelte/icons/link';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	// IMPORTED COMPONENTS
	import Badge from '#lib/ui/Badge.svelte';
	import Card from '#lib/ui/Card.svelte';

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
</script>

<!-- WHAT YOUR AGENT APPROVES ON ITS OWN: THERE IS NO SWITCH, AGENT APPROVALS ARE ALWAYS ON -->
<Card
	padded={false}
	data-testid="checks-approvals"
	icon={ShieldCheck}
	title="What your agent approves on its own"
	description="Your agent asks for these itself and each one works once, for 10 minutes."
>
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
</Card>

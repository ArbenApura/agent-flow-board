<script lang="ts">
	// IMPORTED ENVS
	import { goto } from '$app/navigation';
	// IMPORTED MODULES
	import { api } from '#lib/board/api.js';
	import { cn } from '#lib/ui/cn.js';
	import Badge from '#lib/ui/Badge.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	// IMPORTED DEP-COMPONENTS
	import Search from '@lucide/svelte/icons/search';

	// -- TYPES -- //

	type Hit = {
		kind: string;
		id: string;
		title: string;
		projectKey: string;
		itemRef?: string | null;
		noteRef?: string | null;
	};
	type Entry = { key: string; label: string; hint: string; href: string };

	// -- REQUIRED PROPS -- //

	let {
		open,
		onclose,
		org,
		pages
	}: {
		open: boolean;
		onclose: () => void;
		/** The slug of the organisation to search. */
		org: string;
		/** Pages of the current project, shown before anything is typed. */
		pages: { href: string; label: string }[];
	} = $props();

	// -- CONSTANTS -- //

	const KIND: Record<string, string> = {
		item: 'Item',
		section: 'Document',
		decision: 'Decision',
		task: 'Task',
		note: 'Note'
	};
	const uid = $props.id();

	// -- STATES -- //

	let q = $state('');
	let hits = $state<Hit[]>([]);
	let active = $state(0);
	let failed = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let input = $state<HTMLInputElement>();

	// -- REACTIVE STATES -- //

	const entries = $derived<Entry[]>(
		q.trim()
			? hits.map((h) => ({
					key: h.kind + h.id,
					label: h.title,
					hint: `${KIND[h.kind] ?? h.kind}, ${h.projectKey}`,
					href:
						h.kind === 'task'
							? `/${org}/${h.projectKey}/tasks`
							: h.kind === 'note' && h.noteRef
								? `/${org}/${h.projectKey}/notes/${h.noteRef}`
								: h.itemRef
									? `/${org}/${h.projectKey}/${h.itemRef}`
									: `/${org}/${h.projectKey}`
				}))
			: pages.map((p) => ({ key: p.href, label: p.label, hint: 'Page', href: p.href }))
	);

	// -- FUNCTIONS -- //

	function search() {
		clearTimeout(timer);
		failed = false;
		const term = q.trim();
		if (!term) {
			hits = [];
			active = 0;
			return;
		}
		timer = setTimeout(async () => {
			try {
				const found = await api<Hit[]>(org, `/search?q=${encodeURIComponent(term)}&limit=12`);
				// A slower answer for an older word must not replace the newer one
				if (term === q.trim()) {
					hits = found;
					active = 0;
				}
			} catch {
				failed = true;
				hits = [];
			}
		}, 180);
	}

	function pick(e: Entry | undefined) {
		if (!e) return;
		onclose();
		void goto(e.href);
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			active = Math.min(entries.length - 1, active + 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			active = Math.max(0, active - 1);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			// Enter on a word with no result opens the full search page for it
			if (q.trim() && entries.length === 0) {
				onclose();
				void goto(`/${org}/search?q=${encodeURIComponent(q.trim())}`);
			} else pick(entries[active]);
		}
	}

	// -- REACTIVE STATEMENTS -- //

	$effect(() => {
		if (open) {
			q = '';
			hits = [];
			active = 0;
			// The dialog mounts a moment after open, so focus waits for it
			const t = setTimeout(() => input?.focus(), 60);
			return () => clearTimeout(t);
		}
	});
</script>

<!-- THE COMMAND PALETTE (PLAN 3.13). TYPE TO SEARCH THE ORGANISATION, OR PICK A PAGE OF THIS PROJECT, WITH THE ARROW KEYS AND ENTER -->
<ResponsiveModal {open} {onclose} title="Search" size="lg" variant="top">
	<div class="flex flex-col gap-3" data-testid="palette">
		<div class="relative">
			<Search size={18} class="pointer-events-none absolute top-3 left-3 text-muted" />
			<input
				bind:this={input}
				bind:value={q}
				oninput={search}
				onkeydown={onKey}
				type="text"
				role="combobox"
				aria-expanded="true"
				aria-controls={`${uid}-list`}
				aria-activedescendant={entries[active] ? `${uid}-${active}` : undefined}
				aria-label="Search items, documents, decisions and tasks"
				placeholder="Search items, documents, decisions and tasks"
				class="h-11 w-full rounded-lg border border-line bg-surface pr-3 pl-10 text-sm text-ink placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
				data-testid="palette-input"
			/>
		</div>
		{#if failed}
			<p class="px-1 py-6 text-center text-sm text-danger" role="alert">
				The search did not work. Try again.
			</p>
		{:else if q.trim() && entries.length === 0}
			<p class="px-1 py-6 text-center text-sm text-muted">
				Nothing found. Press Enter to open the full search.
			</p>
		{:else}
			<ul
				id={`${uid}-list`}
				role="listbox"
				aria-label={q.trim() ? 'Results' : 'Pages'}
				class="-mx-1"
			>
				{#each entries as e, i (e.key)}
					<li
						id={`${uid}-${i}`}
						role="option"
						aria-selected={i === active}
						class={cn(
							'flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 text-sm',
							i === active ? 'bg-accent-soft text-accent-text' : 'text-ink hover:bg-raised'
						)}
						onmousemove={() => (active = i)}
						onclick={() => pick(e)}
						onkeydown={null}
						data-testid="palette-entry"
					>
						<span class="min-w-0 flex-1 truncate">{e.label}</span>
						<Badge>{e.hint}</Badge>
					</li>
				{/each}
			</ul>
		{/if}
		<p class="px-1 text-xs text-muted">Arrow keys to move, Enter to open, Escape to close.</p>
	</div>
</ResponsiveModal>

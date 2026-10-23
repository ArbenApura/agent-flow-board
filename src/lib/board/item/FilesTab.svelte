<script lang="ts">
	// -- DEP-TYPES -- //
	import type { ItemExtras, ItemView, TabEnv } from '#lib/board/item/types.js';
	// -- MODULES -- //
	import { ApiError, api, upload } from '#lib/board/api.js';
	import { ago } from '#lib/board/status.js';
	import { cn } from '#lib/ui/cn.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	import { askConfirm } from '#lib/ui/confirm.svelte.js';
	// -- DEP-COMPONENTS -- //
	import FileCode from '@lucide/svelte/icons/file-code';
	import FileSpreadsheet from '@lucide/svelte/icons/file-spreadsheet';
	import FileText from '@lucide/svelte/icons/file-text';
	import Film from '@lucide/svelte/icons/film';
	import Globe from '@lucide/svelte/icons/globe';
	import ImageIcon from '@lucide/svelte/icons/image';
	import Lock from '@lucide/svelte/icons/lock';
	import Paperclip from '@lucide/svelte/icons/paperclip';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import Upload from '@lucide/svelte/icons/upload';
	import X from '@lucide/svelte/icons/x';
	// -- COMPONENTS -- //
	import ActionMenu, { type MenuItem } from '#lib/ui/ActionMenu.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import TabCard from '#lib/board/item/TabCard.svelte';
	import TextField from '#lib/ui/TextField.svelte';

	// -- REQUIRED PROPS -- //

	let { detail, extras, env }: { detail: ItemView; extras: ItemExtras; env: TabEnv } = $props();

	// -- TYPES -- //

	type Attachment = ItemExtras['attachments'][number];

	// -- STATES -- //

	let busy = $state(false);
	let caption = $state('');
	let picked = $state<File[]>([]);
	let dragging = $state(false);
	let input = $state<HTMLInputElement>();

	// -- REACTIVE STATES -- //

	const single = $derived(picked.length === 1);

	// -- FUNCTIONS -- //

	/** A small icon for the kind of file, from its extension. Pictures are not previewed: a private file is only readable through a link that expires. */
	function iconFor(filename: string) {
		const ext = filename.split('.').pop()?.toLowerCase() ?? '';
		if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) return ImageIcon;
		if (['xlsx', 'csv', 'tsv'].includes(ext)) return FileSpreadsheet;
		if (['mp4', 'webm'].includes(ext)) return Film;
		if (['json', 'html'].includes(ext)) return FileCode;
		if (['pdf', 'txt', 'md'].includes(ext)) return FileText;
		return Paperclip;
	}

	const size = (n: number) =>
		n < 1024
			? `${n} B`
			: n < 1_048_576
				? `${Math.round(n / 1024)} KB`
				: `${(n / 1_048_576).toFixed(1)} MB`;

	/** Adds files to the queue, skipping one that is already there (same name, size and date). */
	function add(files: File[]) {
		const next = [...picked];
		for (const f of files)
			if (
				!next.some(
					(p) => p.name === f.name && p.size === f.size && p.lastModified === f.lastModified
				)
			)
				next.push(f);
		picked = next;
	}

	function unpick(file: File) {
		picked = picked.filter((p) => p !== file);
	}

	/** The extension in capitals, as the short type shown in the meta line. */
	function kindOf(filename: string) {
		const ext = filename.includes('.') ? filename.split('.').pop() : '';
		return ext ? ext.toUpperCase() : 'File';
	}

	/** Sends the queue one file after another. A file that fails stays in the queue so it can be tried again. */
	async function send() {
		if (picked.length === 0 || busy) return;
		busy = true;
		const total = picked.length;
		const named = single ? caption.trim() : '';
		try {
			await toast.promise(
				(async () => {
					let failed: string | null = null;
					for (const file of [...picked]) {
						try {
							await upload(env.org, `/items/${detail.item.ref}/attachments`, file, {
								filename: file.name,
								caption: named || file.name,
								kind: 'file'
							});
							unpick(file);
						} catch (e) {
							failed ??= e instanceof ApiError ? e.message : `${file.name} was not attached.`;
						}
					}
					if (failed) throw new Error(failed);
				})(),
				{
					loading: total === 1 ? `Attaching ${picked[0]?.name}...` : `Attaching ${total} files...`,
					success: total === 1 ? 'File attached.' : `${total} files attached.`,
					error: (e) => (e instanceof Error ? e.message : 'The files were not attached.')
				}
			);
			caption = '';
		} catch {
			// The promise toast already shows the failure
		} finally {
			busy = false;
			await env.onchanged();
		}
	}

	async function open(id: string) {
		try {
			const link = await api<{ url: string }>(env.org, `/attachments/${id}/link`);
			window.open(link.url, '_blank', 'noopener');
		} catch (e) {
			toast.error(e instanceof ApiError ? e.message : 'The link could not be made.');
		}
	}

	/** Flips one file between private and public. Making it public asks first, because anyone who sees the item can then open it. */
	async function setVisibility(id: string, visibility: 'public' | 'private') {
		if (
			visibility === 'public' &&
			!(await askConfirm({
				title: 'Make this file public?',
				body: 'Anyone who can see this item will be able to open it.',
				confirmLabel: 'Make public'
			}))
		)
			return;
		try {
			await toast.promise(
				api(env.org, `/attachments/${id}`, { method: 'PATCH', body: { visibility } }),
				{
					loading: 'Changing who can open the file...',
					success: visibility === 'public' ? 'The file is public.' : 'The file is private.',
					error: (e) => (e instanceof ApiError ? e.message : 'The file was not changed.')
				}
			);
			await env.onchanged();
		} catch {
			// The promise toast already shows the failure
		}
	}

	async function remove(id: string) {
		if (
			!(await askConfirm({
				title: 'Remove this file?',
				body: 'It goes to the trash for 30 days, then it is deleted for good.',
				confirmLabel: 'Remove'
			}))
		)
			return;
		try {
			await toast.promise(api(env.org, `/attachments/${id}`, { method: 'DELETE' }), {
				loading: 'Removing the file...',
				success: 'Moved to the trash.',
				error: (e) => (e instanceof ApiError ? e.message : 'The file was not removed.')
			});
			await env.onchanged();
		} catch {
			// The promise toast already shows the failure
		}
	}

	/** The menu of one file: who can open it, and removing it. */
	function menuFor(a: Attachment): MenuItem[] {
		return [
			a.visibility === 'public'
				? { label: 'Make private', icon: Lock, onselect: () => setVisibility(a.id, 'private') }
				: { label: 'Make public', icon: Globe, onselect: () => setVisibility(a.id, 'public') },
			{ label: 'Remove', icon: Trash2, danger: true, onselect: () => remove(a.id) }
		];
	}
</script>

<div class="flex flex-col gap-6" data-testid="files-tab">
	{#if env.canWrite}
		<TabCard role="region" aria-label="File upload">
			{#snippet heading()}Attach files{/snippet}
			<form
				class="flex flex-col gap-3 p-4 max-sm:p-3.5"
				onsubmit={(e) => {
					e.preventDefault();
					void send();
				}}
			>
				<!-- DROP ZONE: THE NATIVE INPUT COVERS IT, SO A CLICK, A TAP, THE KEYBOARD AND A DROP ALL WORK -->
				<div
					class={cn(
						'relative flex min-h-28 flex-col items-center justify-center gap-1 rounded-lg border border-dashed px-4 py-5 text-center',
						dragging ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-raised'
					)}
					role="presentation"
					ondragover={(e) => {
						e.preventDefault();
						dragging = true;
					}}
					ondragleave={() => (dragging = false)}
					ondrop={(e) => {
						e.preventDefault();
						dragging = false;
						add([...(e.dataTransfer?.files ?? [])]);
					}}
				>
					<Upload size={20} class="text-muted" aria-hidden="true" />
					<span class="text-sm font-medium">
						Drop files here or <span class="text-accent-text">browse</span>
					</span>
					<span class="text-xs text-muted"
						>Up to 100 MB each. Files are private until you make them public.</span
					>
					<input
						bind:this={input}
						type="file"
						multiple
						aria-label="Choose files to attach"
						class="absolute inset-0 size-full cursor-pointer opacity-0"
						onchange={(e) => {
							add([...(e.currentTarget.files ?? [])]);
							e.currentTarget.value = '';
						}}
					/>
				</div>

				{#if picked.length > 0}
					<!-- THE QUEUE: WHAT WILL BE SENT, WITH A WAY TO TAKE ONE OUT -->
					<ul class="flex flex-col" aria-label="Files ready to attach">
						{#each picked as f (`${f.name}:${f.size}:${f.lastModified}`)}
							{@const Icon = iconFor(f.name)}
							<li class="flex min-h-11 items-center gap-3 border-b border-line last:border-b-0">
								<Icon size={16} class="shrink-0 text-muted" aria-hidden="true" />
								<span class="min-w-0 flex-1 truncate text-sm">{f.name}</span>
								<span class="shrink-0 text-xs text-muted tabular-nums">{size(f.size)}</span>
								<Button
									size="sm"
									variant="ghost"
									iconOnly
									aria-label={`Take ${f.name} out of the list`}
									disabled={busy}
									onclick={() => unpick(f)}><X size={16} /></Button
								>
							</li>
						{/each}
					</ul>
					<div class="flex flex-wrap items-end gap-2">
						{#if single}
							<TextField
								label="Caption (optional)"
								bind:value={caption}
								placeholder="What the file shows"
								class="min-w-48 flex-1"
							/>
						{:else}
							<span class="min-w-48 flex-1 text-sm text-muted"
								>Each file is captioned with its file name.</span
							>
						{/if}
						<Button type="submit" variant="primary" loading={busy}
							>{picked.length === 1 ? 'Attach file' : `Attach ${picked.length} files`}</Button
						>
					</div>
				{/if}
			</form>
		</TabCard>
	{/if}

	{#if extras.attachments.length === 0}
		<EmptyState
			kind="files"
			title="No files attached"
			text="Screenshots, documents and check results attached to this item appear here. Files are private by default."
		/>
	{:else}
		<TabCard role="region" aria-label="Attached files">
			{#snippet heading()}Files{/snippet}
			{#snippet meta()}
				<span class="text-sm text-muted tabular-nums">{extras.attachments.length}</span>
			{/snippet}
			<ul>
				{#each extras.attachments as a (a.id)}
					{@const Icon = iconFor(a.filename)}
					<li
						class="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-2.5 last:border-b-0 max-sm:px-3.5 sm:flex-nowrap"
						data-row
						data-testid="attachment"
					>
						<span
							class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-raised text-muted"
							aria-hidden="true"
						>
							<Icon size={20} />
						</span>
						<span class="min-w-0 flex-1 text-sm">
							<span class="block truncate font-medium">{a.caption}</span>
							<span class="block truncate text-xs text-muted"
								>{kindOf(a.filename)} · {size(a.size)} · {ago(a.createdAt)}{a.caption !== a.filename
									? ` · ${a.filename}`
									: ''}</span
							>
						</span>
						<!-- ON A PHONE THE BADGE AND BUTTONS DROP TO THEIR OWN LINE UNDER THE CAPTION -->
						<span class="flex w-full items-center gap-2 pl-[52px] sm:w-auto sm:pl-0">
							<Badge tone={a.visibility === 'public' ? 'info' : 'neutral'}>
								{#if a.visibility === 'public'}<Globe size={12} aria-hidden="true" />{:else}<Lock
										size={12}
										aria-hidden="true"
									/>{/if}
								{a.visibility === 'public' ? 'Public' : 'Private'}
							</Badge>
							<span class="flex-1 sm:hidden"></span>
							<Button size="sm" onclick={() => open(a.id)}>Open</Button>
							{#if env.canWrite}
								<ActionMenu items={menuFor(a)} label={`More actions for ${a.caption}`} size="sm" />
							{/if}
						</span>
					</li>
				{/each}
			</ul>
		</TabCard>
	{/if}
</div>

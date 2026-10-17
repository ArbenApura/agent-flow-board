<script lang="ts">
	// -- DEP-TYPES -- //
	import type { ItemExtras, ItemView, TabEnv } from '#lib/board/item/types.js';
	// -- MODULES -- //
	import { ApiError, api, upload } from '#lib/board/api.js';
	import { ago } from '#lib/board/status.js';
	import TabCard from '#lib/board/item/TabCard.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import FilePicker from '#lib/ui/FilePicker.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';
	import { askConfirm } from '#lib/ui/confirm.svelte.js';
	// -- DEP-COMPONENTS -- //
	import FileCode from '@lucide/svelte/icons/file-code';
	import FileSpreadsheet from '@lucide/svelte/icons/file-spreadsheet';
	import FileText from '@lucide/svelte/icons/file-text';
	import Film from '@lucide/svelte/icons/film';
	import ImageIcon from '@lucide/svelte/icons/image';
	import Paperclip from '@lucide/svelte/icons/paperclip';

	// -- REQUIRED PROPS -- //

	let { detail, extras, env }: { detail: ItemView; extras: ItemExtras; env: TabEnv } = $props();

	// -- STATES -- //

	let busy = $state(false);
	let caption = $state('');
	let input = $state<HTMLInputElement>();

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

	async function send() {
		const file = input?.files?.[0];
		if (!file) return;
		busy = true;
		try {
			await toast.promise(
				upload(env.org, `/items/${detail.item.ref}/attachments`, file, {
					filename: file.name,
					caption: caption.trim() || file.name,
					kind: 'file'
				}),
				{
					loading: `Attaching ${file.name}...`,
					success: 'File attached. It is private until someone makes it public.',
					error: (e) => (e instanceof ApiError ? e.message : 'The file was not attached.')
				}
			);
			caption = '';
			if (input) {
				input.value = '';
				input.dispatchEvent(new Event('change'));
			}
			await env.onchanged();
		} catch {
			// The promise toast already shows the failure
		} finally {
			busy = false;
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
</script>

<div class="flex flex-col gap-6" data-testid="files-tab">
	{#if env.canWrite}
		<TabCard role="region" aria-label="File upload">
			{#snippet heading()}Attach a file{/snippet}
			<form
				class="flex flex-wrap items-end gap-2 p-4 max-sm:p-3.5"
				onsubmit={(e) => {
					e.preventDefault();
					void send();
				}}
			>
				<FilePicker label="File" required bind:el={input} class="min-w-48 flex-1" />
				<TextField
					label="Caption"
					bind:value={caption}
					placeholder="What the file shows"
					class="min-w-48 flex-1"
				/>
				<Button type="submit" variant="primary" loading={busy}>Attach</Button>
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
						class="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-2 last:border-b-0 max-sm:px-3.5 sm:flex-nowrap"
						data-row
						data-testid="attachment"
					>
						<Icon size={16} class="shrink-0 text-muted" aria-hidden="true" />
						<span class="min-w-0 flex-1 text-sm">
							<span class="block truncate font-medium">{a.caption}</span>
							<span class="block truncate text-xs text-muted"
								>{a.filename}, {size(a.size)}, {ago(a.createdAt)}</span
							>
						</span>
						<!-- ON A PHONE THE BADGE AND BUTTONS DROP TO THEIR OWN LINE UNDER THE CAPTION -->
						<span class="flex w-full items-center gap-2 pl-7 sm:w-auto sm:pl-0">
							<Badge tone={a.visibility === 'public' ? 'info' : 'neutral'}>{a.visibility}</Badge>
							<span class="flex-1 sm:hidden"></span>
							<Button size="sm" onclick={() => open(a.id)}>Open</Button>
							{#if env.canWrite}
								<Button size="sm" variant="ghost" onclick={() => remove(a.id)}>Remove</Button>
							{/if}
						</span>
					</li>
				{/each}
			</ul>
		</TabCard>
	{/if}
</div>

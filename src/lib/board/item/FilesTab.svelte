<script lang="ts">
	// -- DEP-TYPES -- //
	import type { ItemExtras, ItemView, TabEnv } from '#lib/board/item/types.js';
	// -- MODULES -- //
	import { ApiError, api, upload } from '#lib/board/api.js';
	import { ago } from '#lib/board/status.js';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';
	import { askConfirm } from '#lib/ui/confirm.svelte.js';
	// -- DEP-COMPONENTS -- //
	import Paperclip from 'phosphor-svelte/lib/Paperclip';

	// -- REQUIRED PROPS -- //

	let { detail, extras, env }: { detail: ItemView; extras: ItemExtras; env: TabEnv } = $props();

	// -- STATES -- //

	let busy = $state(false);
	let caption = $state('');
	let input = $state<HTMLInputElement>();

	// -- FUNCTIONS -- //

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
			await upload(env.org, `/items/${detail.item.ref}/attachments`, file, {
				filename: file.name,
				caption: caption.trim() || file.name,
				kind: 'file'
			});
			caption = '';
			if (input) input.value = '';
			toast.success('File attached. It is private until someone makes it public.');
			await env.onchanged();
		} catch (e) {
			toast.error(e instanceof ApiError ? e.message : 'The file was not attached.');
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
			await api(env.org, `/attachments/${id}`, { method: 'DELETE' });
			toast.success('Moved to the trash.');
			await env.onchanged();
		} catch (e) {
			toast.error(e instanceof ApiError ? e.message : 'The file was not removed.');
		}
	}
</script>

<div class="flex flex-col gap-4" data-testid="files-tab">
	{#if env.canWrite}
		<form
			class="flex flex-wrap items-end gap-2 rounded-xl border border-line bg-surface p-3"
			onsubmit={(e) => {
				e.preventDefault();
				void send();
			}}
		>
			<label class="flex min-w-48 flex-1 flex-col gap-1 text-xs font-medium text-ink">
				File
				<input
					bind:this={input}
					type="file"
					required
					class="min-h-11 text-sm file:mr-3 file:min-h-9 file:cursor-pointer file:rounded-lg file:border file:border-line file:bg-surface file:px-3 file:text-sm"
				/>
			</label>
			<label class="flex min-w-48 flex-1 flex-col gap-1 text-xs font-medium text-ink">
				Caption
				<input
					bind:value={caption}
					class="h-11 rounded-lg border border-line bg-surface px-3 text-sm"
					placeholder="What the file shows"
				/>
			</label>
			<Button type="submit" variant="primary" loading={busy}>Attach</Button>
		</form>
	{/if}

	{#if extras.attachments.length === 0}
		<EmptyState
			title="No files attached"
			text="Screenshots, documents and check results attached to this item appear here. Files are private by default."
		/>
	{:else}
		<ul class="rounded-xl border border-line bg-surface">
			{#each extras.attachments as a (a.id)}
				<li
					class="flex min-h-12 items-center gap-3 border-b border-line px-3 py-2 last:border-b-0"
					data-row
					data-testid="attachment"
				>
					<Paperclip size={16} class="shrink-0 text-muted" />
					<span class="min-w-0 flex-1 text-sm">
						<span class="block truncate font-medium">{a.caption}</span>
						<span class="block truncate text-xs text-muted"
							>{a.filename}, {size(a.size)}, {ago(a.createdAt)}</span
						>
					</span>
					<Badge tone={a.visibility === 'public' ? 'info' : 'neutral'}>{a.visibility}</Badge>
					<Button size="sm" onclick={() => open(a.id)}>Open</Button>
					{#if env.canWrite}
						<Button size="sm" variant="ghost" onclick={() => remove(a.id)}>Remove</Button>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>

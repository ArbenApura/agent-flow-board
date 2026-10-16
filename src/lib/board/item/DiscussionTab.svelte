<script lang="ts">
	// -- DEP-TYPES -- //
	import type { ItemExtras, ItemView, TabEnv } from '#lib/board/item/types.js';
	// -- MODULES -- //
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import { ago } from '#lib/board/status.js';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import TextArea from '#lib/ui/TextArea.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';

	// -- REQUIRED PROPS -- //

	let { detail, extras, env }: { detail: ItemView; extras: ItemExtras; env: TabEnv } = $props();

	// -- STATES -- //

	let text = $state('');
	let busy = $state(false);

	// -- FUNCTIONS -- //

	async function post() {
		busy = true;
		try {
			await toast.promise(
				api(env.org, `/items/${detail.item.ref}/comments`, {
					body: { body: text.trim() },
					key: newKey()
				}),
				{
					loading: 'Posting...',
					success: 'Comment posted.',
					error: (e) => (e instanceof ApiError ? e.message : 'The comment was not posted.')
				}
			);
			text = '';
			await env.onchanged();
		} catch {
			// The promise toast already shows the failure
		} finally {
			busy = false;
		}
	}
</script>

<div class="flex flex-col gap-4" data-testid="discussion-tab">
	{#if env.canComment}
		<form
			class="flex flex-col gap-2"
			onsubmit={(e) => {
				e.preventDefault();
				void post();
			}}
		>
			<TextArea label="Add a comment" bind:value={text} rows={3} data-testid="comment-text" />
			<div>
				<Button type="submit" variant="primary" loading={busy} data-testid="comment-submit"
					>Post comment</Button
				>
			</div>
		</form>
	{/if}

	{#if extras.comments.length === 0}
		<EmptyState title="No comments yet" text="Questions and notes about this item go here." />
	{:else}
		<ul class="flex flex-col gap-3">
			{#each extras.comments as c (c.id)}
				<li
					class="rounded-xl border border-line bg-surface p-3 shadow-[var(--elev-1)]"
					data-testid="comment"
				>
					<div class="mb-1 flex items-center gap-2 text-xs text-muted">
						<span class="font-medium text-ink">{detail.people[c.authorId ?? ''] ?? 'Someone'}</span>
						{ago(c.createdAt)}
						{#if c.untrusted}<Badge tone="warning">guest</Badge>{/if}
					</div>
					<div class="md">
						<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitised Markdown from the server -->
						{@html c.html}
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</div>

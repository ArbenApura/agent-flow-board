<script lang="ts">
	// -- DEP-TYPES -- //
	import type { ItemExtras, ItemView, TabEnv } from '#lib/board/item/types.js';
	// -- MODULES -- //
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import { ago } from '#lib/board/status.js';
	import TabCard from '#lib/board/item/TabCard.svelte';
	import Avatar from '#lib/ui/Avatar.svelte';
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

<div class="flex flex-col gap-6" data-testid="discussion-tab">
	{#if env.canComment}
		<!-- THE COMPOSER. THE POST BUTTON IS THE ONE PRIMARY ACTION OF THIS TAB -->
		<TabCard role="region" aria-label="Comment form">
			{#snippet heading()}Add a comment{/snippet}
			<form
				class="flex flex-col gap-3 p-4 max-sm:p-3.5"
				onsubmit={(e) => {
					e.preventDefault();
					void post();
				}}
			>
				<TextArea label="Add a comment" bind:value={text} rows={3} data-testid="comment-text" />
				<div class="flex justify-end">
					<Button type="submit" variant="primary" loading={busy} data-testid="comment-submit"
						>Post comment</Button
					>
				</div>
			</form>
		</TabCard>
	{/if}

	{#if extras.comments.length === 0}
		<EmptyState
			kind="discussion"
			title="No comments yet"
			text="Questions and notes about this item go here."
		/>
	{:else}
		<ul class="flex flex-col gap-4">
			{#each extras.comments as c (c.id)}
				{@const who = detail.people[c.authorId ?? ''] ?? 'Someone'}
				<li class="flex items-start gap-3" data-testid="comment">
					<Avatar name={who} size={32} class="mt-0.5" />
					<div
						class="min-w-0 flex-1 rounded-xl border border-line bg-surface p-4 shadow-[var(--elev-1)] max-sm:p-3.5"
					>
						<div class="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
							<span class="text-sm font-medium text-ink">{who}</span>
							<span>{ago(c.createdAt)}</span>
							{#if c.untrusted}<Badge tone="warning">guest</Badge>{/if}
						</div>
						<div class="md">
							<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitised Markdown from the server -->
							{@html c.html}
						</div>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</div>

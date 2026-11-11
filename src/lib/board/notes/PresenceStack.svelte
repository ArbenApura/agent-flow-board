<script lang="ts">
	// -- TYPES -- //
	import type { Peer } from '#lib/realtime/noteProvider.js';
	// -- COMPONENTS -- //
	import Avatar from '#lib/ui/Avatar.svelte';

	// -- REQUIRED PROPS -- //

	let {
		peers
	}: {
		/** The other people who have this note open, one entry per person. */
		peers: Peer[];
	} = $props();

	// -- CONSTANTS -- //

	/** More people than this are counted in a "+n" chip. */
	const SHOWN = 4;

	// -- REACTIVE STATES -- //

	const shown = $derived(peers.slice(0, SHOWN));
	const more = $derived(Math.max(0, peers.length - SHOWN));
	const names = $derived(peers.map((p) => p.name).join(', '));
</script>

<!-- WHO HAS THE NOTE OPEN RIGHT NOW. THE NAMES ARE IN THE LABEL, SO THE ROW NEVER RELIES ON THE PICTURES -->
{#if peers.length > 0}
	<div
		role="group"
		aria-label={`Open now: ${names}`}
		title={`Open now: ${names}`}
		data-testid="note-presence"
		class="flex items-center -space-x-2"
	>
		{#each shown as p (p.id)}
			<Avatar name={p.name} userId={p.id} v={p.v} size={24} class="ring-2 ring-surface" />
		{/each}
		{#if more > 0}
			<span
				class="inline-flex size-6 items-center justify-center rounded-full bg-raised text-xs font-semibold text-muted ring-2 ring-surface"
				aria-hidden="true">+{more}</span
			>
		{/if}
	</div>
{/if}

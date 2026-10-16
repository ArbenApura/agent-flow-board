<script lang="ts">
	// -- REQUIRED PROPS -- //

	let { size = 24, class: extra }: { size?: number; class?: string } = $props();
</script>

<!-- THE MARK: THREE NODES JOINED BY A PATH, THE LAST ONE A CHECK. COLOURS FOLLOW THE TOKENS (design/mark/) -->
<svg
	width={size}
	height={size}
	viewBox="0 0 32 32"
	fill="none"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
	class={extra}
>
	<circle cx="6" cy="22" r="3" fill="var(--accent)" />
	<circle cx="14" cy="10" r="3" fill="var(--accent)" />
	<path d="M8.2 19.8L11.8 12.2" stroke="var(--accent)" stroke-width="2" />
	<path d="M17.2 11.6c3 .8 4.6 3.4 5.6 6.2" stroke="var(--accent)" stroke-width="2" />
	<circle cx="24" cy="21" r="6.5" fill="var(--accent)" />
	<path d="M21 21l2.2 2.2L27.2 19" stroke="var(--accent-ink)" stroke-width="2.2" />
</svg>

<script lang="ts">
	// -- REQUIRED PROPS -- //

	let {
		kind = 'items',
		class: extra
	}: { kind?: 'items' | 'search' | 'inbox' | 'error' | 'welcome'; class?: string } = $props();
</script>

<!-- THE ONE ILLUSTRATION STYLE (ADR-005). ROUNDED SHAPES IN THE SURFACE, LINE AND ACCENT TOKENS, FOR EMPTY AND WELCOME SCREENS ONLY -->
<svg viewBox="0 0 160 112" width="160" height="112" fill="none" aria-hidden="true" class={extra}>
	{#if kind === 'search'}
		<rect
			x="22"
			y="22"
			width="92"
			height="64"
			rx="10"
			fill="var(--surface)"
			stroke="var(--line)"
			stroke-width="2"
		/>
		<rect x="34" y="36" width="44" height="6" rx="3" fill="var(--raised)" />
		<rect x="34" y="50" width="62" height="6" rx="3" fill="var(--raised)" />
		<rect x="34" y="64" width="30" height="6" rx="3" fill="var(--raised)" />
		<circle
			cx="108"
			cy="72"
			r="20"
			fill="var(--accent-soft)"
			stroke="var(--accent)"
			stroke-width="3"
		/>
		<path d="M123 87l14 14" stroke="var(--accent)" stroke-width="4" stroke-linecap="round" />
	{:else if kind === 'inbox'}
		<path
			d="M24 62l14-30h84l14 30v30a8 8 0 01-8 8H32a8 8 0 01-8-8V62z"
			fill="var(--surface)"
			stroke="var(--line)"
			stroke-width="2"
			stroke-linejoin="round"
		/>
		<path d="M24 62h38a18 18 0 0036 0h38" stroke="var(--line)" stroke-width="2" />
		<rect
			x="58"
			y="14"
			width="44"
			height="30"
			rx="6"
			fill="var(--accent-soft)"
			stroke="var(--accent)"
			stroke-width="2"
		/>
		<path
			d="M68 29l8 8 16-16"
			stroke="var(--accent)"
			stroke-width="3"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
	{:else if kind === 'error'}
		<rect
			x="30"
			y="20"
			width="100"
			height="72"
			rx="12"
			fill="var(--surface)"
			stroke="var(--line)"
			stroke-width="2"
		/>
		<circle
			cx="80"
			cy="50"
			r="16"
			fill="var(--danger-soft)"
			stroke="var(--danger)"
			stroke-width="3"
		/>
		<path d="M80 43v9" stroke="var(--danger)" stroke-width="3" stroke-linecap="round" />
		<circle cx="80" cy="58" r="1.8" fill="var(--danger)" />
		<rect x="52" y="74" width="56" height="6" rx="3" fill="var(--raised)" />
	{:else if kind === 'welcome'}
		<rect
			x="14"
			y="30"
			width="40"
			height="64"
			rx="8"
			fill="var(--surface)"
			stroke="var(--line)"
			stroke-width="2"
		/>
		<rect
			x="60"
			y="18"
			width="40"
			height="76"
			rx="8"
			fill="var(--accent-soft)"
			stroke="var(--accent)"
			stroke-width="2"
		/>
		<rect
			x="106"
			y="40"
			width="40"
			height="54"
			rx="8"
			fill="var(--surface)"
			stroke="var(--line)"
			stroke-width="2"
		/>
		<rect x="22" y="42" width="24" height="6" rx="3" fill="var(--raised)" />
		<rect x="68" y="30" width="24" height="6" rx="3" fill="var(--accent)" opacity="0.5" />
		<rect x="114" y="52" width="24" height="6" rx="3" fill="var(--raised)" />
		<circle cx="80" cy="64" r="9" fill="var(--accent)" />
		<path
			d="M75.5 64l3 3 6-6"
			stroke="var(--accent-ink)"
			stroke-width="2.4"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
	{:else}
		<rect
			x="20"
			y="22"
			width="52"
			height="70"
			rx="8"
			fill="var(--surface)"
			stroke="var(--line)"
			stroke-width="2"
		/>
		<rect x="28" y="34" width="36" height="6" rx="3" fill="var(--raised)" />
		<rect x="28" y="48" width="26" height="6" rx="3" fill="var(--raised)" />
		<rect
			x="88"
			y="14"
			width="52"
			height="86"
			rx="8"
			fill="var(--accent-soft)"
			stroke="var(--accent)"
			stroke-width="2"
			stroke-dasharray="5 4"
		/>
		<path d="M114 48v20M104 58h20" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" />
	{/if}
</svg>

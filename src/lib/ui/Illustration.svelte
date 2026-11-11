<script lang="ts" module>
	// -- TYPES -- //

	export type IllustrationKind =
		| 'items'
		| 'search'
		| 'inbox'
		| 'error'
		| 'welcome'
		| 'plan'
		| 'files'
		| 'docs'
		| 'discussion'
		| 'decisions'
		| 'checks'
		| 'shots'
		| 'trash'
		| 'unplugged'
		| 'repo'
		| 'tasks'
		| 'projects'
		| 'org'
		| 'locked'
		| 'tools'
		| 'events';
</script>

<script lang="ts">
	// -- OPTIONAL PROPS -- //

	let { kind = 'items', class: extra }: { kind?: IllustrationKind; class?: string } = $props();

	// -- CONSTANTS -- //

	// Pattern and mask ids must be unique per instance, two pictures can sit on one page
	const uid = $props.id();
</script>

<!-- THE ONE ILLUSTRATION STYLE (ADR-005). ROUNDED SHAPES IN THE SURFACE, LINE AND ACCENT TOKENS, FOR EMPTY AND WELCOME SCREENS ONLY. EACH KIND TELLS ITS OWN SCENE, ALL SHARE A DOTTED GROUND, HATCHED SHADOWS AND SMALL SPARKS FOR TEXTURE -->
<svg viewBox="0 0 160 112" width="160" height="112" fill="none" aria-hidden="true" class={extra}>
	<!-- TEXTURE AND SHARED PARTS -->
	<defs>
		<pattern id="{uid}-dots" width="8" height="8" patternUnits="userSpaceOnUse">
			<circle cx="2" cy="2" r="1" fill="var(--line)" />
		</pattern>
		<pattern
			id="{uid}-hatch"
			width="4"
			height="4"
			patternUnits="userSpaceOnUse"
			patternTransform="rotate(45)"
		>
			<path d="M0 0v4" stroke="var(--line)" stroke-width="1.2" />
		</pattern>
		<pattern
			id="{uid}-hatch-accent"
			width="4"
			height="4"
			patternUnits="userSpaceOnUse"
			patternTransform="rotate(45)"
		>
			<path d="M0 0v4" stroke="var(--accent)" stroke-width="1" opacity="0.4" />
		</pattern>
		<radialGradient id="{uid}-fade" cx="0.5" cy="0.5" r="0.5">
			<stop offset="0.45" stop-color="var(--ink)" stop-opacity="1" />
			<stop offset="1" stop-color="var(--ink)" stop-opacity="0" />
		</radialGradient>
		<mask id="{uid}-ground" class="[mask-type:alpha]">
			<ellipse cx="80" cy="58" rx="78" ry="52" fill="url(#{uid}-fade)" />
		</mask>
	</defs>

	{#snippet sheet(x: number, y: number, w: number, h: number, r: number = 8)}
		<!-- A SHEET WITH A HATCHED SHADOW OFFSET BEHIND IT -->
		<rect
			x={x + 3}
			y={y + 3}
			width={w}
			height={h}
			rx={r}
			fill="url(#{uid}-hatch)"
			stroke="var(--line)"
			stroke-width="1.5"
		/>
		<rect
			{x}
			{y}
			width={w}
			height={h}
			rx={r}
			fill="var(--surface)"
			stroke="var(--line)"
			stroke-width="2"
		/>
	{/snippet}
	{#snippet bar(x: number, y: number, w: number)}
		<rect {x} {y} width={w} height="5" rx="2.5" fill="var(--raised)" />
	{/snippet}
	{#snippet accentBar(x: number, y: number, w: number)}
		<rect {x} {y} width={w} height="5" rx="2.5" fill="var(--accent)" opacity="0.55" />
	{/snippet}
	{#snippet spark(x: number, y: number)}
		<path
			d="M{x} {y - 3}v6M{x - 3} {y}h6"
			stroke="var(--accent)"
			stroke-width="1.5"
			stroke-linecap="round"
			opacity="0.6"
		/>
	{/snippet}
	{#snippet speck(x: number, y: number)}
		<circle cx={x} cy={y} r="1.8" fill="var(--accent)" opacity="0.45" />
	{/snippet}

	<!-- DOTTED GROUND, FADING OUT TOWARD THE EDGES -->
	<rect width="160" height="112" fill="url(#{uid}-dots)" mask="url(#{uid}-ground)" />

	{#if kind === 'search'}
		<!-- A LIST WITH A MAGNIFIER OVER IT, FOUND NOTHING -->
		{@render sheet(22, 18, 92, 64)}
		{@render bar(34, 32, 44)}
		{@render bar(34, 46, 62)}
		{@render bar(34, 60, 30)}
		<circle
			cx="108"
			cy="72"
			r="20"
			fill="var(--accent-soft)"
			stroke="var(--accent)"
			stroke-width="3"
		/>
		<path
			d="M96 66a14 14 0 0114-8"
			stroke="var(--accent)"
			stroke-width="2"
			stroke-linecap="round"
			opacity="0.5"
		/>
		<path d="M123 87l14 14" stroke="var(--accent)" stroke-width="5" stroke-linecap="round" />
		{@render spark(138, 28)}
		{@render speck(14, 96)}
	{:else if kind === 'inbox'}
		<!-- A TRAY WITH A CARD DROPPING IN -->
		<path
			d="M27 65l14-30h84l14 30v30a8 8 0 01-8 8H35a8 8 0 01-8-8V65z"
			fill="url(#{uid}-hatch)"
			stroke="var(--line)"
			stroke-width="1.5"
			stroke-linejoin="round"
		/>
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
			y="12"
			width="44"
			height="30"
			rx="6"
			fill="var(--accent-soft)"
			stroke="var(--accent)"
			stroke-width="2"
		/>
		<path
			d="M68 27l8 8 16-16"
			stroke="var(--accent)"
			stroke-width="3"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
		<path
			d="M40 14v8M120 10v8"
			stroke="var(--accent)"
			stroke-width="1.5"
			stroke-linecap="round"
			opacity="0.4"
			stroke-dasharray="1 4"
		/>
		{@render spark(30, 22)}
		{@render spark(132, 36)}
	{:else if kind === 'error'}
		<!-- A BROKEN PAGE WITH A WARNING -->
		{@render sheet(30, 16, 100, 76, 12)}
		<circle
			cx="80"
			cy="46"
			r="16"
			fill="var(--danger-soft)"
			stroke="var(--danger)"
			stroke-width="3"
		/>
		<path d="M80 39v9" stroke="var(--danger)" stroke-width="3" stroke-linecap="round" />
		<circle cx="80" cy="54" r="1.8" fill="var(--danger)" />
		{@render bar(52, 72, 56)}
		<path
			d="M118 16l-8 14 10 4-8 16"
			stroke="var(--danger)"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			opacity="0.6"
		/>
		{@render speck(18, 30)}
		{@render speck(146, 84)}
	{:else if kind === 'welcome'}
		<!-- THREE LANES OF A BOARD, WITH ONE CARD DONE IN THE MIDDLE LANE -->
		<rect
			x="12"
			y="26"
			width="42"
			height="72"
			rx="8"
			fill="var(--surface)"
			stroke="var(--line)"
			stroke-width="2"
		/>
		<rect
			x="60"
			y="14"
			width="42"
			height="84"
			rx="8"
			fill="var(--accent-soft)"
			stroke="var(--accent)"
			stroke-width="2"
		/>
		<rect
			x="108"
			y="38"
			width="42"
			height="60"
			rx="8"
			fill="var(--surface)"
			stroke="var(--line)"
			stroke-width="2"
		/>
		<!-- LANE TITLES -->
		<rect x="19" y="35" width="16" height="4" rx="2" fill="var(--raised)" />
		<rect x="67" y="23" width="16" height="4" rx="2" fill="var(--accent)" opacity="0.5" />
		<rect x="115" y="47" width="16" height="4" rx="2" fill="var(--raised)" />
		<!-- CARDS -->
		<rect
			x="18"
			y="45"
			width="30"
			height="18"
			rx="5"
			fill="var(--bg)"
			stroke="var(--line)"
			stroke-width="1.5"
		/>
		<rect x="23" y="51" width="16" height="3" rx="1.5" fill="var(--raised)" />
		<rect
			x="18"
			y="69"
			width="30"
			height="18"
			rx="5"
			fill="var(--bg)"
			stroke="var(--line)"
			stroke-width="1.5"
		/>
		<rect x="23" y="75" width="12" height="3" rx="1.5" fill="var(--raised)" />
		<rect
			x="66"
			y="33"
			width="30"
			height="18"
			rx="5"
			fill="var(--surface)"
			stroke="var(--accent)"
			stroke-width="1.5"
		/>
		<rect x="71" y="39" width="16" height="3" rx="1.5" fill="var(--accent)" opacity="0.5" />
		<rect x="66" y="57" width="30" height="30" rx="6" fill="var(--accent)" />
		<path
			d="M75 72l4 4 8-8"
			stroke="var(--accent-ink)"
			stroke-width="2.6"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
		<rect
			x="114"
			y="57"
			width="30"
			height="18"
			rx="5"
			fill="var(--bg)"
			stroke="var(--line)"
			stroke-width="1.5"
		/>
		<rect x="119" y="63" width="12" height="3" rx="1.5" fill="var(--raised)" />
		<circle cx="137" cy="66" r="3" fill="var(--accent)" />
		{@render spark(104, 18)}
	{:else if kind === 'plan'}
		<!-- A PLAN: PHASES ON A LADDER, THE NEXT RUNG IS WAITING TO BE ADDED -->
		{@render sheet(20, 12, 120, 88, 10)}
		<path
			d="M42 32v44"
			stroke="var(--line)"
			stroke-width="2"
			stroke-dasharray="2 4"
			stroke-linecap="round"
		/>
		<circle cx="42" cy="28" r="7" fill="var(--bg)" stroke="var(--line)" stroke-width="2" />
		<circle cx="42" cy="52" r="7" fill="var(--bg)" stroke="var(--line)" stroke-width="2" />
		<circle
			cx="42"
			cy="76"
			r="7"
			fill="var(--accent-soft)"
			stroke="var(--accent)"
			stroke-width="2"
			stroke-dasharray="3 2.5"
		/>
		<path d="M42 72.5v7M38.5 76h7" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" />
		{@render bar(58, 22, 56)}
		{@render bar(58, 31, 34)}
		{@render bar(58, 46, 48)}
		{@render bar(58, 55, 62)}
		<rect
			x="56"
			y="68"
			width="68"
			height="16"
			rx="6"
			fill="url(#{uid}-hatch-accent)"
			stroke="var(--accent)"
			stroke-width="1.5"
			stroke-dasharray="4 3"
		/>
		{@render spark(146, 22)}
		{@render speck(12, 90)}
	{:else if kind === 'files'}
		<!-- A PHOTO SHEET AND A PAPER CLIP, NOTHING ATTACHED YET -->
		<g transform="rotate(-8 70 56)">
			<rect
				x="30"
				y="20"
				width="62"
				height="76"
				rx="8"
				fill="var(--surface)"
				stroke="var(--line)"
				stroke-width="2"
			/>
			{@render bar(40, 34, 36)}
			{@render bar(40, 46, 24)}
		</g>
		{@render sheet(54, 18, 66, 78)}
		<rect
			x="62"
			y="26"
			width="50"
			height="34"
			rx="5"
			fill="var(--accent-soft)"
			stroke="var(--accent)"
			stroke-width="1.5"
		/>
		<circle cx="76" cy="38" r="5" fill="var(--accent)" opacity="0.7" />
		<path
			d="M64 58l14-12 10 8 8-6 14 10"
			stroke="var(--accent)"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
		{@render bar(62, 70, 40)}
		{@render bar(62, 80, 26)}
		<path
			d="M116 14v24a6 6 0 01-12 0V18a9 9 0 0118 0v22a12 12 0 01-24 0V26"
			stroke="var(--accent)"
			stroke-width="2.5"
			stroke-linecap="round"
			stroke-linejoin="round"
			opacity="0.85"
		/>
		{@render speck(140, 70)}
		{@render spark(24, 100)}
	{:else if kind === 'docs'}
		<!-- A DOCUMENT WITH A HEADING, TEXT, A CODE BLOCK AND A PENCIL -->
		{@render sheet(38, 10, 80, 90)}
		{@render accentBar(50, 24, 34)}
		{@render bar(50, 36, 56)}
		{@render bar(50, 45, 48)}
		<rect x="50" y="57" width="56" height="18" rx="4" fill="var(--raised)" />
		<path d="M56 64h14M56 69h22" stroke="var(--line)" stroke-width="2" stroke-linecap="round" />
		{@render bar(50, 82, 38)}
		<g transform="rotate(40 124 80)">
			<rect
				x="118"
				y="46"
				width="12"
				height="46"
				rx="3"
				fill="var(--accent-soft)"
				stroke="var(--accent)"
				stroke-width="2"
			/>
			<path
				d="M118 92l6 12 6-12z"
				fill="var(--surface)"
				stroke="var(--accent)"
				stroke-width="2"
				stroke-linejoin="round"
			/>
			<path d="M118 56h12" stroke="var(--accent)" stroke-width="2" />
		</g>
		<path d="M24 84h8M24 90h5" stroke="var(--line)" stroke-width="2" stroke-linecap="round" />
		{@render spark(26, 30)}
	{:else if kind === 'discussion'}
		<!-- TWO CHAT BUBBLES, THE SECOND ONE STILL BEING TYPED -->
		<path
			d="M22 18h66a8 8 0 018 8v26a8 8 0 01-8 8H44l-12 12V60h-10a8 8 0 01-8-8V26a8 8 0 018-8z"
			fill="url(#{uid}-hatch)"
			stroke="var(--line)"
			stroke-width="1.5"
			transform="translate(3 3)"
		/>
		<path
			d="M22 18h66a8 8 0 018 8v26a8 8 0 01-8 8H44l-12 12V60h-10a8 8 0 01-8-8V26a8 8 0 018-8z"
			fill="var(--surface)"
			stroke="var(--line)"
			stroke-width="2"
			stroke-linejoin="round"
		/>
		{@render bar(30, 30, 46)}
		{@render bar(30, 42, 30)}
		<path
			d="M72 50h66a8 8 0 018 8v22a8 8 0 01-8 8h-8v12l-12-12H72a8 8 0 01-8-8V58a8 8 0 018-8z"
			fill="var(--accent-soft)"
			stroke="var(--accent)"
			stroke-width="2"
			stroke-linejoin="round"
		/>
		<circle cx="92" cy="69" r="3.5" fill="var(--accent)" />
		<circle cx="105" cy="69" r="3.5" fill="var(--accent)" opacity="0.65" />
		<circle cx="118" cy="69" r="3.5" fill="var(--accent)" opacity="0.35" />
		{@render spark(134, 26)}
		{@render speck(14, 92)}
	{:else if kind === 'decisions'}
		<!-- A PATH THAT FORKS, ONE WAY CHOSEN AND ONE LEFT -->
		<path d="M80 100V70" stroke="var(--line)" stroke-width="3" stroke-linecap="round" />
		<path
			d="M80 70c0-14-34-10-34-30"
			stroke="var(--line)"
			stroke-width="3"
			stroke-linecap="round"
			stroke-dasharray="1 7"
		/>
		<path
			d="M80 70c0-14 34-10 34-30"
			stroke="var(--accent)"
			stroke-width="3.5"
			stroke-linecap="round"
		/>
		<circle cx="80" cy="74" r="5" fill="var(--surface)" stroke="var(--line)" stroke-width="2" />
		<rect
			x="26"
			y="14"
			width="40"
			height="26"
			rx="7"
			fill="var(--surface)"
			stroke="var(--line)"
			stroke-width="2"
			stroke-dasharray="4 3"
		/>
		{@render bar(34, 24, 24)}
		<rect
			x="95"
			y="12"
			width="40"
			height="28"
			rx="7"
			fill="var(--accent-soft)"
			stroke="var(--accent)"
			stroke-width="2"
		/>
		<path
			d="M106 26l6 6 12-12"
			stroke="var(--accent)"
			stroke-width="3"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
		<path
			d="M130 62l4 4M134 62l-4 4"
			stroke="var(--line)"
			stroke-width="2"
			stroke-linecap="round"
		/>
		{@render spark(26, 68)}
		{@render speck(140, 92)}
	{:else if kind === 'checks'}
		<!-- A BROWSER WINDOW WITH EMPTY CHECK ROWS AND A RUN BUTTON -->
		<rect
			x="25"
			y="19"
			width="116"
			height="80"
			rx="10"
			fill="url(#{uid}-hatch)"
			stroke="var(--line)"
			stroke-width="1.5"
		/>
		<rect
			x="20"
			y="14"
			width="116"
			height="80"
			rx="10"
			fill="var(--surface)"
			stroke="var(--line)"
			stroke-width="2"
		/>
		<path d="M20 34h116" stroke="var(--line)" stroke-width="2" />
		<circle cx="31" cy="24" r="2.5" fill="var(--raised)" />
		<circle cx="40" cy="24" r="2.5" fill="var(--raised)" />
		<circle cx="49" cy="24" r="2.5" fill="var(--raised)" />
		<rect x="60" y="20" width="64" height="8" rx="4" fill="var(--raised)" />
		<rect
			x="30"
			y="44"
			width="10"
			height="10"
			rx="3"
			fill="var(--bg)"
			stroke="var(--line)"
			stroke-width="1.5"
			stroke-dasharray="3 2"
		/>
		{@render bar(48, 46, 56)}
		<rect
			x="30"
			y="62"
			width="10"
			height="10"
			rx="3"
			fill="var(--bg)"
			stroke="var(--line)"
			stroke-width="1.5"
			stroke-dasharray="3 2"
		/>
		{@render bar(48, 64, 40)}
		<rect
			x="30"
			y="80"
			width="10"
			height="6"
			rx="3"
			fill="var(--bg)"
			stroke="var(--line)"
			stroke-width="1.5"
			stroke-dasharray="3 2"
		/>
		<circle cx="124" cy="82" r="15" fill="var(--accent)" />
		<path
			d="M119 75l12 7-12 7z"
			fill="var(--accent-ink)"
			stroke="var(--accent-ink)"
			stroke-width="1.5"
			stroke-linejoin="round"
		/>
		{@render spark(148, 40)}
		{@render speck(10, 98)}
	{:else if kind === 'shots'}
		<!-- A DESKTOP FRAME AND A PHONE FRAME WITH VIEWFINDER CORNERS -->
		{@render sheet(18, 24, 82, 56)}
		<path d="M18 38h82" stroke="var(--line)" stroke-width="2" />
		<circle cx="27" cy="31" r="2" fill="var(--raised)" />
		<circle cx="34" cy="31" r="2" fill="var(--raised)" />
		<rect x="26" y="46" width="28" height="26" rx="4" fill="var(--raised)" />
		<rect
			x="60"
			y="46"
			width="32"
			height="10"
			rx="4"
			fill="var(--accent-soft)"
			stroke="var(--accent)"
			stroke-width="1.2"
		/>
		{@render bar(60, 62, 30)}
		{@render bar(60, 70, 20)}
		<rect
			x="108"
			y="32"
			width="34"
			height="62"
			rx="9"
			fill="var(--surface)"
			stroke="var(--line)"
			stroke-width="2"
		/>
		<rect x="117" y="37" width="16" height="3" rx="1.5" fill="var(--raised)" />
		<rect x="113" y="46" width="24" height="18" rx="4" fill="var(--raised)" />
		{@render bar(113, 70, 24)}
		{@render bar(113, 79, 16)}
		<path
			d="M10 40V28a8 8 0 018-8h12M140 100h6a8 8 0 008-8v-4M10 66v14"
			stroke="var(--accent)"
			stroke-width="3"
			stroke-linecap="round"
		/>
		{@render spark(88, 98)}
	{:else if kind === 'trash'}
		<!-- AN EMPTY BIN AND A CLOCK FOR THE 30 DAYS ITEMS STAY -->
		<path
			d="M47 44l5 52a5 5 0 005 5h50a5 5 0 005-5l5-52z"
			fill="url(#{uid}-hatch)"
			stroke="var(--line)"
			stroke-width="1.5"
			transform="translate(3 3)"
		/>
		<path
			d="M47 44l5 52a5 5 0 005 5h50a5 5 0 005-5l5-52z"
			fill="var(--surface)"
			stroke="var(--line)"
			stroke-width="2"
			stroke-linejoin="round"
		/>
		<path
			d="M68 54v36M80 54v36M92 54v36"
			stroke="var(--raised)"
			stroke-width="4"
			stroke-linecap="round"
		/>
		<rect
			x="40"
			y="32"
			width="80"
			height="12"
			rx="6"
			fill="var(--surface)"
			stroke="var(--line)"
			stroke-width="2"
		/>
		<path d="M68 32v-5a4 4 0 014-4h16a4 4 0 014 4v5" stroke="var(--line)" stroke-width="2" />
		<circle
			cx="128"
			cy="30"
			r="14"
			fill="var(--accent-soft)"
			stroke="var(--accent)"
			stroke-width="2.5"
		/>
		<path
			d="M128 22v8l6 4"
			stroke="var(--accent)"
			stroke-width="2.5"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
		{@render spark(24, 40)}
		{@render speck(26, 92)}
	{:else if kind === 'unplugged'}
		<!-- A PLUG AND A SOCKET WITH A GAP BETWEEN THEM, NOT SET UP -->
		<rect
			x="19"
			y="44"
			width="46"
			height="36"
			rx="10"
			fill="url(#{uid}-hatch)"
			stroke="var(--line)"
			stroke-width="1.5"
		/>
		<rect
			x="16"
			y="40"
			width="46"
			height="36"
			rx="10"
			fill="var(--surface)"
			stroke="var(--line)"
			stroke-width="2"
		/>
		<rect x="46" y="50" width="8" height="5" rx="2.5" fill="var(--raised)" />
		<rect x="46" y="62" width="8" height="5" rx="2.5" fill="var(--raised)" />
		<path d="M24 76v16" stroke="var(--line)" stroke-width="3" stroke-linecap="round" />
		<rect
			x="100"
			y="40"
			width="34"
			height="36"
			rx="10"
			fill="var(--accent-soft)"
			stroke="var(--accent)"
			stroke-width="2"
		/>
		<path
			d="M100 51h-12M100 65h-12"
			stroke="var(--accent)"
			stroke-width="4"
			stroke-linecap="round"
		/>
		<path
			d="M134 58h14a8 8 0 018 8v26"
			stroke="var(--accent)"
			stroke-width="3"
			stroke-linecap="round"
		/>
		<path
			d="M72 46l-4-8M76 58h-8M72 70l-4 8"
			stroke="var(--warning)"
			stroke-width="2.5"
			stroke-linecap="round"
		/>
		{@render spark(80, 20)}
		{@render speck(110, 96)}
	{:else if kind === 'repo'}
		<!-- A REPOSITORY BOOK WITH A BRANCH GRAPH, ONE BRANCH NOT CONNECTED YET -->
		{@render sheet(34, 12, 92, 88, 10)}
		<path d="M48 12v88" stroke="var(--line)" stroke-width="2" />
		<path d="M82 34v44" stroke="var(--line)" stroke-width="3" stroke-linecap="round" />
		<path
			d="M82 66c0-10 22-8 22-20"
			stroke="var(--accent)"
			stroke-width="3"
			stroke-linecap="round"
			stroke-dasharray="1 6"
		/>
		<circle cx="82" cy="34" r="6" fill="var(--bg)" stroke="var(--line)" stroke-width="2.5" />
		<circle cx="82" cy="78" r="6" fill="var(--bg)" stroke="var(--line)" stroke-width="2.5" />
		<circle
			cx="104"
			cy="44"
			r="7"
			fill="var(--accent-soft)"
			stroke="var(--accent)"
			stroke-width="2.5"
			stroke-dasharray="3 2.5"
		/>
		<path d="M104 41v6M101 44h6" stroke="var(--accent)" stroke-width="1.8" stroke-linecap="round" />
		{@render bar(56, 24, 14)}
		{@render bar(56, 90, 18)}
		{@render spark(142, 30)}
		{@render speck(18, 84)}
	{:else if kind === 'tasks'}
		<!-- A NOTEPAD WITH EMPTY TICK BOXES AND A PENCIL -->
		{@render sheet(32, 16, 84, 84)}
		<circle cx="48" cy="16" r="3" fill="var(--bg)" stroke="var(--line)" stroke-width="2" />
		<circle cx="74" cy="16" r="3" fill="var(--bg)" stroke="var(--line)" stroke-width="2" />
		<circle cx="100" cy="16" r="3" fill="var(--bg)" stroke="var(--line)" stroke-width="2" />
		<rect
			x="44"
			y="34"
			width="11"
			height="11"
			rx="3.5"
			fill="var(--bg)"
			stroke="var(--line)"
			stroke-width="2"
		/>
		{@render bar(62, 37, 40)}
		<rect
			x="44"
			y="54"
			width="11"
			height="11"
			rx="3.5"
			fill="var(--bg)"
			stroke="var(--line)"
			stroke-width="2"
		/>
		{@render bar(62, 57, 28)}
		<rect
			x="44"
			y="74"
			width="11"
			height="11"
			rx="3.5"
			fill="var(--accent-soft)"
			stroke="var(--accent)"
			stroke-width="2"
			stroke-dasharray="3 2"
		/>
		<path
			d="M49.5 77v6M46.5 80h6"
			stroke="var(--accent)"
			stroke-width="1.6"
			stroke-linecap="round"
		/>
		<g transform="rotate(35 130 66)">
			<rect
				x="124"
				y="32"
				width="12"
				height="44"
				rx="3"
				fill="var(--accent-soft)"
				stroke="var(--accent)"
				stroke-width="2"
			/>
			<path
				d="M124 76l6 12 6-12z"
				fill="var(--surface)"
				stroke="var(--accent)"
				stroke-width="2"
				stroke-linejoin="round"
			/>
		</g>
		{@render spark(20, 32)}
	{:else if kind === 'projects'}
		<!-- A GREY FOLDER BEHIND, A NEW FOLDER WAITING IN FRONT -->
		<path
			d="M22 32a6 6 0 016-6h22l7 8h44a6 6 0 016 6v38a6 6 0 01-6 6H28a6 6 0 01-6-6z"
			fill="var(--surface)"
			stroke="var(--line)"
			stroke-width="2"
			stroke-linejoin="round"
		/>
		<path
			d="M32 50h50"
			stroke="var(--line)"
			stroke-width="2"
			stroke-dasharray="1 4"
			stroke-linecap="round"
		/>
		<path
			d="M52 52a6 6 0 016-6h26l7 8h40a6 6 0 016 6v34a6 6 0 01-6 6H58a6 6 0 01-6-6z"
			fill="url(#{uid}-hatch-accent)"
			stroke="var(--accent)"
			stroke-width="2"
			stroke-linejoin="round"
			stroke-dasharray="5 4"
		/>
		<path d="M100 66v18M91 75h18" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" />
		{@render spark(24, 92)}
		{@render speck(144, 30)}
	{:else if kind === 'org'}
		<!-- A SKYLINE OF BUILDINGS WITH ONE NEW PLOT -->
		<rect
			x="16"
			y="46"
			width="30"
			height="52"
			rx="5"
			fill="var(--surface)"
			stroke="var(--line)"
			stroke-width="2"
		/>
		<rect
			x="50"
			y="26"
			width="34"
			height="72"
			rx="5"
			fill="var(--surface)"
			stroke="var(--line)"
			stroke-width="2"
		/>
		<path
			d="M24 56h4M34 56h4M24 68h4M34 68h4M24 80h4M34 80h4M58 38h4M72 38h4M58 50h4M72 50h4M58 62h4M72 62h4M58 74h4M72 74h4"
			stroke="var(--raised)"
			stroke-width="4"
			stroke-linecap="round"
		/>
		<rect
			x="92"
			y="40"
			width="32"
			height="58"
			rx="5"
			fill="url(#{uid}-hatch-accent)"
			stroke="var(--accent)"
			stroke-width="2"
			stroke-dasharray="5 4"
		/>
		<path d="M108 62v16M100 70h16" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" />
		<path d="M10 98h140" stroke="var(--line)" stroke-width="2" stroke-linecap="round" />
		{@render spark(138, 28)}
		{@render speck(98, 22)}
	{:else if kind === 'locked'}
		<!-- A PADLOCK, NO ACCESS FOR THIS PERSON -->
		<rect
			x="55"
			y="53"
			width="56"
			height="44"
			rx="10"
			fill="url(#{uid}-hatch)"
			stroke="var(--line)"
			stroke-width="1.5"
		/>
		<path
			d="M64 52V40a17 17 0 0134 0v12"
			stroke="var(--line)"
			stroke-width="6"
			stroke-linecap="round"
		/>
		<path
			d="M64 48V36a16 16 0 0132 0v12"
			stroke="var(--raised)"
			stroke-width="3"
			stroke-linecap="round"
		/>
		<rect
			x="52"
			y="48"
			width="56"
			height="44"
			rx="10"
			fill="var(--surface)"
			stroke="var(--line)"
			stroke-width="2"
		/>
		<circle cx="80" cy="66" r="6" fill="var(--raised)" stroke="var(--muted)" stroke-width="2" />
		<path d="M80 70v9" stroke="var(--muted)" stroke-width="3" stroke-linecap="round" />
		{@render spark(30, 40)}
		{@render spark(130, 84)}
	{:else if kind === 'tools'}
		<!-- A TERMINAL WITH A DASHED LINE TO A TOOL THAT IS NOT CONNECTED -->
		{@render sheet(14, 22, 86, 62)}
		<path d="M14 40h86" stroke="var(--line)" stroke-width="2" />
		<circle cx="24" cy="31" r="2.2" fill="var(--raised)" />
		<circle cx="32" cy="31" r="2.2" fill="var(--raised)" />
		<path
			d="M26 52l8 7-8 7"
			stroke="var(--accent)"
			stroke-width="3"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
		{@render bar(42, 62, 24)}
		{@render bar(26, 74, 40)}
		<path
			d="M100 56h14"
			stroke="var(--accent)"
			stroke-width="3"
			stroke-linecap="round"
			stroke-dasharray="1 6"
		/>
		<circle
			cx="132"
			cy="56"
			r="17"
			fill="var(--accent-soft)"
			stroke="var(--accent)"
			stroke-width="2.5"
			stroke-dasharray="4 3"
		/>
		<path
			d="M126 50v-5M138 50v-5M123 52h18v6a9 9 0 01-18 0z"
			stroke="var(--accent)"
			stroke-width="2.2"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
		{@render spark(120, 92)}
		{@render speck(22, 100)}
	{:else if kind === 'events'}
		<!-- A QUIET TIMELINE, THE FIRST EVENT NOT HAPPENED YET -->
		<path
			d="M44 20v76"
			stroke="var(--line)"
			stroke-width="2"
			stroke-dasharray="2 5"
			stroke-linecap="round"
		/>
		<circle
			cx="44"
			cy="26"
			r="9"
			fill="var(--accent-soft)"
			stroke="var(--accent)"
			stroke-width="2.5"
		/>
		<circle cx="44" cy="26" r="15" stroke="var(--accent)" stroke-width="1.5" opacity="0.3" />
		<circle cx="44" cy="58" r="6" fill="var(--bg)" stroke="var(--line)" stroke-width="2" />
		<circle cx="44" cy="86" r="6" fill="var(--bg)" stroke="var(--line)" stroke-width="2" />
		<rect
			x="64"
			y="14"
			width="70"
			height="24"
			rx="7"
			fill="var(--surface)"
			stroke="var(--accent)"
			stroke-width="1.5"
			stroke-dasharray="4 3"
		/>
		{@render accentBar(72, 21, 30)}
		{@render bar(72, 29, 46)}
		<g opacity="0.7">
			{@render bar(64, 54, 52)}
			{@render bar(64, 63, 30)}
		</g>
		<g opacity="0.4">
			{@render bar(64, 82, 44)}
			{@render bar(64, 91, 24)}
		</g>
		{@render spark(144, 62)}
	{:else}
		<!-- NOTHING HERE YET: A SHEET AND A DASHED CARD READY FOR THE FIRST ONE -->
		{@render sheet(18, 22, 52, 70)}
		{@render bar(27, 34, 36)}
		{@render bar(27, 46, 26)}
		{@render bar(27, 58, 32)}
		<rect x="91" y="19" width="52" height="86" rx="8" fill="url(#{uid}-hatch-accent)" />
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
		<path
			d="M72 60h12"
			stroke="var(--accent)"
			stroke-width="2"
			stroke-linecap="round"
			stroke-dasharray="1 5"
		/>
		{@render spark(28, 14)}
		{@render speck(150, 108)}
	{/if}
</svg>

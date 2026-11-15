<script lang="ts">
	// IMPORTED CONSTANTS
	import { MAX_SOURCE_BYTES, PICTURE_OUTPUT_SIZE } from '#lib/shared/pictures.js';
	// IMPORTED MODULES
	import {
		STRAIGHTEN_RANGE,
		clampView,
		fillView,
		fitView,
		flipView,
		initialView,
		isFit,
		paintView,
		renderCrop,
		sliderToZoom,
		straightenOf,
		straightenView,
		turnView,
		zoomAbout,
		zoomPercent,
		zoomToSlider,
		type CropView
	} from '#lib/board/pictureCrop.js';
	import {
		checkSourceFile,
		formatBytes,
		readPictureSource,
		type PictureSource
	} from '#lib/board/pictureSource.js';
	import { cn } from '#lib/ui/cn.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	// IMPORTED DEP-COMPONENTS
	import FlipHorizontal2 from '@lucide/svelte/icons/flip-horizontal-2';
	import ImageIcon from '@lucide/svelte/icons/image';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import Minus from '@lucide/svelte/icons/minus';
	import Plus from '@lucide/svelte/icons/plus';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import RotateCw from '@lucide/svelte/icons/rotate-cw';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import Check from '@lucide/svelte/icons/check';
	// IMPORTED COMPONENTS
	import Button from '#lib/ui/Button.svelte';
	import Notice from '#lib/ui/Notice.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import SegmentedControl from '#lib/ui/SegmentedControl.svelte';

	// -- REQUIRED PROPS -- //

	let {
		open,
		file,
		shape,
		subject,
		previewName,
		onclose,
		onsave
	}: {
		/** Always mounted with this flag, never inside an {#if}. */
		open: boolean;
		/** The file the person chose, dropped or pasted. The editor reads it when it opens. */
		file: File | null;
		/** A round frame for a person's picture, a rounded square for a logo. */
		shape: 'round' | 'square';
		subject: 'picture' | 'logo';
		/** A logo is also shown beside this name, as it will be in the sidebar. */
		previewName?: string;
		onclose: () => void;
		/** Receives the cropped file. The editor stays on Saving until this settles, then closes. */
		onsave: (file: File) => void | Promise<void>;
	} = $props();

	// -- TYPES -- //

	type Phase = 'reading' | 'ready' | 'unreadable' | 'saving';

	// -- CONSTANTS -- //

	const PADS = [
		{ mode: 'light', label: 'Light' },
		{ mode: 'dark', label: 'Dark' }
	] as const;
	// The three sizes a picture is shown at. The classes are written in full so Tailwind builds them
	const SIZES = [
		{ px: 40, box: 'size-10', title: 'Top bar' },
		{ px: 32, box: 'size-8', title: 'Sidebar' },
		{ px: 24, box: 'size-6', title: 'Comments and lists' }
	] as const;
	const FRAME_SHARE = 0.74;
	const TWEEN_MS = 220;
	// A MULTI-STOP GRADIENT TAILWIND CANNOT EXPRESS: THE RULE OF THIRDS, DRAWN FROM THE INK TOKEN
	const THIRDS = [33.333, 66.666]
		.flatMap((p) =>
			(['right', 'bottom'] as const).map(
				(to) =>
					`linear-gradient(to ${to}, transparent calc(${p}% - 0.5px), color-mix(in srgb, var(--ink) 55%, transparent) 0 calc(${p}% + 0.5px), transparent 0)`
			)
		)
		.join(', ');
	// A MULTI-STOP GRADIENT TAILWIND CANNOT EXPRESS: THE CHECKERBOARD THAT SHOWS PADDING AT FIT
	const CHECKER =
		'conic-gradient(var(--raised) 25%, transparent 0 50%, var(--raised) 0 75%, transparent 0)';
	const FIT_OPTIONS = [
		{ value: 'fit', label: 'Fit' },
		{ value: 'fill', label: 'Fill' }
	];

	// -- STATES -- //

	let phase = $state<Phase>('reading');
	let current = $state<File | null>(null);
	let source = $state<PictureSource | null>(null);
	let view = $state<CropView>({ k: 1, tx: 0, ty: 0, a: 0, flip: false });
	/** True until the first measured view is set, so the picture opens filling the frame. */
	let fresh = $state(true);
	let stageW = $state(0);
	let stageEl = $state<HTMLDivElement>();
	let canvasEl = $state<HTMLCanvasElement>();
	let padsEl = $state<HTMLDivElement>();
	let pickerEl = $state<HTMLInputElement>();
	/** The grid shows while the picture is being moved, zoomed or straightened. */
	let active = $state(false);
	let dragging = $state(false);
	let hintGone = $state(false);
	let zoomChip = $state(false);
	let announce = $state('');
	let outFile = $state<File | null>(null);
	let barFull = $state(false);

	// Bookkeeping that is not reactive: a read in flight, an animation frame, two timers and the pointers of one gesture
	let readToken = 0;
	let raf = 0;
	let activeTimer: ReturnType<typeof setTimeout> | undefined;
	let chipTimer: ReturnType<typeof setTimeout> | undefined;
	let prevFrame = 0;
	const pointers: Record<number, { x: number; y: number }> = {};
	const held = () => Object.values(pointers);
	let last: { x: number; y: number } | null = null;
	let pinch: { d: number; k: number } | null = null;

	// -- REACTIVE STATES -- //

	const frame = $derived(stageW * FRAME_SHARE);
	const ready = $derived(phase === 'ready' && !fresh && frame > 0);
	const busy = $derived(phase === 'saving');
	const fit = $derived(source ? isFit(view, source, frame) : false);
	const percent = $derived(source ? zoomPercent(view, source, frame) : 100);
	const sliderPos = $derived(source ? Math.round(zoomToSlider(view, source, frame) * 1000) : 0);
	const straighten = $derived(straightenOf(view.a));
	const title = $derived(subject === 'logo' ? 'Crop the logo' : 'Crop your picture');
	const fileFacts = $derived(
		source
			? `${source.originalWidth} × ${source.originalHeight} · ${formatBytes(source.bytes)}`
			: current
				? formatBytes(current.size)
				: ''
	);
	const outText = $derived(
		outFile
			? `${PICTURE_OUTPUT_SIZE} × ${PICTURE_OUTPUT_SIZE} px · ${outFile.type === 'image/webp' ? 'WebP' : outFile.type === 'image/jpeg' ? 'JPEG' : 'PNG'} · ${formatBytes(outFile.size)}`
			: `${PICTURE_OUTPUT_SIZE} × ${PICTURE_OUTPUT_SIZE} px`
	);
	const straightenText = $derived(
		`${straighten > 0 ? '+' : straighten < 0 ? '−' : ''}${Math.abs(straighten)}°`
	);

	// -- REACTIVE STATEMENTS -- //

	// The editor reads the file when it opens, and again when a different file arrives
	$effect(() => {
		if (open && file && file !== current) void load(file);
	});

	// The first measured frame sets the opening view: upright, filling the frame
	$effect(() => {
		if (source && fresh && frame > 0) {
			view = initialView(source, frame);
			fresh = false;
		}
	});

	// A resize, or a phone turning, changes the frame's size: the view is rescaled so the same part stays in view
	$effect(() => {
		const f = frame;
		if (!source || fresh || f <= 0) return;
		if (prevFrame > 0 && prevFrame !== f) {
			const r = f / prevFrame;
			view = clampView({ ...view, k: view.k * r, tx: view.tx * r, ty: view.ty * r }, source, f);
		}
		prevFrame = f;
	});

	// Paints the stage and the previews whenever the view, the picture or the size changes
	$effect(() => {
		void view;
		void source;
		void frame;
		void fresh;
		void canvasEl;
		draw();
	});

	// What is saved: a real render, after the person stops moving the picture for a moment
	$effect(() => {
		if (!source || !ready || fresh || frame <= 0) return;
		const snap = view;
		const src = source;
		const f = frame;
		const name = current?.name;
		const t = setTimeout(async () => {
			try {
				const out = await renderCrop(src.image, src, snap, f, name);
				if (out && snap === view) outFile = out;
			} catch {
				// The size shown stays as it was. Save renders again and says if it fails
			}
		}, 220);
		return () => clearTimeout(t);
	});

	// The wheel needs preventDefault, which a passive listener refuses
	$effect(() => {
		const el = stageEl;
		if (!el) return;
		el.addEventListener('wheel', onWheel, { passive: false });
		return () => el.removeEventListener('wheel', onWheel);
	});

	// -- FUNCTIONS -- //

	const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

	async function load(f: File) {
		const token = ++readToken;
		current = f;
		prevFrame = 0;
		phase = 'reading';
		source = null;
		outFile = null;
		fresh = true;
		hintGone = false;
		try {
			const next = await readPictureSource(f);
			if (token !== readToken) return;
			source = next;
			phase = 'ready';
		} catch {
			if (token === readToken) phase = 'unreadable';
		}
	}

	/** The Replace button and the Choose another picture button take a new file inside the editor. */
	function replace(files: FileList | null) {
		const f = files?.[0];
		if (pickerEl) pickerEl.value = '';
		if (!f) return;
		const check = checkSourceFile(f);
		if (!check.ok) {
			toast.error(check.message);
			return;
		}
		void load(f);
	}

	/** Eases the view to a target over 220 ms, or at once under reduced motion. */
	function tween(to: CropView) {
		cancelAnimationFrame(raf);
		const from = view;
		const start = performance.now();
		const length = reduced() ? 0 : TWEEN_MS;
		const step = (now: number) => {
			const p = length ? Math.min(1, (now - start) / length) : 1;
			const e = 1 - Math.pow(1 - p, 3);
			view = {
				k: from.k + (to.k - from.k) * e,
				tx: from.tx + (to.tx - from.tx) * e,
				ty: from.ty + (to.ty - from.ty) * e,
				a: from.a + (to.a - from.a) * e,
				flip: to.flip
			};
			if (p < 1) raf = requestAnimationFrame(step);
		};
		raf = requestAnimationFrame(step);
	}

	function poke(ms = 700) {
		active = true;
		hintGone = true;
		clearTimeout(activeTimer);
		activeTimer = setTimeout(() => (active = false), ms);
	}

	function showZoom() {
		zoomChip = true;
		clearTimeout(chipTimer);
		chipTimer = setTimeout(() => (zoomChip = false), 900);
	}

	/** Every edit goes through one of these so the picture is always clamped and the grid shows. */
	function zoomTo(k: number, px = 0, py = 0) {
		if (!source) return;
		view = zoomAbout(view, source, frame, k, px, py);
		showZoom();
	}

	function turn(dir: 1 | -1) {
		if (!source) return;
		tween(turnView(view, source, frame, dir));
		announce = dir > 0 ? 'Turned right' : 'Turned left';
	}

	function flip() {
		if (!source) return;
		view = flipView(view, source, frame);
		announce = view.flip ? 'Flipped' : 'Not flipped';
	}

	function setFit(value: string) {
		if (!source) return;
		tween(value === 'fit' ? fitView(view, source, frame) : fillView(view, source, frame));
	}

	function reset() {
		if (!source) return;
		tween(initialView(source, frame));
		announce = 'Reset';
	}

	/** The point under the pointer, measured from the stage's centre in pixels. */
	function centred(e: { clientX: number; clientY: number }) {
		const r = (stageEl as HTMLDivElement).getBoundingClientRect();
		return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
	}

	// Pointer: one finger or the mouse moves the picture, two fingers pinch

	function down(e: PointerEvent) {
		if (!ready || !source) return;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		pointers[e.pointerId] = centred(e);
		if (held().length === 2) {
			const [p, q] = held();
			pinch = { d: Math.hypot(p.x - q.x, p.y - q.y) || 1, k: view.k };
		} else last = centred(e);
		dragging = true;
		active = true;
		hintGone = true;
		cancelAnimationFrame(raf);
	}

	function move(e: PointerEvent) {
		if (!(e.pointerId in pointers) || !source) return;
		const now = centred(e);
		pointers[e.pointerId] = now;
		if (held().length >= 2 && pinch) {
			const [p, q] = held();
			zoomTo(
				(pinch.k * Math.hypot(p.x - q.x, p.y - q.y)) / pinch.d,
				(p.x + q.x) / 2,
				(p.y + q.y) / 2
			);
		} else if (last) {
			view = clampView(
				{ ...view, tx: view.tx + now.x - last.x, ty: view.ty + now.y - last.y },
				source,
				frame
			);
			last = now;
		}
	}

	function up(e: PointerEvent) {
		delete pointers[e.pointerId];
		pinch = null;
		last = held()[0] ?? null;
		if (!held().length) {
			dragging = false;
			poke(400);
		}
	}

	function onWheel(e: WheelEvent) {
		if (!ready || !source) return;
		e.preventDefault();
		poke();
		const p = centred(e);
		zoomTo(view.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), p.x, p.y);
	}

	function onStageKey(e: KeyboardEvent) {
		if (!ready || !source || e.ctrlKey || e.metaKey || e.altKey) return;
		const step = e.shiftKey ? 16 : 4;
		const move = (dx: number, dy: number) => {
			view = clampView({ ...view, tx: view.tx + dx, ty: view.ty + dy }, source!, frame);
		};
		const keys: Record<string, () => void> = {
			ArrowLeft: () => move(-step, 0),
			ArrowRight: () => move(step, 0),
			ArrowUp: () => move(0, -step),
			ArrowDown: () => move(0, step),
			'+': () => zoomTo(view.k * 1.1),
			'=': () => zoomTo(view.k * 1.1),
			'-': () => zoomTo(view.k / 1.1),
			_: () => zoomTo(view.k / 1.1),
			'[': () => turn(-1),
			']': () => turn(1),
			'0': reset
		};
		const run = keys[e.key];
		if (!run) return;
		e.preventDefault();
		run();
		poke();
	}

	function onDialogKey(e: KeyboardEvent) {
		// Enter saves from anywhere that is not a button or a slider, which use Enter or arrows themselves
		const t = e.target as HTMLElement;
		if (e.key !== 'Enter' || t.closest('button') || t.matches('input')) return;
		e.preventDefault();
		void save();
	}

	async function save() {
		if (!ready || !source || !current) return;
		phase = 'saving';
		barFull = false;
		requestAnimationFrame(() => (barFull = true));
		try {
			const out = await renderCrop(source.image, source, view, frame, current.name);
			if (!out) throw new Error('The picture could not be made.');
			await onsave(out);
			// Stays on Saving while the dialog closes, so a second click cannot upload twice. The next open reads afresh
			onclose();
			return;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'The picture was not saved.');
		}
		phase = source ? 'ready' : 'unreadable';
	}

	function draw() {
		const canvas = canvasEl;
		// Nothing to show yet, or no longer: the stage and the previews are cleared so an earlier picture never shows through
		if (!source || fresh) {
			for (const c of [canvasEl, ...(padsEl?.querySelectorAll('canvas') ?? [])]) {
				c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
			}
			return;
		}
		if (!canvas || frame <= 0) return;
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		const size = Math.round(stageW * dpr);
		if (canvas.width !== size) {
			canvas.width = size;
			canvas.height = size;
		}
		const ctx = canvas.getContext('2d');
		// The offsets are in stage pixels, so the whole stage is the reference size for the main canvas
		if (ctx) paintView(ctx, source.image, source, view, size, stageW);
		for (const c of padsEl?.querySelectorAll('canvas') ?? []) {
			const x = c.getContext('2d');
			if (x) paintView(x, source.image, source, view, c.width, frame);
		}
	}
</script>

<!-- ONE KEY CAP OF THE HINTS -->
{#snippet key(label: string)}
	<kbd
		class="inline-block min-w-5 rounded-md border border-b-2 border-line bg-surface px-1 text-center font-mono text-xs font-medium text-ink"
		>{label}</kbd
	>
{/snippet}

<!-- THE PICTURE EDITOR. IT OPENS AS SOON AS A PICTURE IS CHOSEN, DROPPED OR PASTED, AND SAVES ONLY ON SAVE -->
<ResponsiveModal {open} {onclose} {title} {busy} size="lg">
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class={cn('grid gap-5', phase !== 'unreadable' && 'sm:grid-cols-[360px_minmax(0,1fr)]')}
		onkeydown={onDialogKey}
	>
		<!-- THE FILE, THE STAGE AND THE CONTROLS -->
		<div class={cn('flex min-w-0 flex-col gap-3', phase === 'unreadable' && 'items-center')}>
			<!-- THE FILE ROW: NAME, SIZE, AND REPLACE -->
			<div
				class="flex min-h-11 w-full max-w-[360px] items-center gap-2.5 rounded-lg border border-line bg-raised/50 py-1.5 pr-1.5 pl-3 max-sm:max-w-none"
			>
				<ImageIcon size={18} class="shrink-0 text-muted" aria-hidden="true" />
				<div class="min-w-0 flex-1">
					<div class="truncate font-mono text-xs font-medium text-ink" data-testid="picture-name">
						{current?.name ?? ''}
					</div>
					<div class="truncate text-xs text-muted">{fileFacts}</div>
				</div>
				<Button
					variant="ghost"
					size="sm"
					disabled={busy}
					onclick={() => pickerEl?.click()}
					data-testid="picture-replace">Replace</Button
				>
				<input
					bind:this={pickerEl}
					type="file"
					accept="image/*"
					class="hidden"
					tabindex="-1"
					aria-hidden="true"
					onchange={(e) => replace(e.currentTarget.files)}
				/>
			</div>

			{#if phase === 'unreadable'}
				<!-- THE FILE COULD NOT BE READ -->
				<div
					role="alert"
					class="flex aspect-square w-full max-w-[360px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line bg-raised p-6 text-center max-sm:max-w-none"
				>
					<span
						class="inline-flex size-12 items-center justify-center rounded-xl bg-danger-soft text-danger"
						><TriangleAlert size={24} aria-hidden="true" /></span
					>
					<b class="text-sm font-semibold text-ink">We could not read that file</b>
					<p class="max-w-[26ch] text-xs text-muted">
						Choose a PNG, JPEG, WebP, GIF, AVIF or BMP picture, up to {MAX_SOURCE_BYTES /
							(1024 * 1024)} MB.
					</p>
					<Button class="mt-2" data-autofocus onclick={() => pickerEl?.click()}
						>Choose another picture</Button
					>
				</div>
			{:else}
				<!-- THE STAGE IS ALWAYS DARK (data-mode="dark"), SO ANY PICTURE READS THE SAME IN BOTH MODES, AS IN A PHOTO VIEWER -->
				<!-- The stage is one custom control: a labelled group that takes focus, the mouse, touch and the keyboard -->
				<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
				<div
					bind:this={stageEl}
					bind:clientWidth={stageW}
					data-mode="dark"
					role="group"
					aria-roledescription="Crop area"
					aria-label="Crop area. Arrow keys move the picture, plus and minus zoom, left and right brackets turn it."
					tabindex="0"
					onpointerdown={down}
					onpointermove={move}
					onpointerup={up}
					onpointercancel={up}
					ondblclick={() => source && setFit(percent < 102 ? 'fit' : 'fill')}
					onkeydown={onStageKey}
					data-autofocus
					data-testid="picture-stage"
					class={cn(
						'relative aspect-square w-full max-w-[360px] touch-none overflow-hidden rounded-xl border border-line bg-bg text-ink select-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent max-sm:max-w-none',
						dragging ? 'cursor-grabbing' : 'cursor-grab'
					)}
				>
					<!-- PADDING SHOWS AS A CHECKERBOARD WHILE THE PICTURE IS SMALLER THAN THE FRAME -->
					{#if fit}
						<div
							class="absolute inset-0 bg-surface bg-[size:16px_16px] opacity-90"
							style:background-image={CHECKER}
						></div>
					{/if}
					<canvas bind:this={canvasEl} class="absolute inset-0 size-full" aria-hidden="true"
					></canvas>
					<!-- THE FRAME. EVERYTHING OUTSIDE IT IS DIMMED BY A HUGE SHADOW -->
					<div
						class={cn(
							'pointer-events-none absolute top-1/2 left-1/2 aspect-square w-[74%] -translate-x-1/2 -translate-y-1/2 overflow-hidden border-2 border-ink shadow-[0_0_0_999px_var(--overlay)] transition-[border-radius] duration-200 motion-reduce:transition-none',
							shape === 'round' ? 'rounded-full' : 'rounded-xl'
						)}
					>
						<div
							class={cn(
								'absolute inset-0 transition-opacity duration-150 motion-reduce:transition-none',
								active ? 'opacity-100' : 'opacity-0'
							)}
							style:background-image={THIRDS}
						></div>
					</div>
					{#if shape === 'square'}
						<span
							class="pointer-events-none absolute top-[13%] left-[13%] size-3.5 -translate-x-0.5 -translate-y-0.5 border-t-2 border-l-2 border-ink"
						></span>
						<span
							class="pointer-events-none absolute top-[13%] right-[13%] size-3.5 translate-x-0.5 -translate-y-0.5 border-t-2 border-r-2 border-ink"
						></span>
						<span
							class="pointer-events-none absolute bottom-[13%] left-[13%] size-3.5 -translate-x-0.5 translate-y-0.5 border-b-2 border-l-2 border-ink"
						></span>
						<span
							class="pointer-events-none absolute right-[13%] bottom-[13%] size-3.5 translate-x-0.5 translate-y-0.5 border-r-2 border-b-2 border-ink"
						></span>
					{/if}
					<span
						aria-hidden="true"
						class={cn(
							'pointer-events-none absolute top-2.5 right-2.5 rounded-full border border-line bg-surface/90 px-2 font-mono text-xs font-medium transition-opacity duration-200 motion-reduce:transition-none',
							zoomChip ? 'opacity-100' : 'opacity-0'
						)}>{percent}%</span
					>
					<span
						class={cn(
							'pointer-events-none absolute bottom-2.5 left-1/2 max-w-[calc(100%-20px)] -translate-x-1/2 rounded-full border border-line bg-surface/90 px-3 text-xs whitespace-nowrap transition-opacity duration-200 motion-reduce:transition-none',
							hintGone || phase === 'reading' ? 'opacity-0' : 'opacity-100'
						)}
					>
						<span class="max-sm:hidden">Drag to move · Scroll to zoom</span>
						<span class="sm:hidden">Drag to move · Pinch to zoom</span>
					</span>
					{#if phase === 'reading'}
						<div
							class="absolute inset-0 flex flex-col items-center justify-center gap-2.5 bg-raised text-xs text-muted motion-safe:animate-pulse"
						>
							<LoaderCircle size={22} class="motion-safe:animate-spin" aria-hidden="true" />
							<span>Reading {current?.name ?? 'the picture'}…</span>
						</div>
					{/if}
				</div>

				<!-- WHILE SAVING THE BAR FILLS OVER 900 ms -->
				{#if busy}
					<div class="h-1.5 overflow-hidden rounded-full bg-raised" aria-hidden="true">
						<!-- THE WIDTH IS A RUNTIME STEP FROM 8 TO 100 PERCENT -->
						<div
							class="h-full rounded-full bg-accent transition-[width] duration-[900ms] ease-out motion-reduce:transition-none"
							style:width={barFull ? '100%' : '8%'}
						></div>
					</div>
				{/if}

				<!-- TURN, FLIP, FIT OR FILL -->
				<div
					role="toolbar"
					aria-label="Picture tools"
					class={cn(
						'flex flex-wrap items-center gap-2',
						!ready && 'pointer-events-none opacity-50'
					)}
				>
					<Button iconOnly aria-label="Turn left" title="Turn left [" onclick={() => turn(-1)}
						><RotateCcw size={20} /></Button
					>
					<Button iconOnly aria-label="Turn right" title="Turn right ]" onclick={() => turn(1)}
						><RotateCw size={20} /></Button
					>
					<Button
						iconOnly
						aria-label="Flip left and right"
						aria-pressed={view.flip}
						title="Flip"
						onclick={flip}
						class={view.flip ? 'bg-accent-soft! text-accent-text!' : ''}
						><FlipHorizontal2 size={20} /></Button
					>
					<span class="mx-0.5 h-6 w-px bg-line" aria-hidden="true"></span>
					<SegmentedControl
						label="How the picture sits in the frame"
						options={FIT_OPTIONS}
						value={fit ? 'fit' : 'fill'}
						onchange={setFit}
					/>
				</div>

				<!-- ZOOM AND STRAIGHTEN -->
				<div class={cn('flex flex-col', !ready && 'pointer-events-none opacity-50')}>
					<div class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
						<div class="col-span-full flex items-baseline justify-between">
							<label for="picture-zoom" class="text-xs font-medium text-ink">Zoom</label>
							<span class="font-mono text-xs text-muted tabular-nums">{percent}%</span>
						</div>
						<Button
							variant="subtle"
							iconOnly
							aria-label="Zoom out"
							onclick={() => zoomTo(view.k / 1.2)}><Minus size={20} /></Button
						>
						<input
							id="picture-zoom"
							type="range"
							min="0"
							max="1000"
							value={sliderPos}
							aria-valuetext={`${percent} percent`}
							oninput={(e) => {
								if (!source) return;
								poke();
								zoomTo(sliderToZoom(Number(e.currentTarget.value) / 1000, source, frame, view.a));
							}}
							class="h-11 w-full cursor-pointer accent-[var(--accent)] disabled:cursor-not-allowed"
						/>
						<Button
							variant="subtle"
							iconOnly
							aria-label="Zoom in"
							onclick={() => zoomTo(view.k * 1.2)}><Plus size={20} /></Button
						>
					</div>
					<div class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
						<div class="col-span-full flex items-baseline justify-between">
							<label for="picture-straighten" class="text-xs font-medium text-ink">Straighten</label
							>
							<span class="font-mono text-xs text-muted tabular-nums">{straightenText}</span>
						</div>
						<RotateCcw size={16} class="mx-3.5 text-muted" aria-hidden="true" />
						<input
							id="picture-straighten"
							type="range"
							min={-STRAIGHTEN_RANGE}
							max={STRAIGHTEN_RANGE}
							step="0.5"
							value={straighten}
							aria-valuetext={`${straighten} degrees`}
							oninput={(e) => {
								if (!source) return;
								poke();
								view = straightenView(view, source, frame, Number(e.currentTarget.value));
							}}
							class="h-11 w-full cursor-pointer accent-[var(--accent)] disabled:cursor-not-allowed"
						/>
						<RotateCw size={16} class="mx-3.5 text-muted" aria-hidden="true" />
					</div>
				</div>
			{/if}
		</div>

		<!-- THE PREVIEW IN BOTH MODES, WHAT IS SAVED, THE KEYS -->
		<div class={cn('flex min-w-0 flex-col gap-3', phase === 'unreadable' && 'hidden')}>
			{#if source?.small}
				<Notice tone="warning">
					This picture is small ({source.originalWidth} × {source.originalHeight}). It may look
					soft. You can still save it.
				</Notice>
			{/if}
			<div class="flex flex-col gap-3 rounded-xl border border-line bg-surface p-3">
				<span class="text-xs font-medium text-ink">Preview</span>
				<div bind:this={padsEl} class="grid grid-cols-1 gap-2 max-sm:grid-cols-2">
					{#each PADS as pad (pad.mode)}
						<!-- EACH PAD CARRIES ITS OWN data-mode, SO BOTH MODES SHOW SIDE BY SIDE -->
						<div
							data-mode={pad.mode}
							class="flex flex-col gap-2 rounded-lg border border-line bg-bg p-2.5 text-ink"
						>
							<span class="text-xs text-muted">{pad.label}</span>
							<div class="flex items-end gap-3 max-sm:gap-2">
								{#each SIZES as s (s.px)}
									<div class="flex flex-col items-center gap-1">
										<canvas
											width={s.px * 2}
											height={s.px * 2}
											title={s.title}
											aria-hidden="true"
											class={cn(
												'bg-raised',
												s.box,
												shape === 'round'
													? 'rounded-full'
													: s.px === 24
														? 'rounded-md'
														: 'rounded-lg'
											)}
										></canvas>
										<span class="font-mono text-xs text-muted" title={s.title}>{s.px}</span>
									</div>
								{/each}
							</div>
							{#if previewName && shape === 'square'}
								<div class="flex h-9 items-center gap-2.5 rounded-lg bg-surface px-1.5 text-sm">
									<canvas
										width="48"
										height="48"
										aria-hidden="true"
										class="size-6 rounded-md bg-raised"
									></canvas>
									<span class="truncate font-medium">{previewName}</span>
								</div>
							{/if}
						</div>
					{/each}
				</div>
			</div>
			<div class="flex flex-col gap-1.5 rounded-xl border border-line bg-surface p-3">
				<span class="text-xs font-medium text-ink">What is saved</span>
				<div class="flex items-center gap-2 font-mono text-xs font-medium text-ink">
					{#if outFile}<Check size={16} class="shrink-0 text-success" aria-hidden="true" />{/if}
					<span data-testid="picture-output">{outText}</span>
				</div>
				{#if busy}<span class="text-xs text-muted">Cropping and saving…</span>{/if}
			</div>
			<div class="flex flex-wrap gap-x-2.5 gap-y-1.5 text-xs text-muted max-sm:hidden">
				<span
					>{#each ['←', '↑', '→', '↓'] as k (k)}{@render key(k)}{/each} move</span
				>
				<span>{@render key('+')}{@render key('−')} zoom</span>
				<span>{@render key('[')}{@render key(']')} turn</span>
				<span>{@render key('0')} reset</span>
			</div>
		</div>
	</div>
	<div class="sr-only" aria-live="polite">{announce}</div>

	{#snippet footer()}
		<Button
			variant="ghost"
			disabled={!ready}
			onclick={reset}
			data-testid="picture-reset"
			title="Put the picture back as it was opened (0)">Reset</Button
		>
		<span class="mr-auto ml-1 text-xs text-muted max-sm:hidden"
			>Nothing is saved until you press Save.</span
		>
		<Button class="max-sm:flex-1" disabled={busy} onclick={onclose} data-testid="picture-cancel"
			>Cancel</Button
		>
		<Button
			variant="primary"
			class="max-sm:flex-1"
			disabled={!ready}
			loading={busy}
			onclick={() => void save()}
			data-testid="picture-save">{busy ? 'Saving…' : 'Save picture'}</Button
		>
	{/snippet}
</ResponsiveModal>

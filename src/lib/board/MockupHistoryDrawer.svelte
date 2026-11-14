<script lang="ts">
	// IMPORTED MODULES
	import { ago } from '#lib/board/status.js';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';

	// -- TYPES -- //

	type Version = {
		number: number;
		size: number;
		createdAt: string | Date;
		restoredFrom: number | null;
		hasScreenshot: boolean;
	};

	// -- REQUIRED PROPS -- //

	let {
		open,
		onclose,
		versions,
		current,
		viewing,
		canWrite,
		hrefFor,
		onrestore
	}: {
		open: boolean;
		onclose: () => void;
		/** Newest first. */
		versions: Version[];
		/** The version the mockup is at now. */
		current: number;
		/** The version on show in the viewer. */
		viewing: number;
		canWrite: boolean;
		hrefFor: (version: number) => string;
		onrestore: (version: number) => Promise<void>;
	} = $props();

	// -- STATES -- //

	let busy = $state<number | null>(null);

	// -- FUNCTIONS -- //

	const kb = (n: number) =>
		n < 1024 * 1024
			? `${Math.max(1, Math.round(n / 1024))} KB`
			: `${(n / 1024 / 1024).toFixed(1)} MB`;

	async function restore(n: number) {
		busy = n;
		try {
			await onrestore(n);
		} finally {
			busy = null;
		}
	}
</script>

<!-- HISTORY: EVERY VERSION, NEWEST FIRST. PREVIEW OPENS ONE, RESTORE COPIES IT ON TOP AS THE NEWEST. NOTHING IS EVER DELETED -->
<ResponsiveModal {open} {onclose} title="History" variant="drawer" busy={busy !== null}>
	<p class="mb-3 text-sm text-muted">
		Restore copies an earlier version on top as the newest one. Nothing is deleted, and pins stay
		with the version they were made on.
	</p>
	<ul class="rounded-xl border border-line bg-surface" data-testid="mockup-history">
		{#each versions as v (v.number)}
			<li
				class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-3.5 py-3 last:border-b-0"
				data-testid="mockup-version"
			>
				<span class="min-w-0 flex-1">
					<span class="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
						Version {v.number}
						{#if v.number === current}<Badge tone="success">Current</Badge>{/if}
						{#if v.number === viewing && v.number !== current}<Badge>Viewing</Badge>{/if}
					</span>
					<span class="block text-xs text-muted">
						{v.restoredFrom ? `Copied from version ${v.restoredFrom}` : 'Published'}, {ago(
							v.createdAt
						)}, {kb(v.size)}
					</span>
				</span>
				<span class="flex items-center gap-2">
					<Button
						size="sm"
						href={hrefFor(v.number)}
						onclick={onclose}
						aria-label={`Preview version ${v.number}`}>Preview</Button
					>
					{#if canWrite && v.number !== current}
						<Button
							size="sm"
							loading={busy === v.number}
							onclick={() => restore(v.number)}
							aria-label={`Restore version ${v.number}`}>Restore</Button
						>
					{/if}
				</span>
			</li>
		{/each}
	</ul>
</ResponsiveModal>

<script lang="ts">
	// IMPORTED DEP-COMPONENTS
	import Download from '@lucide/svelte/icons/download';
	import Package from '@lucide/svelte/icons/package';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	// IMPORTED COMPONENTS
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import CopyButton from '#lib/ui/CopyButton.svelte';
	import PromptPreview from '#lib/ui/PromptPreview.svelte';

	// -- REQUIRED PROPS -- //

	let {
		bundle,
		count,
		brief,
		bundleUrl
	}: {
		bundle: { version: string; releasedAt: string };
		/** How many skills the release holds. */
		count: number;
		/** The Markdown the person copies into their agent. */
		brief: string;
		bundleUrl: string;
	} = $props();
</script>

<!-- THE RELEASE ON THE LEFT AND HOW TO INSTALL IT ON THE RIGHT. THE ZIP IS A FILE, NOT A PAGE, SO THE ROUTER LEAVES THAT LINK ALONE -->
<div
	class="overflow-hidden rounded-xl border border-line bg-surface text-ink shadow-[var(--elev-1)]"
	data-testid="skills-install"
>
	<div class="grid lg:grid-cols-3">
		<div
			class="flex flex-col justify-between gap-4 border-b border-line bg-band p-5 max-sm:p-3.5 lg:border-r lg:border-b-0"
			data-testid="skills-release-panel"
		>
			<div class="flex items-center gap-2 text-sm text-muted">
				<Package size={16} class="shrink-0" aria-hidden="true" />Latest release
			</div>
			<div>
				<p
					class="text-xl leading-9 font-semibold tracking-tight text-ink tabular-nums sm:text-2xl"
					data-testid="skills-release"
				>
					{bundle.version}
				</p>
				<p class="text-sm text-muted">
					Released {bundle.releasedAt}. Every skill has its own version too.
				</p>
			</div>
			<div class="flex flex-wrap items-center gap-2">
				<Badge tone="success">Latest</Badge>
				<Badge class="tabular-nums">{count} skills</Badge>
			</div>
		</div>
		<div class="p-5 max-sm:p-3.5 lg:col-span-2">
			<div class="flex items-start gap-3">
				<span
					class="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-text"
					aria-hidden="true"><Sparkles size={18} /></span
				>
				<div class="min-w-0">
					<h2 class="text-lg leading-6 font-semibold">Let your agent install the skills</h2>
					<p class="text-sm text-muted">
						Copy this, paste it into your agent. It checks what you have and asks before it changes
						anything you edited. An agent already connected to the board offers this by itself.
					</p>
				</div>
			</div>
			<!-- BOTH BUTTONS ARE THE SAME SIZE AND SIT ON ONE ROW, TWO ACROSS ON A PHONE -->
			<div class="mt-4 grid grid-cols-2 gap-2 sm:flex" data-testid="skills-actions">
				<CopyButton text={brief} label="Copy install prompt" data-testid="skills-copy" />
				<Button href={bundleUrl} data-sveltekit-reload data-testid="skills-download">
					<Download size={16} aria-hidden="true" />Download bundle
				</Button>
			</div>
			<PromptPreview text={brief} mode="disclosure" testid="skills-preview" />
		</div>
	</div>
</div>

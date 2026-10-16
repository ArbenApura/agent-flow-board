<script lang="ts">
	// -- MODULES -- //
	import { toast, toasts } from '#lib/ui/toast.svelte.js';
	import { cn } from '#lib/ui/cn.js';
	// -- DEP-COMPONENTS -- //
	import CheckCircle from 'phosphor-svelte/lib/CheckCircle';
	import Info from 'phosphor-svelte/lib/Info';
	import Warning from 'phosphor-svelte/lib/Warning';
	import WarningCircle from 'phosphor-svelte/lib/WarningCircle';
	import X from 'phosphor-svelte/lib/X';

	// -- CONSTANTS -- //

	const TONE = {
		success: { icon: CheckCircle, text: 'text-success' },
		info: { icon: Info, text: 'text-info' },
		warning: { icon: Warning, text: 'text-warning' },
		danger: { icon: WarningCircle, text: 'text-danger' }
	};
</script>

<!-- ONE TOASTER FOR THE WHOLE APP, MOUNTED IN THE ROOT LAYOUT ONLY -->
<div
	class="pointer-events-none fixed right-4 bottom-4 z-[4000] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 max-sm:right-4 max-sm:left-4 max-sm:w-auto"
	aria-live="polite"
	aria-relevant="additions"
>
	{#each toasts.items as t (t.id)}
		{@const Icon = TONE[t.tone].icon}
		<div
			role={t.tone === 'danger' ? 'alert' : 'status'}
			onmouseenter={() => toasts.hold(t.id)}
			onmouseleave={() => toasts.release(t.id)}
			onfocusin={() => toasts.hold(t.id)}
			onfocusout={() => toasts.release(t.id)}
			class="pointer-events-auto flex items-start gap-3 rounded-lg border border-line bg-surface p-3 text-sm leading-5 text-ink shadow-[var(--shadow-pop)]"
		>
			<Icon size={20} class={cn('mt-px shrink-0', TONE[t.tone].text)} aria-hidden="true" />
			<p class="min-w-0 flex-1">{t.text}</p>
			{#if t.action}
				<button
					type="button"
					class="cursor-pointer rounded-md px-2 py-1 font-medium text-accent-text hover:bg-raised"
					onclick={async () => {
						toasts.dismiss(t.id);
						// A failed action says so, instead of vanishing with the notice
						try {
							await t.action?.run();
						} catch {
							toast.error('That did not work.');
						}
					}}
				>
					{t.action.label}
				</button>
			{/if}
			<button
				type="button"
				aria-label="Dismiss"
				class="relative inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted before:absolute before:-inset-2.5 before:content-[''] hover:text-ink"
				onclick={() => toasts.dismiss(t.id)}
			>
				<X size={14} />
			</button>
		</div>
	{/each}
</div>

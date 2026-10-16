<script lang="ts">
	// -- DEP-COMPONENTS -- //
	import { Toaster } from 'svelte-sonner';
</script>

<!-- ONE TOASTER FOR THE WHOLE APP, MOUNTED IN THE ROOT LAYOUT ONLY. SONNER READS THE TOKENS THROUGH ITS OWN VARIABLES, SO BOTH MODES FOLLOW data-mode. THE ! SUFFIX IS NEEDED: SONNER SETS THEM ON [data-sonner-theme] (HIGHER SPECIFICITY THAN A CLASS) AND DEFAULTS TO THE LIGHT SET -->
<Toaster
	position="bottom-right"
	closeButton
	visibleToasts={4}
	offset="16px"
	mobileOffset="16px"
	class="z-[4000] [--border-radius:8px] [--error-bg:var(--surface)]! [--error-border:var(--line)]! [--error-text:var(--danger)]! [--info-bg:var(--surface)]! [--info-border:var(--line)]! [--info-text:var(--info)]! [--normal-bg:var(--surface)]! [--normal-border:var(--line)]! [--normal-text:var(--ink)]! [--success-bg:var(--surface)]! [--success-border:var(--line)]! [--success-text:var(--success)]! [--warning-bg:var(--surface)]! [--warning-border:var(--line)]! [--warning-text:var(--warning)]!"
	toastOptions={{
		class: 'font-sans text-sm shadow-[var(--shadow-pop)]',
		classes: {
			title: '!text-ink',
			actionButton: '!bg-accent !text-accent-ink',
			closeButton: '!bg-surface !text-muted !border-line'
		}
	}}
/>

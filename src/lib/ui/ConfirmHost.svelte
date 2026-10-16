<script lang="ts">
	// -- MODULES -- //
	import { confirmStore } from '#lib/ui/confirm.svelte.js';
	// -- COMPONENTS -- //
	import ConfirmDialog from '#lib/ui/ConfirmDialog.svelte';

	// -- REACTIVE STATES -- //

	const q = $derived(confirmStore.question);
</script>

<ConfirmDialog
	open={q !== null}
	onclose={() => confirmStore.answer(false)}
	title={q?.title ?? ''}
	confirmLabel={q?.confirmLabel ?? 'Confirm'}
	tone={q?.tone ?? 'danger'}
	onconfirm={() => confirmStore.answer(true)}
>
	<p class="text-sm text-muted">{q?.body}</p>
</ConfirmDialog>

<script lang="ts">
	// IMPORTED MODULES
	import { confirmStore } from '#lib/ui/confirm.svelte.js';
	// IMPORTED COMPONENTS
	import ConfirmDialog from '#lib/ui/ConfirmDialog.svelte';

	// -- STATES -- //

	// The last question stays here so the content does not blank out during the close transition
	let held = $state<typeof confirmStore.question>(null);

	// -- REACTIVE STATES -- //

	const open = $derived(confirmStore.question !== null);
	const q = $derived(confirmStore.question ?? held);

	// -- REACTIVE STATEMENTS -- //

	$effect(() => {
		if (confirmStore.question) held = confirmStore.question;
	});
</script>

<ConfirmDialog
	{open}
	onclose={() => confirmStore.answer(false)}
	title={q?.title ?? ''}
	confirmLabel={q?.confirmLabel ?? 'Confirm'}
	tone={q?.tone ?? 'danger'}
	onconfirm={() => confirmStore.answer(true)}
>
	<p class="text-sm text-muted">{q?.body}</p>
</ConfirmDialog>

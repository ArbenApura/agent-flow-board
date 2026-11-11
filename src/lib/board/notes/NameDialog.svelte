<script lang="ts">
	// -- DEP-MODULES -- //
	import { untrack } from 'svelte';
	// -- COMPONENTS -- //
	import Button from '#lib/ui/Button.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import TextField from '#lib/ui/TextField.svelte';

	// -- REQUIRED PROPS -- //

	let {
		open,
		onclose,
		title,
		label,
		confirm,
		onsave,
		initial = '',
		hint,
		placeholder,
		maxlength = 200
	}: {
		open: boolean;
		onclose: () => void;
		/** The heading of the dialog: New note, New folder, Rename the folder. */
		title: string;
		/** The plain question above the field. */
		label: string;
		/** The words on the button that saves. */
		confirm: string;
		/** Saves the name. Returns a plain message when it could not, and nothing when it did. */
		onsave: (name: string) => Promise<string | null | void>;
		initial?: string;
		hint?: string;
		placeholder?: string;
		maxlength?: number;
	} = $props();

	// -- CONSTANTS -- //

	const uid = $props.id();
	const formId = `${uid}-form`;

	// -- STATES -- //

	let name = $state('');
	let error = $state('');
	let busy = $state(false);
	let prevOpen = false;

	// -- REACTIVE STATEMENTS -- //

	// The field starts from the given name each time the dialog opens, and is left alone while the person types
	$effect(() => {
		if (open && !prevOpen)
			untrack(() => {
				name = initial;
				error = '';
			});
		prevOpen = open;
	});

	// -- FUNCTIONS -- //

	async function save() {
		const value = name.trim();
		if (!value || busy) return;
		busy = true;
		error = '';
		try {
			const refused = await onsave(value);
			if (refused) error = refused;
			else onclose();
		} finally {
			busy = false;
		}
	}
</script>

<!-- ONE SMALL DIALOG THAT ASKS FOR A NAME: A NEW NOTE, A NEW FOLDER OR A NEW NAME FOR A FOLDER -->
<ResponsiveModal {open} {onclose} {title} size="sm" {busy}>
	<form
		id={formId}
		class="flex flex-col gap-3 text-sm"
		onsubmit={(e) => {
			e.preventDefault();
			void save();
		}}
	>
		<TextField {label} {hint} {placeholder} {maxlength} bind:value={name} {error} class="text-sm" />
	</form>
	{#snippet footer()}
		<div class="flex w-full flex-wrap items-center justify-end gap-2">
			<Button disabled={busy} onclick={onclose} class="text-sm">Cancel</Button>
			<Button
				variant="primary"
				type="submit"
				form={formId}
				loading={busy}
				disabled={!name.trim()}
				class="text-sm">{confirm}</Button
			>
		</div>
	{/snippet}
</ResponsiveModal>

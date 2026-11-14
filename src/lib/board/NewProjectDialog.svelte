<script lang="ts">
	// IMPORTED MODULES
	import { untrack } from 'svelte';
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import Button from '#lib/ui/Button.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';

	// -- REQUIRED PROPS -- //

	let {
		org,
		open,
		onclose,
		oncreated
	}: {
		/** The slug of the organisation the project is made in. */
		org: string;
		/** Always mounted with this flag, never inside an {#if}, so the out transition plays. */
		open: boolean;
		onclose: () => void;
		/** Called with the new key once the project exists. */
		oncreated: (key: string) => void | Promise<void>;
	} = $props();

	// -- CONSTANTS -- //

	const CODE = /^[A-Z][A-Z0-9]{1,9}$/;

	// -- STATES -- //

	let name = $state('');
	let typedCode = $state('');
	let codeEdited = $state(false);
	let busy = $state(false);
	let error = $state('');
	let wasOpen = false;

	// -- FUNCTIONS -- //

	/** Capitals and digits only, at most 10. */
	const clean = (value: string) =>
		value
			.toUpperCase()
			.replace(/[^A-Z0-9]/g, '')
			.slice(0, 10);

	/** A short code from the name: the first letters of the words, or the first three letters of a single word. */
	function suggest(value: string) {
		const words = value
			.toUpperCase()
			.split(/[^A-Z0-9]+/)
			.filter(Boolean);
		if (words.length === 0) return '';
		if (words.length === 1) return clean(words[0].slice(0, 3));
		return clean(
			words
				.map((w) => w[0])
				.join('')
				.slice(0, 4)
		);
	}

	async function create() {
		if (!valid || busy) return;
		busy = true;
		error = '';
		try {
			const made = await toast.promise(
				api<{ key: string }>(org, '/projects', {
					body: { key: code, name: name.trim() },
					key: newKey()
				}),
				{
					loading: 'Creating the project...',
					success: `Project ${name.trim()} created.`,
					error: (e) => (e instanceof ApiError ? e.message : 'The project was not created.')
				}
			);
			onclose();
			await oncreated(made?.key ?? code);
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'The project was not created.';
		} finally {
			busy = false;
		}
	}

	// -- REACTIVE STATES -- //

	const code = $derived(codeEdited ? clean(typedCode) : suggest(name));
	const valid = $derived(name.trim().length >= 2 && CODE.test(code));

	// -- REACTIVE STATEMENTS -- //

	// Each time the dialog opens it starts empty
	$effect(() => {
		const now = open;
		if (now && !wasOpen) {
			untrack(() => {
				name = '';
				typedCode = '';
				codeEdited = false;
				error = '';
			});
		}
		wasOpen = now;
	});
</script>

<ResponsiveModal {open} {onclose} title="New project" {busy}>
	<form
		class="flex flex-col gap-4"
		onsubmit={(e) => {
			e.preventDefault();
			void create();
		}}
	>
		<TextField
			label="Project name"
			bind:value={name}
			placeholder="Checkout flow"
			required
			data-testid="project-name"
		/>
		<TextField
			label="Short code"
			bind:value={
				() => code,
				(v) => {
					codeEdited = true;
					typedCode = v;
				}
			}
			placeholder="CF"
			hint={code && CODE.test(code)
				? `Every item gets a number with it, like ${code}-1 and ${code}-2.`
				: 'Letters and digits only, starting with a letter. At least 2.'}
			required
			data-testid="project-key"
		/>
		{#if error}<p class="text-sm text-danger" role="alert">{error}</p>{/if}
		<div class="flex justify-end gap-2">
			<Button onclick={onclose} disabled={busy}>Cancel</Button>
			<Button
				type="submit"
				variant="primary"
				loading={busy}
				disabled={!valid}
				data-testid="project-create">Create project</Button
			>
		</div>
	</form>
</ResponsiveModal>

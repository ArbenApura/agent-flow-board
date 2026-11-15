<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { Snippet } from 'svelte';
	// IMPORTED MODULES
	import { PICTURE_ACCEPT } from '#lib/board/pictures.js';
	import { checkSourceFile } from '#lib/board/pictureSource.js';
	import { cn } from '#lib/ui/cn.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	// IMPORTED COMPONENTS
	import Button from '#lib/ui/Button.svelte';
	import FilePicker from '#lib/ui/FilePicker.svelte';
	import PictureEditor from '#lib/ui/PictureEditor.svelte';

	// -- REQUIRED PROPS -- //

	let {
		label,
		removeLabel,
		hasPicture,
		canEdit,
		testid,
		shape = 'square',
		previewName,
		onupload,
		onremove,
		preview
	}: {
		/** What the picture is called, for the group and the file field: Logo, Picture. */
		label: string;
		/** The text of the remove button, for example Remove the logo. */
		removeLabel: string;
		hasPicture: boolean;
		/** Whether this person may change it. Someone who may not still sees the current picture. */
		canEdit: boolean;
		/** Prefix of the test ids: `${testid}-file` and `${testid}-remove`. */
		testid: string;
		/** A round frame in the editor for a person's picture, a rounded square for a logo. */
		shape?: 'round' | 'square';
		/** A logo is shown beside this name in the editor's preview, as in the sidebar. */
		previewName?: string;
		/** Receives the cropped picture from the editor. The editor shows Saving until this settles. */
		onupload: (file: File) => void | Promise<void>;
		onremove: () => void;
		/** The current picture, drawn by the page (an avatar, an organisation tile, a project tile) at 40, or at 96 on a tablet and a phone. */
		preview: Snippet<[40 | 96]>;
	} = $props();

	// -- STATES -- //

	/** True while a file is held over the area. */
	let dragging = $state(false);
	/** Bumped after every attempt, so the picker starts empty and the same file can be chosen again. */
	let pickerKey = $state(0);
	/** The file the editor is cropping. It stays set while the editor closes, so the dialog does not go blank. */
	let chosen = $state<File | null>(null);
	let editing = $state(false);

	// -- REACTIVE STATES -- //

	const subject = $derived(shape === 'round' ? 'picture' : 'logo');

	// -- FUNCTIONS -- //

	/** Every way a picture arrives (Browse, drop, paste) comes here: the checks first, then the editor opens at once. */
	function choose(file: File | undefined) {
		pickerKey++;
		if (!canEdit || !file || editing) return;
		const check = checkSourceFile(file);
		if (!check.ok) {
			toast.error(check.message);
			return;
		}
		chosen = file;
		editing = true;
	}

	function drop(e: DragEvent) {
		e.preventDefault();
		dragging = false;
		choose(e.dataTransfer?.files?.[0]);
	}

	/** A picture pasted anywhere on the page opens the editor, unless the person is typing in a field. */
	function paste(e: ClipboardEvent) {
		if (!canEdit || editing) return;
		const t = e.target as HTMLElement | null;
		if (t?.closest('input, textarea, [contenteditable="true"]')) return;
		const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith('image/'));
		if (f) {
			e.preventDefault();
			choose(f);
		}
	}
</script>

<svelte:window onpaste={paste} />

<!-- THE PICTURE AREA TAKES A CHOSEN, DROPPED OR PASTED FILE AND OPENS THE EDITOR. ON A TABLET OR A PHONE IT IS ONE CENTRED COLUMN, THE PICTURE ON TOP -->
<div
	role="group"
	aria-label={label}
	ondragover={(e) => {
		// Always stop the browser opening the file, even for someone who may not upload
		e.preventDefault();
		if (canEdit) dragging = true;
	}}
	ondragleave={() => (dragging = false)}
	ondrop={drop}
	class={cn(
		'flex flex-col items-stretch gap-3 rounded-lg border p-4 lg:flex-row lg:flex-wrap lg:items-start lg:p-3',
		canEdit && 'border-dashed',
		dragging ? 'border-accent bg-accent-soft' : 'border-line'
	)}
>
	{#snippet picture()}
		<span
			class="inline-flex shrink-0 items-center justify-center lg:min-h-11"
			title={`The current ${label.toLowerCase()}`}
		>
			<span class="lg:hidden">{@render preview(96)}</span>
			<span class="max-lg:hidden">{@render preview(40)}</span>
		</span>
	{/snippet}
	{#if canEdit}
		<!-- THE SAME LABEL AND GAP AS THE PICKER ON A WIDE SCREEN, SO THE PICTURE AND THE BUTTON CENTRE ON THE FIELD -->
		<div class="flex flex-col items-center gap-1.5 lg:items-start">
			<span aria-hidden="true" class="invisible hidden text-xs font-medium lg:block">{label}</span>
			{@render picture()}
		</div>
		<div class="flex min-w-0 flex-col gap-1.5 lg:w-72">
			{#key pickerKey}
				<FilePicker
					{label}
					prompt={`Choose a ${subject}`}
					accept={PICTURE_ACCEPT}
					data-testid={`${testid}-file`}
					onchange={choose}
					class="w-full max-lg:[&>span:first-of-type]:sr-only"
				/>
			{/key}
			<span class="text-xs text-muted max-lg:text-center">
				<span class="max-lg:hidden"
					>Choose, drop or paste any picture up to 10 MB. You crop it next.</span
				>
				<span class="lg:hidden">Any picture up to 10 MB. You crop it next.</span>
			</span>
		</div>
		{#if hasPicture}
			<div class="flex flex-col gap-1.5 max-lg:-mt-1">
				<span aria-hidden="true" class="invisible hidden text-xs font-medium lg:block">{label}</span
				>
				<div class="flex min-h-11 items-center">
					<Button
						variant="ghost"
						tone="danger"
						class="max-lg:w-full"
						onclick={onremove}
						data-testid={`${testid}-remove`}>{removeLabel}</Button
					>
				</div>
			</div>
		{/if}
	{:else}
		{@render picture()}
	{/if}
</div>

<!-- ALWAYS MOUNTED, SHOWN BY open. SAVE HANDS THE CROPPED FILE TO onupload, THEN THE EDITOR CLOSES -->
{#if canEdit}
	<PictureEditor
		open={editing}
		file={chosen}
		{shape}
		{subject}
		{previewName}
		onclose={() => (editing = false)}
		onsave={(f) => onupload(f)}
	/>
{/if}

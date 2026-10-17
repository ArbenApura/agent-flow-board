<script lang="ts">
	// -- DEP-TYPES -- //
	import type { Snippet } from 'svelte';
	// -- MODULES -- //
	import { PICTURE_ACCEPT } from '#lib/board/pictures.js';
	import { cn } from '#lib/ui/cn.js';
	import Button from '#lib/ui/Button.svelte';
	import FilePicker from '#lib/ui/FilePicker.svelte';

	// -- REQUIRED PROPS -- //

	let {
		label,
		hint = 'A PNG, JPEG or WebP under 200 KB',
		removeLabel,
		hasPicture,
		canEdit,
		testid,
		onupload,
		onremove,
		preview
	}: {
		/** What the picture is called, for the group and the file field: Logo, Picture. */
		label: string;
		hint?: string;
		/** The text of the remove button, for example Remove the logo. */
		removeLabel: string;
		hasPicture: boolean;
		/** Whether this person may change it. Someone who may not still sees the current picture. */
		canEdit: boolean;
		/** Prefix of the test ids: `${testid}-file` and `${testid}-remove`. */
		testid: string;
		onupload: (file: File) => void;
		onremove: () => void;
		/** The current picture, drawn by the page (an avatar, an organisation tile, a project tile). */
		preview: Snippet;
	} = $props();

	// -- STATES -- //

	/** True while a file is held over the area. */
	let dragging = $state(false);
	/** Bumped after every attempt, so the picker starts empty and the same file can be chosen again. */
	let pickerKey = $state(0);

	// -- FUNCTIONS -- //

	/** A file dropped on the area goes the same way as one chosen with the button, so the server checks its type and size. */
	function drop(e: DragEvent) {
		e.preventDefault();
		dragging = false;
		const file = e.dataTransfer?.files?.[0];
		if (canEdit && file) send(file);
	}

	function send(file: File) {
		onupload(file);
		pickerKey++;
	}
</script>

<!-- THE PICTURE AREA TAKES A DROPPED FILE AS WELL AS THE BUTTON. THE BUTTON IS THE ONLY PATH A PHONE NEEDS. THE SERVER STILL CHECKS TYPE AND SIZE -->
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
		'flex flex-wrap items-center gap-3 rounded-lg border p-3',
		canEdit && 'border-dashed',
		dragging ? 'border-accent bg-accent-soft' : 'border-line'
	)}
>
	<span class="inline-flex shrink-0" title={`The current ${label.toLowerCase()}`}>
		{@render preview()}
	</span>
	{#if canEdit}
		{#key pickerKey}
			<FilePicker
				{label}
				{hint}
				accept={PICTURE_ACCEPT}
				data-testid={`${testid}-file`}
				onchange={(f) => {
					if (f) send(f);
				}}
				class="w-72"
			/>
		{/key}
		{#if hasPicture}
			<Button size="sm" variant="ghost" onclick={onremove} data-testid={`${testid}-remove`}
				>{removeLabel}</Button
			>
		{/if}
	{/if}
</div>

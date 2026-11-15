<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { ContinueAction, CreateKind } from '#lib/shared/continue.js';
	// IMPORTED DEP-MODULES
	import { untrack } from 'svelte';
	// IMPORTED MODULES
	import {
		ACTION_TITLE,
		CREATE_QUESTION,
		CREATE_TITLE,
		IDEA_LIMIT,
		buildCreatePrompt,
		buildPrompt,
		createPrefix,
		noteIdea
	} from '#lib/shared/continue.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	// IMPORTED DEP-COMPONENTS
	import Copy from '@lucide/svelte/icons/copy';
	// IMPORTED COMPONENTS
	import Button from '#lib/ui/Button.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import TextArea from '#lib/ui/TextArea.svelte';

	// -- REQUIRED PROPS -- //

	let {
		open,
		onclose,
		item,
		action = 'resume',
		create = null
	}: {
		/** Always mounted with this flag, never inside an {#if}, so the close transition plays. */
		open: boolean;
		onclose: () => void;
		/** The item to continue, with the path of its page. */
		item: { ref: string; title: string; href: string } | null;
		/** Which workflow the prompt runs: resume the item, ask about it, audit it, review it or interview about it. */
		action?: ContinueAction;
		/** Set for New plan and New task: nothing exists yet, so the idea box takes the place of the prompt box. The key is the project the page is in. */
		create?: { kind: CreateKind; key: string; note?: string } | null;
	} = $props();

	// -- CONSTANTS -- //

	const uid = $props.id();
	const ideaLabelId = `${uid}-idea-label`;
	const ideaMissingId = `${uid}-idea-missing`;
	/** What is missing while the idea box is empty. */
	const IDEA_MISSING: Record<CreateKind, string> = {
		plan: 'Write what you want to build first.',
		task: 'Write what needs doing first.'
	};

	// -- STATES -- //

	/** The item and action shown, kept while the dialog slides out, so the content does not flash blank. */
	let shown = $state<NonNullable<typeof item> | null>(null);
	let shownAction = $state<ContinueAction>('resume');
	/** The create request shown, kept while the dialog slides out. */
	let shownCreate = $state<NonNullable<typeof create> | null>(null);
	/** What the person wrote after the fixed words of a New plan or New task prompt. */
	let idea = $state('');
	/** The text the idea box starts with each time the dialog opens. The id changes on every open, so the box is filled again. */
	let seed = $state({ text: '', id: 0 });
	/** What the person typed over the prompt of an item. Null means they have not touched it. */
	let typed = $state<string | null>(null);
	let prevOpen = false;

	// -- REACTIVE STATES -- //

	/** The prompt the app writes for this action. */
	const generated = $derived(
		shownCreate
			? buildCreatePrompt({ kind: shownCreate.kind, key: shownCreate.key, idea })
			: shown
				? buildPrompt({ action: shownAction, ref: shown.ref })
				: ''
	);
	const prompt = $derived(typed ?? generated);
	const prefix = $derived(shownCreate ? createPrefix(shownCreate.kind, shownCreate.key) : '');
	/** What is still missing in the prompt. A question is finished by the person after the colon. */
	const missing = $derived(
		shownCreate
			? idea.trim()
				? ''
				: IDEA_MISSING[shownCreate.kind]
			: shownAction === 'ask' && prompt.trim() === generated.trim()
				? 'Type what you want to ask after the colon.'
				: !prompt.trim()
					? 'Write what the prompt should say first.'
					: ''
	);
	const intro = $derived(
		shownCreate?.kind === 'task'
			? 'Your tool writes the task through the /flow-task skill, so its rules stay in one place.'
			: 'Every change still goes through the /flow skill, so its rules stay in one place.'
	);

	// -- REACTIVE STATEMENTS -- //

	// Starts from the item and the action each time the dialog opens. Writes are untracked, so typing is never wiped.
	$effect(() => {
		const isOpen = open;
		const next = item;
		const act = action;
		const made = create;
		untrack(() => {
			if (isOpen && !prevOpen && (next || made)) {
				shown = made ? null : next;
				shownCreate = made;
				shownAction = made ? 'ask' : act;
				typed = null;
				// A note hands over its reference as the idea, and the person may add to it
				idea = made?.note ? noteIdea(made.note) : '';
				seed = { text: idea, id: seed.id + 1 };
			}
			prevOpen = isOpen;
		});
	});

	// -- FUNCTIONS -- //

	/** Fills the idea box with its starting text, and again whenever the dialog opens anew. The person's own typing is never touched. */
	function seedIdea(node: HTMLElement, value: { text: string; id: number }) {
		node.textContent = value.text;
		return {
			update(next: { text: string; id: number }) {
				if (next.id !== value.id) node.textContent = next.text;
				value = next;
			}
		};
	}

	function onIdeaInput(e: Event & { currentTarget: HTMLElement }) {
		const el = e.currentTarget;
		// A browser leaves a stray line break behind an emptied box, which would hide the placeholder
		if (!el.textContent) el.replaceChildren();
		idea = (el.textContent ?? '').slice(0, IDEA_LIMIT);
	}

	/** Pastes plain text only, so no formatting or markup ever reaches the prompt. */
	function onIdeaPaste(e: ClipboardEvent) {
		e.preventDefault();
		const text = e.clipboardData?.getData('text/plain') ?? '';
		document.execCommand('insertText', false, text);
	}

	/** A click anywhere in the box, also on the fixed words, puts the cursor in the writable part. */
	function focusIdea(e: MouseEvent & { currentTarget: HTMLElement }) {
		const editable = e.currentTarget.querySelector<HTMLElement>('[data-idea]');
		if (!editable || e.target === editable) return;
		e.preventDefault();
		editable.focus();
	}

	async function copy() {
		if (missing || !prompt.trim()) return;
		try {
			await navigator.clipboard.writeText(prompt.trim());
			toast.success('Prompt copied. Paste it into your tool.');
			onclose();
		} catch {
			toast.warning('Copy did not work here. Select the text and copy it by hand.');
		}
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			void copy();
		}
	}
</script>

<!-- COPY THE PROMPT. NEW PLAN AND NEW TASK SHOW ONE TEXT AREA WITH THE FIXED WORDS INSIDE IT, AN ITEM SHOWS ITS PROMPT -->
<ResponsiveModal
	{open}
	{onclose}
	size="lg"
	title={shownCreate
		? `${CREATE_TITLE[shownCreate.kind]} in ${shownCreate.key}`
		: shown
			? `${ACTION_TITLE[shownAction]} ${shown.ref}`
			: 'Copy a prompt'}
>
	<div class="flex flex-col gap-4" data-testid="continue-dialog">
		<p class="text-xs text-muted">{intro}</p>
		{#if shownCreate}
			<!-- THE IDEA BOX: THE FIXED WORDS ARE THE FIRST WORDS INSIDE IT, THE TYPED TEXT FOLLOWS AND WRAPS UNDER THEM -->
			<div class="flex flex-col gap-1">
				<span id={ideaLabelId} class="text-xs font-medium text-muted"
					>{CREATE_QUESTION[shownCreate.kind]}</span
				>
				<!-- The box only forwards a click on the fixed words to the writable part, which is the real control -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class={[
						'min-h-[92px] cursor-text rounded-lg border bg-surface px-3 py-2.5 text-sm leading-6 break-words text-ink',
						'shadow-[var(--elev-1)] transition-[border-color,box-shadow] duration-150 focus-within:border-accent focus-within:ring-4 focus-within:ring-accent-soft motion-reduce:transition-none',
						missing ? 'border-warning' : 'border-line'
					]}
					onmousedown={focusIdea}
				>
					<span
						contenteditable="false"
						class="mr-1.5 rounded-md bg-raised px-1.5 py-px font-mono text-xs text-muted select-none"
						data-testid="continue-prefix">{prefix}</span
					><span
						role="textbox"
						tabindex="0"
						aria-multiline="true"
						aria-labelledby={ideaLabelId}
						aria-describedby={missing ? ideaMissingId : undefined}
						contenteditable="plaintext-only"
						spellcheck="true"
						data-idea
						data-placeholder="Describe it in your own words"
						class="whitespace-pre-wrap outline-none empty:before:text-muted empty:before:content-[attr(data-placeholder)]"
						use:seedIdea={seed}
						oninput={onIdeaInput}
						onpaste={onIdeaPaste}
						onkeydown={onKey}
						data-testid="continue-idea"
					></span>
				</div>
				{#if missing}
					<p id={ideaMissingId} role="alert" class="text-xs text-warning">{missing}</p>
				{/if}
			</div>
		{:else}
			<!-- THE PROMPT OF AN ITEM, EDITABLE SO THE PERSON CAN ADD WORDS BEFORE COPYING -->
			<div class="flex flex-col gap-1">
				<TextArea
					label="Prompt"
					rows={3}
					class="font-mono"
					value={prompt}
					oninput={(e) => (typed = e.currentTarget.value)}
					onkeydown={onKey}
					spellcheck="false"
					data-testid="continue-prompt"
				/>
				<p
					class={missing ? 'text-xs text-warning' : 'text-xs text-muted'}
					aria-live="polite"
					data-testid={missing ? 'continue-problem' : undefined}
				>
					{missing || 'Copies the prompt so you can paste it into your session.'}
				</p>
			</div>
		{/if}
	</div>
	{#snippet footer()}
		<div class="flex w-full flex-wrap items-center justify-between gap-2">
			<!-- THE TWO KEYS STAY TOGETHER ON ONE LINE, AND THE HINT IS LEFT OUT ON A PHONE -->
			<p
				class="inline-flex items-center gap-1.5 text-xs whitespace-nowrap text-muted max-sm:hidden"
			>
				<kbd class="rounded-[6px] border border-line bg-raised px-1.5 py-0.5 font-mono text-xs"
					>Ctrl</kbd
				>
				+
				<kbd class="rounded-[6px] border border-line bg-raised px-1.5 py-0.5 font-mono text-xs"
					>Enter</kbd
				>
				copies
			</p>
			<Button variant="primary" class="max-sm:w-full" disabled={!!missing} onclick={copy}>
				<Copy size={16} aria-hidden="true" />
				Copy prompt
			</Button>
		</div>
	{/snippet}
</ResponsiveModal>

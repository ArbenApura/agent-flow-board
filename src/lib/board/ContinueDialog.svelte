<script lang="ts">
	// -- DEP-TYPES -- //
	import type {
		ContinueAction,
		ContinueMode,
		ContinueToolId,
		CreateKind
	} from '#lib/shared/continue.js';
	// -- ENVS -- //
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	// -- DEP-MODULES -- //
	import { onMount, untrack } from 'svelte';
	// -- MODULES -- //
	import {
		ACTION_TITLE,
		CONTINUE_MODE_LABEL,
		CONTINUE_TOOLS_SHOWN,
		CREATE_QUESTION,
		CREATE_TITLE,
		IDEA_LIMIT,
		buildCommand,
		buildCreatePrompt,
		buildPrompt,
		commandPrompt,
		effectiveMode,
		noteIdea,
		toolOf,
		usesSlash,
		validPair,
		vscodeLink
	} from '#lib/shared/continue.js';
	import Button from '#lib/ui/Button.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import SegmentedControl from '#lib/ui/SegmentedControl.svelte';
	import TextArea from '#lib/ui/TextArea.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';
	// -- DEP-COMPONENTS -- //
	import Code from '@lucide/svelte/icons/code';
	import Copy from '@lucide/svelte/icons/copy';
	import Terminal from '@lucide/svelte/icons/terminal';

	// -- REQUIRED PROPS -- //

	let {
		open,
		onclose,
		item,
		action = 'resume',
		tool,
		mode,
		create = null
	}: {
		/** Always mounted with this flag, never inside an {#if}, so the close transition plays. */
		open: boolean;
		onclose: () => void;
		/** The item to continue, with the path of its page. */
		item: { ref: string; title: string; href: string } | null;
		/** Which workflow the tool runs: resume the item, ask about it, audit it, review it or interview about it. */
		action?: ContinueAction;
		/** The person's saved tool and way, from their settings. */
		tool: ContinueToolId;
		mode: ContinueMode;
		/** Set for New plan and New task: nothing exists yet, so an idea box takes the place of the item. The key is the project the page is in. */
		create?: { kind: CreateKind; key: string; note?: string } | null;
	} = $props();

	// -- CONSTANTS -- //

	const TOOL_OPTIONS = CONTINUE_TOOLS_SHOWN.map((t) => ({ value: t.id, label: t.label }));
	const ICON = { vscode: Code, command: Terminal, prompt: Copy };
	/** What is missing while the idea box is empty. */
	const IDEA_MISSING: Record<CreateKind, string> = {
		plan: 'Write what you want to build first.',
		task: 'Write what needs doing first.'
	};
	/** What each way does, shown under the prompt for the way the person usually uses. */
	const WAY_HINT: Record<ContinueMode, string> = {
		vscode: 'Opens Claude in VS Code with this typed in. Press Enter there to run it.',
		command: 'Copies one line that starts the tool with this prompt. Paste it into your terminal.',
		prompt: 'Copies the prompt so you can paste it into any session.'
	};

	// -- STATES -- //

	/** The item and action shown, kept while the dialog slides out, so the content does not flash blank. */
	let shown = $state<NonNullable<typeof item> | null>(null);
	let shownAction = $state<ContinueAction>('resume');
	/** The create request shown, kept while the dialog slides out. */
	let shownCreate = $state<NonNullable<typeof create> | null>(null);
	/** What the person wrote in the idea box. */
	let idea = $state('');
	let chosenTool = $state<ContinueToolId>('claude-code');
	/** What the person typed over the prompt. Empty means they have not touched it, so it follows the tool. */
	let typed = $state<string | null>(null);
	/** The way that is running, so only its button shows the spinner. */
	let running = $state<ContinueMode | null>(null);
	let coarse = $state(false);
	let prevOpen = false;

	// -- REACTIVE STATES -- //

	const url = $derived(shown ? `${page.url.origin}${shown.href}` : '');
	/** The prompt the app writes for this action and tool. It changes when the tool changes. */
	const generated = $derived(
		shownCreate
			? buildCreatePrompt({
					kind: shownCreate.kind,
					tool: chosenTool,
					key: shownCreate.key,
					idea
				})
			: shown
				? buildPrompt({
						action: shownAction,
						tool: chosenTool,
						ref: shown.ref,
						title: shown.title,
						url
					})
				: ''
	);
	const prompt = $derived(typed ?? generated);
	/** An edited prompt can hold anything, so it only goes into a command when every character is plain text. */
	const edited = $derived(prompt !== generated);
	// A create prompt carries the idea, so it only becomes a command when every character of it is plain text
	const commandText = $derived(
		shownCreate
			? prompt.trim()
			: shown
				? edited
					? prompt.trim()
					: commandPrompt(shownAction, chosenTool, shown.ref)
				: null
	);
	const command = $derived(commandText ? buildCommand(chosenTool, commandText) : null);
	const link = $derived(prompt.trim() ? vscodeLink(prompt.trim()) : null);
	const chosen = $derived(toolOf(chosenTool));
	/** The ways this tool can do, the person's usual one first, and Prompt first on a touch screen. */
	const ways = $derived.by(() => {
		const can: ContinueMode[] = [];
		if (chosen.vscode) can.push('vscode');
		if (chosen.command) can.push('command');
		can.push('prompt');
		const first: ContinueMode = coarse ? 'prompt' : effectiveMode(chosenTool, mode);
		return [first, ...can.filter((m) => m !== first)];
	});
	const usual = $derived(ways[0]);
	/** What is still missing in the prompt, whatever the way. A question is finished by the person after the colon. */
	const missing = $derived(
		shownCreate && typed === null && !idea.trim()
			? IDEA_MISSING[shownCreate.kind]
			: !shownCreate && shownAction === 'ask' && prompt.trim() === generated.trim()
				? 'Type what you want to ask after the colon.'
				: !prompt.trim()
					? 'Write what the tool should do first.'
					: ''
	);
	const note = $derived(problemOf(usual) || WAY_HINT[usual]);
	const hasProblem = $derived(!!problemOf(usual));
	const intro = $derived(
		usesSlash(chosenTool, shownAction)
			? shownCreate?.kind === 'task'
				? 'Your tool writes the task through the /flow-task skill, so its rules stay in one place.'
				: 'Every change still goes through the /flow skill, so its rules stay in one place.'
			: 'The tool reads the workflow through your Agent Flow Board connection (afb-<organisation>), so its work is tracked here.'
	);

	// -- REACTIVE STATEMENTS -- //

	// Starts from the item, the action and the saved tool each time the dialog opens. Writes are untracked, so typing is never wiped.
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
				chosenTool = tool;
				typed = null;
				// A note hands over its reference as the idea, and the person may add to it
				idea = made?.note ? noteIdea(made.note) : '';
			}
			prevOpen = isOpen;
		});
	});

	// -- FUNCTIONS -- //

	/** Why a way cannot run right now, in a plain sentence, or an empty string when it can. */
	function problemOf(m: ContinueMode): string {
		if (missing) return missing;
		if (m === 'vscode' && !link)
			return 'This prompt is too long for a link. Copy the prompt instead.';
		if (m === 'command' && !command)
			return 'This text has special characters, so it cannot be a command. Copy the prompt instead.';
		return '';
	}

	async function copy(text: string, ok: string): Promise<boolean> {
		try {
			await navigator.clipboard.writeText(text);
			toast.success(ok);
			return true;
		} catch {
			toast.warning('Copy did not work here. Select the text and copy it by hand.');
			return false;
		}
	}

	/** Remembers the way as the person's usual one. It never blocks and never shows an error. */
	async function remember(m: ContinueMode) {
		if (m === mode || !validPair(tool, m)) return;
		try {
			const res = await fetch('/continue', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ continueTool: tool, continueMode: m })
			});
			if (res.ok) await invalidateAll();
		} catch {
			/* The choice is a convenience, so a failed save is not worth a message */
		}
	}

	async function run(m: ContinueMode) {
		if (running || problemOf(m)) return;
		running = m;
		try {
			let done = false;
			if (m === 'vscode' && link) {
				window.location.href = link;
				toast.info('Sent to VS Code. Press Enter in the Claude chat to run it.');
				done = true;
			} else if (m === 'command' && command) {
				done = await copy(command, 'Command copied. Paste it into your terminal.');
			} else if (m === 'prompt') {
				done = await copy(prompt.trim(), 'Prompt copied. Paste it into your tool.');
			}
			if (!done) return;
			void remember(m);
			onclose();
		} finally {
			running = null;
		}
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			void run(usual);
		}
	}

	// -- LIFECYCLES -- //

	// A touch screen has no VS Code or terminal to hand, so Prompt comes first there. Read after mount, so the server and first paint agree
	onMount(() => {
		coarse = matchMedia('(pointer: coarse)').matches;
	});
</script>

<!-- CONTINUE WITH A TOOL, THE SAME HAND-OFF AS THE HAPR BOARD: CHECK THE PROMPT, THEN PICK THE WAY. THE USUAL WAY IS FIRST AND PRIMARY -->
<ResponsiveModal
	{open}
	{onclose}
	busy={running !== null}
	size="lg"
	title={shownCreate
		? `${CREATE_TITLE[shownCreate.kind]} in ${shownCreate.key}`
		: shown
			? `${ACTION_TITLE[shownAction]} ${shown.ref}`
			: 'Continue with a coding tool'}
>
	<div class="flex flex-col gap-4" data-testid="continue-dialog">
		<p class="text-xs text-muted">{intro}</p>
		<!-- THE IDEA BOX OF NEW PLAN AND NEW TASK. IT FEEDS THE PROMPT BELOW, AND TYPING IN IT STARTS THE PROMPT OVER -->
		{#if shownCreate}
			<TextArea
				label={CREATE_QUESTION[shownCreate.kind]}
				rows={3}
				value={idea}
				oninput={(e) => {
					idea = e.currentTarget.value;
					typed = null;
				}}
				onkeydown={onKey}
				maxlength={IDEA_LIMIT}
				hint={shownCreate.kind === 'task'
					? 'Paste a list to make one task for each line.'
					: undefined}
				data-testid="continue-idea"
			/>
		{/if}
		<TextArea
			label="Prompt"
			rows={4}
			class="font-mono"
			value={prompt}
			oninput={(e) => (typed = e.currentTarget.value)}
			onkeydown={onKey}
			spellcheck="false"
			data-testid="continue-prompt"
		/>
		<!-- WHAT THE USUAL WAY DOES, OR WHAT IS MISSING. THE COMMAND IS SHOWN WHEN THE USUAL WAY IS A COMMAND -->
		<div class="-mt-2 flex flex-col gap-2 text-xs text-muted" aria-live="polite">
			<p
				class={hasProblem ? 'text-warning' : ''}
				data-testid={hasProblem ? 'continue-problem' : undefined}
			>
				{note}
			</p>
			<!-- THE TWO KEYS STAY TOGETHER ON ONE LINE, NEVER SPLIT ACROSS A WRAP -->
			{#if !hasProblem}
				<p class="inline-flex items-center gap-1.5 whitespace-nowrap">
					Shortcut
					<kbd class="rounded-[6px] border border-line bg-raised px-1.5 py-0.5 font-mono text-xs"
						>Ctrl</kbd
					>
					+
					<kbd class="rounded-[6px] border border-line bg-raised px-1.5 py-0.5 font-mono text-xs"
						>Enter</kbd
					>
				</p>
			{/if}
			{#if usual === 'command' && command}
				<code
					class="rounded-lg border border-line bg-raised px-3 py-2 font-mono text-xs break-words text-ink"
					data-testid="continue-command">{command}</code
				>
			{/if}
		</div>
		<!-- TOOL PICKER, ALL FOUR CHOICES VISIBLE AT ONCE -->
		<div class="flex flex-col gap-1.5">
			<div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
				<span class="text-xs font-medium text-ink">Which tool are you using?</span>
				<a class="text-xs text-accent-text hover:underline" href="/connect">Connect a tool</a>
			</div>
			<SegmentedControl
				label="Which tool are you using?"
				options={TOOL_OPTIONS}
				value={chosenTool}
				onchange={(v) => (chosenTool = v as ContinueToolId)}
				class="w-full"
			/>
		</div>
	</div>
	{#snippet footer()}
		<div class="flex w-full flex-wrap items-center gap-2">
			{#each ways as m, i (m)}
				{@const Icon = ICON[m]}
				{@const why = problemOf(m)}
				<Button
					variant={i === 0 ? 'primary' : 'secondary'}
					loading={running === m}
					disabled={!!why || (running !== null && running !== m)}
					title={why || WAY_HINT[m]}
					onclick={() => run(m)}
				>
					<Icon size={16} aria-hidden="true" />
					{CONTINUE_MODE_LABEL[m]}
				</Button>
			{/each}
		</div>
	{/snippet}
</ResponsiveModal>

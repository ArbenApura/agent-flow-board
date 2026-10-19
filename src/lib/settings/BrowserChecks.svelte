<script lang="ts">
	// -- ENVS -- //
	import { invalidate } from '$app/navigation';
	import { page } from '$app/state';
	// -- MODULES -- //
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import Section from '#lib/settings/Section.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Select from '#lib/ui/Select.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';
	// -- DEP-COMPONENTS -- //
	import MonitorCheck from '@lucide/svelte/icons/monitor-check';

	// -- REQUIRED PROPS -- //

	let {
		org,
		projectKey,
		webApp,
		defaultTarget,
		tools,
		can
	}: {
		org: string;
		projectKey: string;
		webApp: boolean;
		defaultTarget: string;
		/** The afb-checks tools that serve this project, with whether each answered lately. */
		tools: { id: string; name: string; online: boolean; lastSeenAt: string | null }[];
		can: boolean;
	} = $props();

	// -- CONSTANTS -- //

	const TARGETS = [
		{
			value: 'preview',
			label: 'Build preview',
			hint: 'Built from your working tree. The usual choice.'
		},
		{ value: 'deployed', label: 'Deployed site' },
		{ value: 'dev', label: 'Dev server', hint: 'Slow. Pick it by hand only.' }
	];

	// -- STATES -- //

	let target = $derived(defaultTarget);
	let status = $state({ saving: false, saved: false, error: '' });

	// -- REACTIVE STATES -- //

	const online = $derived(tools.find((t) => t.online) ?? null);
	const lastTool = $derived(tools[0] ?? null);

	// -- FUNCTIONS -- //

	async function saveTarget() {
		status = { saving: true, saved: false, error: '' };
		try {
			// The toast wraps the raw write, so a refusal rejects it and no success toast shows
			await toast.promise(
				api(org, `/projects/${projectKey}`, {
					method: 'PATCH',
					body: { defaultTarget: target },
					key: newKey()
				}),
				{
					id: 'checks-target',
					loading: 'Saving...',
					success: 'Default target saved.',
					error: (e) => (e instanceof ApiError ? e.message : 'That was not saved.')
				}
			);
			await invalidate('afb:settings');
			status = { saving: false, saved: true, error: '' };
		} catch (e) {
			status = {
				saving: false,
				saved: false,
				error: e instanceof ApiError ? e.message : 'That was not saved.'
			};
		}
	}
</script>

{#if !webApp}
	<div
		class="rounded-xl border border-line bg-surface p-4 text-sm text-muted shadow-[var(--elev-1)]"
		data-testid="not-web-app"
	>
		Browser checks and UI shots are for web apps. Turn on "This project is a web app" in General
		first.
	</div>
{:else}
	<Section
		id="checks-target"
		icon={MonitorCheck}
		title="Browser checks"
		text="Where a check runs when nobody picks a target, and whether the afb-checks tool is connected."
		dirty={target !== defaultTarget}
		saving={status.saving}
		saved={status.saved}
		error={status.error}
		readonly={!can}
		onsave={saveTarget}
	>
		<Select
			label="Default target"
			options={TARGETS}
			bind:value={target}
			disabled={!can}
			class="w-56"
		/>
		<!-- THE AFB-CHECKS TOOL: WHETHER IT IS CONNECTED, IN WORDS A PERSON CAN ACT ON -->
		<div class="flex flex-col gap-1.5 rounded-lg border border-line p-3" data-testid="tool-status">
			<div class="flex flex-wrap items-center gap-2">
				<span class="text-sm font-medium">afb-checks tool</span>
				{#if online}
					<Badge tone="success">Connected</Badge>
					<span class="text-xs text-muted">{online.name} answered lately.</span>
				{:else if lastTool}
					<Badge tone="warning">Not running</Badge>
					<span class="text-xs text-muted"
						>{lastTool.name} last answered {lastTool.lastSeenAt
							? new Date(lastTool.lastSeenAt).toLocaleString()
							: 'never'}.</span
					>
				{:else}
					<Badge>Not connected</Badge>
				{/if}
			</div>
			<p class="text-sm text-muted">
				{#if online}
					A Run check on an item is taken by the tool on your machine, which runs the matching file
					in its checks folder.
				{:else if lastTool}
					Start it in its folder with
					<span class="font-mono text-xs">node afb-checks.mjs work</span>.
				{:else}
					Connect it once in its folder with
					<span class="font-mono text-xs break-all"
						>node afb-checks.mjs connect --server {page.url.origin} --org {org}</span
					>.
				{/if}
			</p>
		</div>
	</Section>
{/if}

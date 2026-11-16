<script lang="ts">
	// IMPORTED TYPES
	import type { Role } from '#lib/shared/roles.js';
	import type { MemberView, ProjectRoleView, ProjectView } from './memberModel.js';
	import type { SelectOption } from '#lib/ui/Select.svelte';
	// IMPORTED CONSTANTS
	import { projectsOf } from './memberModel.js';
	import { ROLE_LABEL, canAssignRole } from '#lib/shared/roles.js';
	// IMPORTED MODULES
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	// IMPORTED DEP-COMPONENTS
	import Info from '@lucide/svelte/icons/info';
	// IMPORTED COMPONENTS
	import Avatar from '#lib/ui/Avatar.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import ProjectTile from '#lib/board/ProjectTile.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import Select from '#lib/ui/Select.svelte';

	// -- REQUIRED PROPS -- //

	let {
		open,
		onclose,
		org,
		person,
		projects,
		overrides,
		viewerRole,
		onchanged
	}: {
		open: boolean;
		onclose: () => void;
		org: string;
		/** Kept by the caller while the drawer closes, so the content does not flash blank. */
		person: MemberView | null;
		projects: ProjectView[];
		overrides: ProjectRoleView[];
		viewerRole: Role;
		/** Runs after a project role was saved, so the page reads the roles again. */
		onchanged: () => void | Promise<void>;
	} = $props();

	// -- STATES -- //

	/** Bumped after a refused change, so a select that moved on screen is drawn again from what is saved. */
	let rev = $state(0);

	// -- REACTIVE STATES -- //

	const fixed = $derived(person?.role === 'owner' || person?.role === 'admin');
	const rows = $derived(person ? projectsOf(person, projects, overrides) : []);
	const first = $derived(person?.name.split(' ')[0] ?? '');
	// Only roles this person may give are offered
	const roleOptions = $derived(
		(['viewer', 'member', 'admin'] as Role[])
			.filter((r) => canAssignRole(viewerRole, null, r))
			.map((r) => ({ value: r, label: ROLE_LABEL[r] }))
	);

	// -- FUNCTIONS -- //

	function optionsFor(p: MemberView, current: Role | null): SelectOption[] {
		const none: SelectOption =
			p.role === 'guest'
				? { value: 'none', label: 'No access' }
				: { value: 'none', label: `Inherits (${ROLE_LABEL[p.role]})` };
		// A role already saved here that this person may not give still shows, so the select never reads blank
		const kept: SelectOption[] =
			current && !roleOptions.some((o) => o.value === current)
				? [{ value: current, label: ROLE_LABEL[current], disabled: true }]
				: [];
		return [none, ...kept, ...roleOptions];
	}

	async function change(project: ProjectView, value: string) {
		if (!person) return;
		const role = value === 'none' ? null : value;
		try {
			await toast.promise(
				api(org, `/projects/${project.key}/members/${person.userId}`, {
					method: 'PUT',
					body: { role },
					key: newKey()
				}),
				{
					loading: 'Working on it...',
					success: 'Project role saved.',
					error: (e) => (e instanceof ApiError ? e.message : 'That did not work.')
				}
			);
			await onchanged();
		} catch {
			// The toast already says why. The select is drawn again from what is saved
			rev++;
		}
	}

	/** The line under a project: the role they work in there, and whether it differs from their organisation role. */
	function sub(row: ReturnType<typeof projectsOf>[number]): string {
		if (!row.effective) return 'Cannot open this project';
		const name = ROLE_LABEL[row.effective].toLowerCase();
		return row.override ? `Works as ${name} here only` : `Works as ${name}`;
	}
</script>

<!-- PROJECT ACCESS: THE ROLE OF ONE PERSON IN EACH PROJECT. OWNERS AND ADMINS ARE FIXED, EVERYONE ELSE INHERITS UNLESS SET HERE -->
<ResponsiveModal {open} {onclose} title="Project access" variant="drawer">
	{#if person}
		<div class="flex flex-col gap-4">
			<div class="flex items-center gap-3 rounded-lg border border-line bg-raised px-3 py-2.5">
				<Avatar name={person.name} userId={person.userId} v={person.imageV} size={40} />
				<div class="min-w-0 flex-1">
					<span class="block truncate font-medium text-ink">{person.name}</span>
					<span class="block truncate text-xs text-muted">{person.email}</span>
				</div>
				<Badge tone={person.role === 'owner' ? 'accent' : 'neutral'}
					>{ROLE_LABEL[person.role]}</Badge
				>
			</div>
			{#if fixed}
				<p class="flex items-start gap-2 rounded-lg bg-info-soft px-3 py-2.5 text-xs text-info">
					<Info size={16} class="mt-0.5 shrink-0" />
					<span>
						{ROLE_LABEL[person.role]}s are {ROLE_LABEL[person.role].toLowerCase()} in every project. A
						project cannot lower that.
					</span>
				</p>
			{:else if person.role === 'guest'}
				<p class="text-muted">A guest sees only the projects you give them a role in.</p>
			{:else}
				<p class="text-muted">
					{first} works as a {ROLE_LABEL[person.role].toLowerCase()} in every project. Set a different
					role only where it should differ.
				</p>
			{/if}
			{#key rev}
				<ul class="overflow-hidden rounded-lg border border-line">
					{#each rows as row (row.project.id)}
						<li
							data-item
							class="flex min-h-12 flex-wrap items-center gap-3 border-b border-line px-3 py-2.5 last:border-b-0"
						>
							<span class="inline-flex shrink-0 items-center">
								<ProjectTile
									id={row.project.id}
									projectKey={row.project.key}
									logoV={row.project.logoV}
								/>
							</span>
							<div class="min-w-40 flex-1 text-sm">
								<span class="block truncate font-medium text-ink">{row.project.name}</span>
								<span class="block truncate text-xs text-muted">
									{fixed ? `Works as ${ROLE_LABEL[person.role].toLowerCase()}` : sub(row)}
								</span>
							</div>
							<div class="flex shrink-0 items-center gap-2">
								{#if fixed}
									<span class="text-xs text-muted">{ROLE_LABEL[person.role]}</span>
								{:else}
									<Select
										label={`Role of ${person.name} in ${row.project.name}`}
										value={row.override ?? 'none'}
										options={optionsFor(person, row.override)}
										onchange={(v) => change(row.project, v)}
										class="w-48"
									/>
								{/if}
							</div>
						</li>
					{/each}
				</ul>
			{/key}
		</div>
	{/if}
	{#snippet footer()}
		<span class="mr-auto text-xs text-muted">Changes apply at once.</span>
		<Button variant="primary" onclick={onclose}>Done</Button>
	{/snippet}
</ResponsiveModal>

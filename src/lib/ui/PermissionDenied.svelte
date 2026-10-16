<script lang="ts">
	// -- DEP-COMPONENTS -- //
	import Lock from 'phosphor-svelte/lib/Lock';

	// -- REQUIRED PROPS -- //

	let {
		needed,
		current,
		what = 'this page'
	}: {
		/** The role that may see it, for example Admin. */
		needed: string;
		/** The role the person has now. */
		current: string;
		what?: string;
	} = $props();
</script>

<div class="flex flex-col items-center gap-2 px-4 py-10 text-center" role="alert">
	<Lock size={24} class="text-muted" />
	<h2 class="text-base leading-6 font-semibold text-ink sm:text-lg sm:leading-[26px]">
		You cannot open {what}
	</h2>
	<p class="max-w-[48ch] text-sm text-muted">
		It needs the {needed} role and you are {current}. Ask an Owner of this organisation to change
		your role.
	</p>
</div>

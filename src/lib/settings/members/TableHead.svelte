<script lang="ts">
	// IMPORTED CONSTANTS
	import { TABLE_GRID } from './memberModel.js';
	// IMPORTED MODULES
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let { person, role, access }: { person: string; role: string; access: string } = $props();
</script>

<!-- THE HEADER LINE OF A PEOPLE TABLE. FROM MD UP ONLY, A PHONE STACKS EACH ROW AND NEEDS NO COLUMN NAMES -->
<li
	aria-hidden="true"
	class={cn(
		'hidden border-b border-line bg-raised/60 px-3 py-2 text-xs font-medium text-muted md:grid',
		TABLE_GRID
	)}
>
	<span class="pl-11">{person}</span>
	<span class="px-3">{role}</span>
	<span>{access}</span>
	<span></span>
</li>

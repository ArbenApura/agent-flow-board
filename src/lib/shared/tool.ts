// ONE NAME PER AGENT TOOL, SO "Claude Code", "claude_code" AND "claude-code" ARE THE SAME TAB ON THE BOARD

// -- FUNCTIONS -- //

/** Lower case, spaces and underscores as dashes: the family a session of one tool always belongs to. */
export const canonicalTool = (name: string) =>
	name
		.trim()
		.toLowerCase()
		.replace(/[\s_]+/g, '-');

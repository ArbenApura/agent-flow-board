// DRAWING: ONE LINE FOR THE ITEM THIS CONVERSATION IS WORKING ON, WITH OPTIONAL DETAILS. THE SAME TREE FOR THE BAND AND THE PANE.
// Every text from the board is plain Text, never Markdown, so a guest cannot shape the line. The line is quiet on purpose: the
// text colour for what matters (name, reference, title, percent), dim for the rest, and one theme colour only for the status.

import type { EngineInterface, RenderInput, RenderNode } from 'claude-code';

import type { View } from '../types';
import { lineOf } from './status';

// -- CONSTANTS -- //

/** The only colour on the line: one theme colour per board status. An unknown status keeps the plain text colour. */
const STATUS_COLOUR: Record<string, string> = {
	PLANNED: 'subtle',
	'IN PROGRESS': 'suggestion',
	'IN REVIEW': 'permission',
	'ON HOLD': 'warning',
	COMPLETED: 'success',
	REMOVED: 'inactive'
};

// -- FUNCTIONS -- //

export function drawLine(
	$: EngineInterface,
	e: RenderInput,
	view: View,
	now: number,
	options: { hasDetails: boolean; onToggle: () => unknown }
) {
	const { Box, Button, Link, Text } = $.ui.resolve(e);
	const line = lineOf(view, now);
	const tagColor = line.tone === 'error' ? 'error' : line.tone === 'stale' ? 'warning' : 'subtle';
	const item = line.item;

	// Each part of the line, then a dim dot between them. The children are lists, because a tree takes elements and strings only.
	const parts: RenderNode[] = [];
	let titleAt = -1;
	if (line.tag)
		parts.push(
			<Text color={tagColor} weight="bold">
				{line.tag}
			</Text>
		);
	if (item) {
		// The plan's short name leads, so the conversation is named even when the VS Code tab ignores its title
		if (item.tabName)
			parts.push(
				<Text mono weight="bold">
					{item.tabName}
				</Text>
			);
		parts.push(item.url ? <Link href={item.url} label={item.ref} /> : <Text mono>{item.ref}</Text>);
		// The title is the one part that gives way: in the band it shrinks and ends with an ellipsis when the row is short of room
		titleAt = parts.length;
		parts.push(<Text wrap={options.hasDetails ? 'wrap' : 'truncate-end'}>{item.title}</Text>);
		if (item.phase)
			parts.push(<Text dimColor>{`Phase ${item.phase.position} of ${item.phase.of}`}</Text>);
		parts.push(
			<Text mono tabular weight="bold">
				{`${item.percent}%`}
			</Text>
		);
		parts.push(
			<Text color={STATUS_COLOUR[item.status]} weight="bold">
				{item.status}
			</Text>
		);
	} else {
		parts.push(
			<Text color={line.tone === 'info' ? 'subtle' : undefined}>{line.message ?? ''}</Text>
		);
	}
	if (item && options.hasDetails)
		parts.push(
			<Button key="details" plain onPress={options.onToggle}>
				{view.isExpanded ? 'Hide details' : 'Details'}
			</Button>
		);

	// The band is one row that does not wrap: every part keeps its size (flexShrink 0) and only the title shrinks. A wrapping row never
	// shrinks an item, it moves the last part to a second line instead. The pane has room, so its row wraps and shows the whole title.
	const isBand = !options.hasDetails;
	const top: RenderNode[] = [];
	parts.forEach((part, i) => {
		if (i > 0 && item)
			top.push(
				isBand ? (
					<Box flexShrink={0}>
						<Text dimColor>·</Text>
					</Box>
				) : (
					<Text dimColor>·</Text>
				)
			);
		if (!isBand) top.push(part);
		else if (i === titleAt)
			top.push(
				<Box flexShrink={1} minWidth={0}>
					{part}
				</Box>
			);
		else top.push(<Box flexShrink={0}>{part}</Box>);
	});

	const rows: RenderNode[] = [
		// 'xs' is one cell across and none down on VS Code and the terminal: a number would also leave a blank line between rows
		<Box flexDirection="row" flexWrap={isBand ? 'nowrap' : 'wrap'} gap="xs">
			{top}
		</Box>
	];
	if (item && options.hasDetails && view.isExpanded) {
		const hasBlockers = !!item.blockers && item.blockers !== 'None.';
		rows.push(
			<Text>
				<Text dimColor>{'Resume here  '}</Text>
				{item.resumeHere || 'nothing written'}
			</Text>
		);
		rows.push(
			<Text>
				<Text dimColor>{'Blockers  '}</Text>
				<Text color={hasBlockers ? 'warning' : undefined}>{item.blockers || 'none written'}</Text>
			</Text>
		);
		rows.push(
			<Text>
				<Text dimColor>{'Steps  '}</Text>
				{`${item.steps.done} done, ${item.steps.open} open`}
				<Text dimColor>{`, ${item.steps.waived} waived`}</Text>
			</Text>
		);
	}
	return <Box flexDirection="column">{rows}</Box>;
}

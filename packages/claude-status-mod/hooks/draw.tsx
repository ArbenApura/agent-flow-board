// DRAWING: ONE LINE FOR THE ITEM THIS CONVERSATION IS WORKING ON, WITH OPTIONAL DETAILS. THE SAME TREE FOR THE BAND, THE PANE
// AND THE ROW IN THE TRANSCRIPT. Every text from the board is plain Text, never Markdown, so a guest cannot shape the line.

import type { EngineInterface, RenderInput, RenderNode } from 'claude-code';

import type { View } from '../types';
import { lineOf } from './status';

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

	// The children are built as lists, because a tree takes elements and strings only
	const top: RenderNode[] = [];
	if (line.tag)
		top.push(
			<Text color={tagColor} weight="bold">
				{line.tag}
			</Text>
		);
	if (item) {
		if (item.tabName)
			top.push(
				<Text mono weight="bold">
					{item.tabName}
				</Text>
			);
		top.push(item.url ? <Link href={item.url} label={item.ref} /> : <Text mono>{item.ref}</Text>);
		top.push(<Text>{item.title}</Text>);
		if (item.phase)
			top.push(<Text dimColor>{`Phase ${item.phase.position} of ${item.phase.of}`}</Text>);
		top.push(
			<Text mono tabular>
				{`${item.percent}%`}
			</Text>
		);
		top.push(
			<Text dimColor weight="bold">
				{item.status}
			</Text>
		);
		if (options.hasDetails)
			top.push(
				<Button key="details" plain onPress={options.onToggle}>
					{view.isExpanded ? 'Hide details' : 'Details'}
				</Button>
			);
	} else {
		top.push(<Text color={line.tone === 'info' ? 'subtle' : undefined}>{line.message ?? ''}</Text>);
	}

	const rows: RenderNode[] = [
		<Box flexDirection="row" flexWrap="wrap" gap={1}>
			{top}
		</Box>
	];
	if (item && options.hasDetails && view.isExpanded) {
		rows.push(<Text dimColor>{`Resume here: ${item.resumeHere || 'nothing written'}`}</Text>);
		rows.push(<Text dimColor>{`Blockers: ${item.blockers || 'none written'}`}</Text>);
		rows.push(
			<Text
				dimColor
			>{`Steps: ${item.steps.done} done, ${item.steps.open} open, ${item.steps.waived} waived`}</Text>
		);
	}
	return <Box flexDirection="column">{rows}</Box>;
}

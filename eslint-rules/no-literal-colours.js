// REFUSES LITERAL COLOUR VALUES IN COMPONENTS: COLOURS COME FROM TOKENS (--surface, --ink, --accent ...)
const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z_-])/g;
const FUNC = /\b(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|hwb)\(/g;
const NAMED =
	/(?:^|[\s"'`:[])(?:bg|text|border|ring|fill|stroke|from|to|via|outline|divide|shadow|accent|caret|decoration)-(?:white|black)(?![\w-])/g;

/** @type {import('eslint').Rule.RuleModule} */
export default {
	meta: {
		type: 'problem',
		schema: [],
		messages: {
			literal:
				'Literal colour "{{value}}". Use a token such as var(--surface), var(--ink) or var(--accent).'
		}
	},
	create(context) {
		return {
			Program() {
				const source = context.sourceCode;
				const text = source.getText();
				const lines = text.split('\n');
				// A COLOUR IN A STRING THAT SITS ON AN eslint-disable LINE IS LEFT ALONE BY ESLINT ITSELF
				lines.forEach((line, i) => {
					for (const re of [HEX, FUNC, NAMED]) {
						re.lastIndex = 0;
						let m;
						while ((m = re.exec(line))) {
							context.report({
								loc: { line: i + 1, column: m.index },
								messageId: 'literal',
								data: { value: m[0].trim() }
							});
						}
					}
				});
			}
		};
	}
};

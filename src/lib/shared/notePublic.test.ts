import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../markdown';
import { PUBLIC_LINK_BASE, publicNoteHtml } from './notePublic';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';
const FILE = '0a1b2c3d-0000-4000-8000-123456789abc';
const render = (text: string) =>
	publicNoteHtml(
		renderMarkdown(text, { untrusted: true, mode: 'note', linkBase: PUBLIC_LINK_BASE }),
		TOKEN
	);

describe('the read view of a public note', () => {
	it('reads a picture under the address, never through the board', () => {
		const html = render(`![chart](afb:file/${FILE})`);
		expect(html).toContain(`src="/n/${TOKEN}/file/${FILE}"`);
		expect(html).not.toContain('/api/v1');
	});

	it('keeps the words of a link into the board but drops the link', () => {
		const html = render('See N-12, [the plan](afb:item/AFB-20261107-0346) and T-4.');
		expect(html).toContain('N-12');
		expect(html).toContain('the plan');
		expect(html).toContain('T-4');
		expect(html).not.toContain('<a ');
		expect(html).not.toContain('/_/_/');
	});

	it('keeps an outside link a reader may follow', () => {
		const html = render('[site](https://example.com)');
		expect(html).toContain('href="https://example.com"');
	});

	it('shows no picture at all under a token that is not an address', () => {
		const raw = renderMarkdown(`![](afb:file/${FILE})`, {
			untrusted: true,
			mode: 'note',
			linkBase: PUBLIC_LINK_BASE
		});
		expect(publicNoteHtml(raw, 'x"><script>')).not.toContain('/n/');
	});
});

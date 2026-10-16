import { describe, expect, it } from 'vitest';
import { renderMarkdown, renderMarkdownCached } from './markdown';

describe('markdown rendering', () => {
	it('shows raw HTML as text and never runs it', () => {
		const html = renderMarkdown(
			'<script>alert(1)</script> and <img src=x onerror=alert(1)> and <b>bold</b>'
		);
		expect(html).not.toContain('<script');
		expect(html).not.toMatch(/<img[^>]*onerror/);
		expect(html).toContain('&lt;script&gt;');
		expect(html).not.toContain('<b>');
	});

	it('removes links with unsafe schemes and keeps safe ones', () => {
		expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('href');
		expect(renderMarkdown('[x](data:text/html;base64,AAAA)')).not.toContain('href');
		expect(renderMarkdown('[x](vbscript:msgbox)')).not.toContain('href');
		expect(renderMarkdown('[ok](https://example.com/a)')).toContain('href="https://example.com/a"');
		expect(renderMarkdown('[ok](/acme/items)')).toContain('href="/acme/items"');
		expect(renderMarkdown('[mail](mailto:a@example.com)')).toContain('mailto:a@example.com');
	});

	it('opens outside links safely', () => {
		const html = renderMarkdown('[ok](https://example.com)');
		expect(html).toContain('target="_blank"');
		expect(html).toContain('rel="noopener noreferrer nofollow"');
	});

	it('allows http images, refuses data and javascript sources, and drops every image from untrusted text', () => {
		expect(renderMarkdown('![shot](https://example.com/a.png)')).toContain(
			'<img src="https://example.com/a.png"'
		);
		expect(renderMarkdown('![x](data:image/svg+xml;base64,AAAA)')).not.toContain('<img');
		expect(renderMarkdown('![x](javascript:alert(1))')).not.toContain('<img');
		const guest = renderMarkdown('![pixel](https://tracker.example/p.gif)', { untrusted: true });
		expect(guest).not.toContain('<img');
		expect(guest).toContain('[image: pixel]');
	});

	it('marks outside links in untrusted text as user generated', () => {
		expect(renderMarkdown('[x](https://example.com)', { untrusted: true })).toContain('ugc');
	});

	it('escapes attribute breaking input', () => {
		const html = renderMarkdown('[a](https://example.com/" onmouseover="alert(1))');
		expect(html).not.toMatch(/onmouseover="alert/);
	});

	it('cuts a huge document and still returns quickly', () => {
		const t = performance.now();
		const html = renderMarkdown('word '.repeat(300_000));
		expect(html).toContain('The rest of this text is not shown');
		expect(performance.now() - t).toBeLessThan(2000);
	});

	it('remembers a rendered document by its content', () => {
		const a = renderMarkdownCached('# Same text');
		expect(renderMarkdownCached('# Same text')).toBe(a);
		expect(renderMarkdownCached('# Same text', { untrusted: true })).toBe(a);
		expect(renderMarkdownCached('# Different text')).not.toBe(a);
	});
});

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

const FILE = '0b9f4c1e-3c52-4a52-9d0b-6f1d2a7e8c11';

describe('markdown board links (a link base)', () => {
	const base = { org: 'acme', project: 'AFB' };

	it('turns afb: links into board addresses and afb:file into the picture route', () => {
		const html = renderMarkdown(
			'[n](afb:note/N-12) [t](afb:task/T-3) [i](afb:item/AFB-20261107-0346) [m](afb:mockup/' +
				FILE +
				') ![p](afb:file/' +
				FILE +
				')',
			{ linkBase: base }
		);
		expect(html).toContain('href="/acme/AFB/notes/N-12"');
		expect(html).toContain('href="/acme/AFB/tasks?task=T-3"');
		expect(html).toContain('href="/acme/AFB/AFB-20261107-0346"');
		expect(html).toContain(`href="/acme/AFB/mockups/${FILE}"`);
		expect(html).toContain(`<img src="/api/v1/orgs/acme/notes/files/${FILE}"`);
	});

	it('leaves afb: text alone when no link base is passed (output unchanged)', () => {
		const html = renderMarkdown('[n](afb:note/N-12) and N-12');
		expect(html).not.toContain('href');
		expect(renderMarkdown('N-12 T-3 AFB-20261107-0346')).toBe(
			'<p>N-12 T-3 AFB-20261107-0346</p>\n'
		);
		expect(renderMarkdown('- [ ] a\n- [x] b')).not.toContain('<input');
	});

	it('refuses hostile afb: forms and other schemes', () => {
		for (const bad of [
			'[x](afb:note/N-12" onmouseover="x)',
			'[x](afb:note/../../admin)',
			'[x](afb:file/not-a-uuid)',
			'[x](afb:evil/N-1)',
			'[x](afb:note/N-0)',
			'[x](javascript:alert(1))',
			'[x](afb:item/a/b)'
		]) {
			const html = renderMarkdown(bad, { linkBase: base });
			expect(html, bad).not.toContain('href');
			expect(html, bad).not.toMatch(/onmouseover="/);
		}
	});

	it('gives the same text two addresses for two organisations or projects', () => {
		const text = 'See N-12 and [t](afb:task/T-1)';
		const a = renderMarkdownCached(text, { linkBase: { org: 'acme', project: 'AFB' } });
		const b = renderMarkdownCached(text, { linkBase: { org: 'other', project: 'ZZ' } });
		expect(a).toContain('/acme/AFB/notes/N-12');
		expect(b).toContain('/other/ZZ/notes/N-12');
		expect(a).not.toBe(b);
		expect(renderMarkdownCached(text, { linkBase: { org: 'acme', project: 'AFB' } })).toBe(a);
	});

	it('in note mode shows pictures only from afb:file and other addresses as a plain link', () => {
		const html = renderMarkdown(
			'![x](https://evil.example/p.png) ![y](/some/relative.png) ![z](afb:file/' + FILE + ')',
			{ linkBase: base, mode: 'note', untrusted: true }
		);
		expect(html.match(/<img/g)?.length).toBe(1);
		expect(html).toContain('href="https://evil.example/p.png"');
		expect(html).not.toContain('src="https://evil.example');
		expect(html).not.toContain('relative.png"');
		// Without a link base an afb:file picture is not an address at all
		expect(renderMarkdown('![z](afb:file/' + FILE + ')', { mode: 'note' })).not.toContain('<img');
	});

	it('renders checklists as disabled tick boxes in note mode only', () => {
		const html = renderMarkdown('- [ ] open\n- [x] done\n- plain', { mode: 'note' });
		expect(html).toContain('<input type="checkbox" disabled> open');
		expect(html).toContain('<input type="checkbox" disabled checked> done');
		expect(html.match(/<input/g)?.length).toBe(2);
		expect(html).not.toContain('<script');
	});
});

describe('bare references', () => {
	const base = { org: 'acme', project: 'AFB' };

	it('links N-12, T-12 and a plan reference as written', () => {
		const html = renderMarkdown('Read N-12, then T-7 and AFB-20261107-0346.', { linkBase: base });
		expect(html).toContain('<a href="/acme/AFB/notes/N-12">N-12</a>,');
		expect(html).toContain('<a href="/acme/AFB/tasks?task=T-7">T-7</a>');
		expect(html).toContain('<a href="/acme/AFB/AFB-20261107-0346">AFB-20261107-0346</a>.');
	});

	it('skips code, existing links and parts of longer words', () => {
		const html = renderMarkdown(
			'`N-12` and [see N-12](https://example.com) and <https://example.com/N-12> and XN-12 and N-12-3 and N-1234567890',
			{ linkBase: base }
		);
		expect(html).toContain('<code>N-12</code>');
		expect(html).toContain('>see N-12</a>');
		expect(html).not.toContain('notes/N-12');
		expect(html).not.toContain('notes/N-1234567890');
		const fence = renderMarkdown('```\nN-12 T-1\n```', { linkBase: base });
		expect(fence).not.toContain('href');
	});

	it('gives two projects the same text with different addresses', () => {
		const a = renderMarkdown('N-5', { linkBase: { org: 'acme', project: 'AFB' } });
		const b = renderMarkdown('N-5', { linkBase: { org: 'acme', project: 'HAPR' } });
		expect(a).toContain('/acme/AFB/notes/N-5');
		expect(b).toContain('/acme/HAPR/notes/N-5');
	});

	it('renders a 200,000 character hostile text within a time bound', () => {
		const shapes = [
			'N-'.repeat(100_000),
			'AFB-20261107-'.repeat(15_000),
			'A-1 '.repeat(50_000),
			'N-1 '.repeat(50_000),
			('X'.repeat(9) + '-').repeat(20_000)
		];
		for (const text of shapes) {
			const t = performance.now();
			renderMarkdown(text.slice(0, 200_000), { linkBase: base, mode: 'note' });
			expect(performance.now() - t).toBeLessThan(3000);
		}
	});
});

// agent-flow-board mockup push --tailwind-entry <css>: COMPILES THE MOCKUP'S OWN UTILITIES WITH THE PROJECT'S INSTALLED TAILWIND
// The project's entry CSS (its theme, tokens and base layer) is the input, the app scan is off, and the only source is the page being
// pushed, so the output is exactly the utilities the page uses, styled the way the app styles them. It runs the Tailwind that is
// installed in the project (never one fetched from the network), writes only to a temporary folder outside the repo, and the result
// is stored as a generated style that nobody has to read.
// -- DEP-MODULES -- //
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
// -- CONSTANTS -- //
/** The marker a page may carry to say where the generated style goes. Without it the style goes just before </head>. */
export const GENERATED_MARKER = '<!--afb-generated-->';
// -- FUNCTIONS -- //
/** The folder that holds the project's installed Tailwind, found by walking up from the entry file. */
export function findTailwindRoot(entry, hint) {
    if (hint) {
        const root = resolve(hint);
        return existsSync(join(root, 'node_modules', 'tailwindcss', 'package.json')) ? root : null;
    }
    let dir = dirname(resolve(entry));
    for (;;) {
        if (existsSync(join(dir, 'node_modules', 'tailwindcss', 'package.json')))
            return dir;
        const up = dirname(dir);
        if (up === dir || parse(dir).root === dir)
            return null;
        dir = up;
    }
}
/** Where a package is, when it is a dependency of Tailwind's own tools and not of the project (pnpm does not hoist it). */
function resolveVia(root, req, name) {
    try {
        return req.resolve(name);
    }
    catch {
        // Fall through to the tools that bring it
    }
    for (const via of [
        '@tailwindcss/vite',
        '@tailwindcss/cli',
        '@tailwindcss/postcss',
        '@tailwindcss/node'
    ]) {
        const dir = join(root, 'node_modules', via);
        if (!existsSync(join(dir, 'package.json')))
            continue;
        try {
            // The real folder of the tool, so a sibling in the same store resolves (a link from a pnpm project points there)
            return createRequire(join(realpathSync(dir), 'package.json')).resolve(name);
        }
        catch {
            // Try the next one
        }
    }
    return null;
}
async function load(root, req, name, missing) {
    const path = resolveVia(root, req, name);
    if (!path)
        throw new Error(missing);
    const mod = (await import(pathToFileURL(path).href));
    return (mod.default && typeof mod.default === 'object' ? { ...mod.default, ...mod } : mod);
}
/**
 * Compiles the utilities a page uses against the project's entry CSS. `root` is where the project's node_modules live (found by
 * walking up from the entry when not given). Only Tailwind 4 is supported; for another tool, build the CSS with the project's own
 * command and pass it with --style-file.
 */
export async function compileTailwind(o) {
    const entry = resolve(o.entry);
    if (!existsSync(entry))
        throw new Error(`The Tailwind entry file ${entry} does not exist.`);
    const root = findTailwindRoot(entry, o.root);
    if (!root)
        throw new Error('No installed Tailwind was found above the entry file. Install the project dependencies first (nothing is fetched from the network by this command), or name the project folder with --project-root.');
    const req = createRequire(join(root, 'package.json'));
    const pkg = JSON.parse(readFileSync(join(root, 'node_modules', 'tailwindcss', 'package.json'), 'utf8'));
    if (!pkg.version.startsWith('4.'))
        throw new Error(`The project has Tailwind ${pkg.version}. This command compiles Tailwind 4 only; build the CSS with the project's own command and pass it with --style-file.`);
    const gone = 'The project has no Tailwind 4 tooling (@tailwindcss/node and @tailwindcss/oxide). They come with @tailwindcss/vite or @tailwindcss/cli; install the project dependencies and run this again.';
    const [node, oxide] = await Promise.all([
        load(root, req, '@tailwindcss/node', gone),
        load(root, req, '@tailwindcss/oxide', gone)
    ]);
    // The page is the only source: it is written to a temporary folder of its own and scanned there
    const dir = mkdtempSync(join(tmpdir(), 'afb-tw-'));
    try {
        writeFileSync(join(dir, 'mockup.html'), o.html, 'utf8');
        const scanner = new oxide.Scanner({
            sources: [{ base: dir, pattern: '**/*', negated: false }]
        });
        const candidates = scanner.scan();
        const compiler = await node.compile(readFileSync(entry, 'utf8') + (o.extraCss ? `\n${o.extraCss}\n` : ''), {
            base: dirname(entry),
            onDependency: () => undefined
        });
        // With @apply rules the page brings its own base, so the app's base layer (label colour, margins...) must not leak in
        const built = compiler.build(candidates);
        const css = pruneKeyframes(o.extraCss ? dropLayer(built, 'base') : built, o.usedIn ?? o.html);
        return { css, version: pkg.version, candidates: candidates.length };
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
/** Removes the blocks of one cascade layer (`@layer base { ... }`), brace aware. The project's own base styles are the app's, not the page's. */
export function dropLayer(css, name) {
    const rx = new RegExp(`@layer\\s+${name}\\s*\\{`, 'g');
    let out = '';
    let at = 0;
    let m;
    while ((m = rx.exec(css)) !== null) {
        let depth = 1;
        let i = m.index + m[0].length;
        while (i < css.length && depth > 0) {
            if (css[i] === '{')
                depth++;
            else if (css[i] === '}')
                depth--;
            i++;
        }
        out += css.slice(at, m.index);
        at = i;
        rx.lastIndex = i;
    }
    return out + css.slice(at);
}
/**
 * Drops the `@keyframes` rules that nothing in the source uses. A project's entry CSS carries the keyframes of the whole app (dozens,
 * most of them for other screens); keeping only the ones the page mentions leaves the motion the page really uses, small enough to
 * be read, and no noise from the rest of the app.
 */
export function pruneKeyframes(css, source) {
    let out = '';
    let at = 0;
    const rx = /@keyframes\s+([A-Za-z0-9_-]+)\s*\{/g;
    let m;
    while ((m = rx.exec(css)) !== null) {
        // The block ends where its braces close
        let depth = 1;
        let i = m.index + m[0].length;
        while (i < css.length && depth > 0) {
            if (css[i] === '{')
                depth++;
            else if (css[i] === '}')
                depth--;
            i++;
        }
        // Kept when the page uses it, unless the page defines a keyframe of that name itself (its own then wins)
        if (source.includes(m[1]) && !new RegExp(`@keyframes\\s+${m[1]}\\b`).test(source))
            continue;
        out += css.slice(at, m.index);
        at = i;
        rx.lastIndex = i;
    }
    return out + css.slice(at);
}
/** Puts a generated style into a page: at its marker, or just before </head>, or at the top. An older generated style is replaced. */
export function injectGeneratedStyle(html, css) {
    const block = `<style data-afb-generated>\n${css.replace(/<\/style/gi, '<\\/style')}\n</style>`;
    const cleaned = html.replace(/<style\b[^>]*\bdata-afb-generated\b[^>]*>[\s\S]*?<\/style>\s*/gi, '');
    if (cleaned.includes(GENERATED_MARKER))
        return cleaned.replace(GENERATED_MARKER, () => block);
    const head = cleaned.search(/<\/head>/i);
    if (head >= 0)
        return `${cleaned.slice(0, head)}${block}\n${cleaned.slice(head)}`;
    return `${block}\n${cleaned}`;
}

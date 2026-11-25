# Wireframe starter

The starter page for the `wireframe` tier of `flow-mockup`. Copy the fenced block into a file in a temporary folder of your tool (never the repo) and replace every placeholder. A wireframe shows structure, order, text, states and interactions in plain grey boxes; colours, spacing, sizes, type, icons and components are free, so do not copy the app's markup or classes.

What the starter gives you:

- **no kit marker.** The page carries its own small stylesheet with grey tokens for light and dark, keyed on the root `data-mode` the board writes. Keep them: without a kit nothing else defines a mode, and a mode switch that changes nothing is a defect.
- an `afb-config` tag with `"fidelity":"wireframe"` and a mode option. Delete what the app does not have (an app with one colour mode declares no mode; a page with one screen declares no screens). Add `"screens":[["key","Label"]]` when the page has several, and list real states in `data-state`.
- screens as `<section data-screen-view="key">` blocks. The root carries `data-screen="key"` (the board and the URL hooks write it) and only the matching section shows. A state is an element with `data-state-view="empty"`, shown when the root carries `data-state="empty"`. Every declared screen, state and option must visibly change the page.
- boxes for blocks (`.box`), a placeholder for an image or an icon (`.ph`), a primary action (`.btn.primary`), plain rows (`.row`). Use the product's real wording and realistic sample rows. No emoji, no lorem ipsum, no real person's data.

Rules: nothing loads from a network address, no web font, no icon font and no drawn copy of the app's icons (a `.ph` box holding the icon's name is enough). The page draws no device frame and no switch of its own. Give every region a stable `data-ref="<name>"`.

To look at the page, open the file in the harness browser at 1280 and 408 wide, in each mode (`#screen=<key>&state=<value>` and `data-mode` on the root). Take one PNG of the first screen at 1280 for the card, then publish with `agent-flow-board mockup push <file.html> --item <reference> --screenshot <file.png> --renders --widths 408,1280`.

```html
<!doctype html>
<html lang="en" data-mode="light" data-screen="PLACEHOLDER-first-screen-key">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PLACEHOLDER: the screen this wireframe shows</title>
<meta name="afb-config" content='{"fidelity":"wireframe","screens":[["PLACEHOLDER-first-screen-key","PLACEHOLDER: first screen"]],"options":[{"key":"mode","label":"Mode","values":[["light","Light"],["dark","Dark"]]}]}'>
<style>
:root { --bg:#f4f4f5; --box:#ffffff; --line:#c9c9cf; --ink:#27272a; --ink-2:#6b6b73; --fill:#e4e4e7; --primary:#3f3f46; --primary-ink:#ffffff; font-family: system-ui, sans-serif; }
:root[data-mode="dark"] { --bg:#18181b; --box:#232326; --line:#3f3f46; --ink:#f4f4f5; --ink-2:#a1a1aa; --fill:#2f2f33; --primary:#e4e4e7; --primary-ink:#18181b; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font-size:15px; line-height:1.45; }
.page { display:flex; flex-direction:column; gap:16px; max-width:1100px; margin:0 auto; padding:24px 16px 48px; }
h1 { margin:0; font-size:22px; } h2 { margin:0; font-size:17px; } p { margin:0; color:var(--ink-2); }
.box { display:flex; flex-direction:column; gap:10px; padding:16px; background:var(--box); border:1px solid var(--line); border-radius:8px; }
.row { display:flex; align-items:center; gap:12px; min-height:44px; border-bottom:1px solid var(--line); }
.row:last-child { border-bottom:0; }
.row > .grow { flex:1; min-width:0; }
.ph { display:flex; align-items:center; justify-content:center; min-height:44px; padding:0 12px; background:var(--fill); border:1px dashed var(--line); border-radius:6px; color:var(--ink-2); font-size:13px; }
.btn { min-height:44px; padding:0 16px; background:var(--box); color:var(--ink); border:1px solid var(--line); border-radius:6px; font:inherit; cursor:pointer; }
.btn.primary { background:var(--primary); color:var(--primary-ink); border-color:var(--primary); }
[data-screen-view] { display:none; flex-direction:column; gap:16px; }
:root[data-screen="PLACEHOLDER-first-screen-key"] [data-screen-view="PLACEHOLDER-first-screen-key"] { display:flex; }
[data-state-view] { display:none; }
:root[data-state="empty"] [data-state-view="empty"] { display:flex; }
:root[data-state="empty"] [data-state-hide="empty"] { display:none; }
@media (min-width: 820px) { .cols { display:grid; grid-template-columns: 240px 1fr; gap:16px; } }
@media (prefers-reduced-motion: no-preference) { .btn { transition: background-color 150ms ease-out; } }
</style>
</head>
<body>
<div class="page">
	<section data-screen-view="PLACEHOLDER-first-screen-key" data-ref="PLACEHOLDER-first-screen-key">
		<div>
			<h1>PLACEHOLDER: the page title</h1>
			<p>PLACEHOLDER: one line saying what the page is.</p>
		</div>
		<div class="cols">
			<div class="box" data-ref="side"><div class="ph">PLACEHOLDER: filters or navigation</div></div>
			<div class="box" data-ref="list" data-state-hide="empty">
				<h2>PLACEHOLDER: a section</h2>
				<div class="row"><span class="grow">PLACEHOLDER: a realistic row title</span><span class="ph">Status</span></div>
				<div class="row"><span class="grow">PLACEHOLDER: another realistic row</span><span class="ph">Status</span></div>
			</div>
			<div class="box" data-ref="empty" data-state-view="empty"><p>PLACEHOLDER: the empty state, in the product's voice</p></div>
		</div>
		<div><button class="btn primary" type="button">PLACEHOLDER: the one primary action</button></div>
	</section>
</div>
<script>
// The board writes each choice as data-<key> on the root (data-mode, data-screen, data-state) and by URL hook (?screen=&state= or #screen=&state=).
// Several screens: add one [data-screen-view="key"] rule per screen in the style above. A hook the page reads some other way: define window.afbSet.
// window.afbSet = function (key, value) { document.documentElement.setAttribute('data-' + key, value); };
</script>
</body>
</html>
```

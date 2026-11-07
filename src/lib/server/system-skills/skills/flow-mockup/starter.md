# Mockup starter

The starter page for `flow-mockup`. Copy the fenced block into a file in a temporary folder of your tool (never the repo), then replace every placeholder with what the project kit holds: the markup of its shell and components. Keep the file one page of about 10 KB with its CSS and script inline, and keep it free of anything that loads from a network address.

What the starter gives you:

- **the kit marker** `<!--afb-kit-->` in the head. The board puts the kit's head there when it serves the page: the colour tokens of every mode, the embedded font files and the icon sprite. The page therefore embeds no font and no icon itself, and uses only the kit's tokens (`var(--bg)` and the others), the kit's font families (`var(--font-sans)`, `var(--font-mono)`, or the project's own names) and the kit's icons (`<svg class="ic"><use href="#i-name"/></svg>`, where `i-name` is a symbol id of the kit's sprite);
- a shell (side navigation, top bar, page header, one card) that folds to a single column on a narrow width, so the board's device switch (wide, laptop, tablet and phone) shows each layout. The board draws the device around it, so the page never draws a browser window or a phone;
- a theme switch inside the page that flips the same attribute the kit uses, so both modes can be looked at;
- states to copy: a row list, an empty state and a message line.

To look at the page yourself, make a temporary copy in which the marker is replaced by the text between the kit's `<!--afb-kit:start-->` and `<!--afb-kit:end-->`. Publish the file with the marker.

**A project with no kit yet.** Build the kit first (the skill, section 2). Do not paste colours, fonts or icons into the page to get by: no emoji, no icon font, no font or image loaded by address and no drawn lookalike.

Delete what the plan does not need, and add the states the plan names.

```html
<!doctype html>
<html lang="en" data-mode="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PLACEHOLDER: the screen this mockup shows</title>
<!--afb-kit-->
<style>
/* EVERY COLOUR, FONT AND ICON COMES FROM THE KIT. NO LITERAL COLOUR AND NO FONT NAME OF YOUR OWN HERE */
* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: var(--bg); color: var(--ink); font: 15px/24px var(--font-sans); }
button { font: inherit; color: inherit; cursor: pointer; }
.ic { width: 18px; height: 18px; flex: none; }
.shell { display: grid; grid-template-columns: 240px minmax(0, 1fr); min-height: 100vh; }
.side { background: var(--surface); border-right: 1px solid var(--line); padding: 16px; display: flex; flex-direction: column; gap: 4px; }
.brand { font-weight: 700; padding: 8px; }
.nav { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: 8px; color: var(--muted); text-decoration: none; }
.nav[aria-current="page"] { background: var(--accent-soft); color: var(--accent-text); font-weight: 600; }
.main { min-width: 0; display: flex; flex-direction: column; }
.bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 32px; border-bottom: 1px solid var(--line); background: var(--surface); }
.btn { display: inline-flex; align-items: center; gap: 8px; height: 40px; padding: 0 16px; border-radius: 8px; border: 1px solid var(--line); background: var(--surface); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.page { padding: 24px 32px 48px; display: flex; flex-direction: column; gap: 16px; max-width: 1200px; width: 100%; }
.head h1 { margin: 0; font-size: 28px; line-height: 36px; }
.head p { margin: 4px 0 0; color: var(--muted); }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 16px; }
.card h2 { margin: 0 0 8px; font-size: 18px; line-height: 28px; }
.row { display: flex; align-items: center; gap: 12px; min-height: 48px; border-bottom: 1px solid var(--line); }
.row:last-child { border-bottom: 0; }
.row .id { font: 13px var(--font-mono); color: var(--muted); width: 120px; }
.row .title { flex: 1; min-width: 0; }
.badge { font-size: 12px; font-weight: 600; padding: 2px 10px; border-radius: 999px; background: var(--accent-soft); color: var(--accent-text); }
.empty { text-align: center; color: var(--muted); padding: 32px 0; }
.note { background: var(--raised); border-radius: 8px; padding: 12px; color: var(--muted); font-size: 13px; line-height: 18px; }
@media (max-width: 900px) {
	.shell { grid-template-columns: minmax(0, 1fr); }
	.side { flex-direction: row; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--line); }
	.bar, .page { padding-left: 16px; padding-right: 16px; }
	.head h1 { font-size: 22px; line-height: 30px; }
	.row .id { display: none; }
	.btn { height: 44px; }
}
</style>
</head>
<body>
<div class="shell">
	<nav class="side" aria-label="Main">
		<div class="brand">PLACEHOLDER: the logo lockup from the kit</div>
		<a class="nav" href="#" aria-current="page"><svg class="ic"><use href="#i-PLACEHOLDER-icon"/></svg>PLACEHOLDER: this page</a>
		<a class="nav" href="#"><svg class="ic"><use href="#i-PLACEHOLDER-icon"/></svg>PLACEHOLDER: another page</a>
	</nav>
	<div class="main">
		<header class="bar">
			<span>PLACEHOLDER: breadcrumb</span>
			<button class="btn" type="button" id="mode" aria-label="Switch between light and dark"><svg class="ic"><use href="#i-PLACEHOLDER-mode-icon"/></svg></button>
		</header>
		<main class="page">
			<div class="head">
				<h1>PLACEHOLDER: the page title</h1>
				<p>PLACEHOLDER: one line saying what the page is.</p>
			</div>
			<section class="card">
				<h2>PLACEHOLDER: a section</h2>
				<div class="row"><span class="id">ID-0001</span><span class="title">PLACEHOLDER: a realistic row title</span><span class="badge">Status</span></div>
				<div class="row"><span class="id">ID-0002</span><span class="title">PLACEHOLDER: another realistic row</span><span class="badge">Status</span></div>
			</section>
			<section class="card">
				<div class="empty">PLACEHOLDER: the empty state of this list, in the product's voice</div>
			</section>
			<p class="note">PLACEHOLDER: a message line for an error or a hint.</p>
			<div><button class="btn primary" type="button">PLACEHOLDER: the one primary action</button></div>
		</main>
	</div>
</div>
<script>
// The attribute and its two values are the kit's: change them here if the kit names its modes differently
document.getElementById('mode').addEventListener('click', function () {
	var root = document.documentElement;
	root.setAttribute('data-mode', root.getAttribute('data-mode') === 'dark' ? 'light' : 'dark');
});
</script>
</body>
</html>
```

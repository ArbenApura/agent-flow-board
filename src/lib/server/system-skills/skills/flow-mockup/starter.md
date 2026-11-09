# Mockup starter

The starter page for `flow-mockup`. Copy the fenced block into a file in a temporary folder of your tool (never the repo), then replace every placeholder with the project's real markup: copy the shell and the components from the project's own templates, with their real class names. The classes below are only a shape to show where things go (example: utility classes from a Tailwind project; a Bootstrap or Sass project uses its own).

What the starter gives you:

- **the kit marker** `<!--afb-kit-->` in the head. The board puts the kit's head there when it serves the page: the project's built stylesheet and its embedded fonts. The page carries no stylesheet, font or icon of its own, so it stays small whatever its detail.
- a shell (side navigation, top bar, page header, a card with rows, an empty state and a message line) that folds to one column on a narrow width, so the board's device switch shows each layout. The board draws the device frame; the page never draws a browser window or a phone.
- a `<meta name="afb-config">` tag with a mode option as an example (delete what the app does not have: an app with one colour mode declares no mode, and a page with one screen declares no screens). The page draws no switch of its own.
- a place for the classes the kit lacks (section 3 of the skill): a `<style>` after the marker, in the same layer as the kit.

To look at the page yourself, make a temporary copy in which the marker is replaced by the text between the kit's `<!--afb-kit:start-->` and `<!--afb-kit:end-->`. Publish the file with the marker.

**A project with no kit yet.** Build the kit first (the skill, section 2). Do not paste colours, fonts or icons into the page to get by: no emoji, no icon font, no font or image loaded by address and no stylesheet from a network address.

Icons are copied inline as vector markup (SVG) exactly as the project's own components render them. Delete what the plan does not need, and add the states the plan names.

```html
<!doctype html>
<html lang="en" data-mode="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PLACEHOLDER: the screen this mockup shows</title>
<meta name="afb-config" content='{"options":[{"key":"mode","label":"Mode","values":[["light","Light"],["dark","Dark"]]}]}'>
<!--afb-kit-->
<style>
/* ONLY THE CLASSES THE KIT LACKS GO HERE, COMPILED WITH THE PROJECT'S OWN TOOL. NO LITERAL COLOUR AND NO FONT NAME OF YOUR OWN */
</style>
</head>
<body class="PLACEHOLDER: the project's body classes">
<div class="flex min-h-screen flex-col md:flex-row">
	<nav class="flex gap-1 p-4 md:w-60 md:flex-col" aria-label="Main">
		<div class="p-2 font-semibold">PLACEHOLDER: the logo lockup</div>
		<a class="rounded-lg px-3 py-2" href="#" aria-current="page">PLACEHOLDER: this page</a>
		<a class="rounded-lg px-3 py-2" href="#">PLACEHOLDER: another page</a>
	</nav>
	<div class="flex min-w-0 flex-1 flex-col">
		<header class="flex items-center justify-between gap-3 px-4 py-3 md:px-8">
			<span>PLACEHOLDER: breadcrumb</span>
		</header>
		<main class="flex w-full max-w-6xl flex-col gap-4 px-4 pb-12 md:px-8">
			<div>
				<h1 class="text-2xl font-semibold">PLACEHOLDER: the page title</h1>
				<p>PLACEHOLDER: one line saying what the page is.</p>
			</div>
			<section class="rounded-xl p-4">
				<h2 class="text-lg font-semibold">PLACEHOLDER: a section</h2>
				<div class="flex min-h-12 items-center gap-3"><span class="hidden w-28 md:block">ID-0001</span><span class="min-w-0 flex-1">PLACEHOLDER: a realistic row title</span><span class="rounded-full px-2.5 text-xs font-semibold">Status</span></div>
				<div class="flex min-h-12 items-center gap-3"><span class="hidden w-28 md:block">ID-0002</span><span class="min-w-0 flex-1">PLACEHOLDER: another realistic row</span><span class="rounded-full px-2.5 text-xs font-semibold">Status</span></div>
			</section>
			<section class="rounded-xl p-4">
				<div class="py-8 text-center">PLACEHOLDER: the empty state of this list, in the product's voice</div>
			</section>
			<p class="rounded-lg p-3 text-sm">PLACEHOLDER: a message line for an error or a hint.</p>
			<div><button class="h-11 rounded-lg px-4 font-medium" type="button">PLACEHOLDER: the one primary action</button></div>
		</main>
	</div>
</div>
<script>
// The board writes each choice as data-<key> on the root element (data-mode="dark"). When the real app switches modes another
// way (a class on the root, a theme attribute), define this hook to set the app's own class or attribute, and the board calls it instead
// window.afbSet = function (key, value) { document.documentElement.classList.toggle('dark', key === 'mode' && value === 'dark'); };
</script>
</body>
</html>
```

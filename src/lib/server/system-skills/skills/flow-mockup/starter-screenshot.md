# Screenshot starter

The starter page for the `screenshot` tier of `flow-mockup`: a capture of an existing screen with numbered callouts saying what changes. Use it only to change a screen that already exists; a new screen or a new interaction is a wireframe. Copy the fenced block into a file in a temporary folder of your tool (never the repo).

What the build reads: **only the numbered callouts** (the list under the picture). The rest of the picture is the real screen as it is today.

Steps:

1. Capture the real screen from the running app in the harness browser (`flow-mockup` section "Screenshot rules"): 1280 and 408 wide, in each colour mode the app has. Never capture a screen that shows a secret, a token or a real person's data: draw that screen as a wireframe.
2. Save each capture as JPEG (or downscale it), then embed it as a `data:` address. The whole page stays under 3,000,000 characters, so keep each picture to about 300 KB or less. A page with four pictures (two widths, two modes) is the most this starter holds.
3. Place each pin over the picture in **percent coordinates** (`left` and `top` as a share of the picture's width and height), so it holds at every device width. Number the pins in the order of the callout list.
4. Write one callout per pin as text under the picture: what changes and where ("1. Add a filter row above the table, sticky on scroll"). Be concrete: "looks nice" is not a callout.
5. Draw nothing around the picture that the real screen does not show. No device frame and no switch of your own: the board draws them.

Publish with `agent-flow-board mockup push <file.html> --item <reference> --screenshot <the 1280 light capture as png> --renders --widths 408,1280`.

```html
<!doctype html>
<html lang="en" data-mode="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PLACEHOLDER: the screen this markup is about</title>
<meta name="afb-config" content='{"fidelity":"screenshot","options":[{"key":"mode","label":"Mode","values":[["light","Light"],["dark","Dark"]]}]}'>
<style>
:root { --bg:#f4f4f5; --box:#ffffff; --line:#c9c9cf; --ink:#27272a; --ink-2:#6b6b73; --pin:#b91c1c; --pin-ink:#ffffff; font-family: system-ui, sans-serif; }
:root[data-mode="dark"] { --bg:#18181b; --box:#232326; --line:#3f3f46; --ink:#f4f4f5; --ink-2:#a1a1aa; --pin:#fca5a5; --pin-ink:#18181b; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font-size:15px; line-height:1.45; }
.page { display:flex; flex-direction:column; gap:16px; max-width:1280px; margin:0 auto; padding:16px; }
h1 { margin:0; font-size:20px; } ol { margin:0; padding-left:24px; display:flex; flex-direction:column; gap:8px; }
.shot { position:relative; display:none; border:1px solid var(--line); border-radius:8px; overflow:hidden; background:var(--box); }
.shot img { display:block; width:100%; height:auto; }
/* One picture per mode and width: the 1280 picture from 820 up, the 408 picture below it. */
:root[data-mode="light"] .shot[data-mode="light"].wide, :root[data-mode="dark"] .shot[data-mode="dark"].wide { display:block; }
@media (max-width: 819px) {
	:root[data-mode="light"] .shot[data-mode="light"].wide, :root[data-mode="dark"] .shot[data-mode="dark"].wide { display:none; }
	:root[data-mode="light"] .shot[data-mode="light"].narrow, :root[data-mode="dark"] .shot[data-mode="dark"].narrow { display:block; }
}
.pin { position:absolute; display:flex; align-items:center; justify-content:center; width:28px; height:28px; margin:-14px 0 0 -14px; border-radius:9999px; background:var(--pin); color:var(--pin-ink); font-size:13px; font-weight:700; }
</style>
</head>
<body>
<div class="page">
	<h1>PLACEHOLDER: what changes on this screen</h1>
	<!-- PLACEHOLDER: one block per mode (light, dark) and width (wide = 1280 picture, narrow = 408 picture). Pins sit in percent coordinates and repeat in each block. -->
	<div class="shot wide" data-mode="light" data-ref="shot-wide-light">
		<img alt="PLACEHOLDER: the real screen at 1280, light" src="data:image/jpeg;base64,PLACEHOLDER">
		<span class="pin" style="left:42%;top:18%">1</span>
	</div>
	<div class="shot narrow" data-mode="light" data-ref="shot-narrow-light">
		<img alt="PLACEHOLDER: the real screen at 408, light" src="data:image/jpeg;base64,PLACEHOLDER">
		<span class="pin" style="left:50%;top:14%">1</span>
	</div>
	<ol data-ref="callouts">
		<li>PLACEHOLDER: what changes and where, one concrete line per pin.</li>
	</ol>
</div>
</body>
</html>
```

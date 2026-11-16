# Visual Evidence, Compare Tolerances, and Dev-Server Checks

This note records the architecture decisions and acceptance baseline for picture evidence on Agent Flow Board (`AFB-20261113-1008`).

## Architecture Decisions

### 1. Read-only dev-server checks with owner consent

- Registered dev targets (`check project ... --dev-url <url>`, `check run`, `check inspect`, `check compare`) run against a running local dev server only when a separate owner dev-check approval exists (`DEV_APPROVAL_REQUIRED` otherwise).
- Mutating HTTP methods and write actions stay blocked against `dev` targets unless matched by an owner-approved allowlist rule; full write-enabled flows still run against an isolated throwaway build and temporary database (`127.0.0.1`).
- Origin checks honor `HOST` and loopback aliases carefully so Vite/SvelteKit dev servers on `localhost` or `127.0.0.1` match consistently across platforms.

### 2. No evidence gate (removed 2026-11-14, AFB-20261114-1426)

- The visual evidence gate is gone: no `visualEvidenceGate` or `screenGlobs` project setting, no visible or inferred-visible steps, no `VISUAL_EVIDENCE_REQUIRED` refusal, no `evidence_waive`, no `sliceGate`, and no verified percentage or "unverified visually" flag. A step ticks by its own record, plus the run evidence a `requiredTarget` asks for.
- `check compare`, `check inspect` and the dev-server checks below stay as tools anyone may run. Nothing requires them and no step waits on them.

### 3. Hosted mockup inspection and tight compare tolerances

- Hosted mockups honor URL hook parameters (`screen`, `state`, `surface`, `person`, `offline`) and expose `agent-flow-board mockup pull`, `mockup url`, `mockup inspect`, and `mockup renders` (re-render an existing version with the person's own token, no file written, an undeclared screen refused).
- Renders of a mockup (`--renders` at push, or `mockup renders`) also carry `checks`: advisory quality findings the bridge's browser collected after the capture (sideways overflow, tap targets under 44 by 44 px below 640 px, AA contrast with a worst-stop gradient read). They are grouped, ranked fail before unknown and capped at 60, they never gate a push or a build, and a check that could not run is reported as unknown. `mockup_get` returns them with `tree true` and a count summary without it.
- `check compare` launches isolated browser contexts for the hosted mockup (zero cookies or local storage) and the target app registration across matching screens, states, and widths (`1280` by default; pass `--widths 390,1280` or step `widths` for multi-width parity).
- Default tolerances flag drift above `2 px` on element bounding boxes (`x`, `y`, `width`, `height`), above `1 px` on radius/padding/gap, or any mismatch on normalized colours, font family, font size, font weight, or visible text unless explicitly documented under `## Free` in `design-brief` (`ref | property | reason`).
- Code-mode critics under Design Fit inspect the attached screenshot pairs and `compare-diff.json` output when they are given.
- A mockup is served from its own hostname (`MOCKUP_ORIGIN`, for the AFB board `https://mockups.afb.arbenger.com`, a DNS-only record). The board's page frames it in a sandboxed iframe, the signed address is short lived, and no board cookie or referrer reaches it. Setup is in [self-hosting.md](self-hosting.md) ("Mockup hostname").

### 4. Versioned stock visual checks and Windows diagnostics

- `stockVisualChecks` (`STOCK_VISUAL_CHECKS_VERSION = 1`) evaluates layout stability (`cls`), tap-target dimensions (`tap-targets`), horizontal overflow (`sideways-scroll`), button styling (`button-chrome`), WCAG 2.1 text/background contrast (`contrast-pairs`), skeleton geometry (`skeleton-height`), focus rings (`focus-visible`), `prefers-reduced-motion` support (`reduced-motion`), and console errors (`console-errors`).
- `check doctor` inspects Windows/Git Bash pitfalls (`core.autocrlf`, `.gitattributes` LF rules, `MSYS_NO_PATHCONV`, unquoted SvelteKit `[param]` route globs) before running browser suites.

## Acceptance Baseline Checklist

- Database migrations `0042` through `0045` add dev registrations, mockup kit assets, derived mockup assets and session waiting blockers; migration `0047` drops the gate columns again (project `visual_evidence_gate` and `screen_globs`, item `slice_gate`, step `visible`, `visible_inferred`, `screens` and `widths`).
- Operations and MCP layers enforce `DEV_APPROVAL_REQUIRED`, project critic `lensPack` parsing, and MCP protocol version `2`.
- Bridge CLI exposes `mockup pull`, `mockup url`, `mockup inspect`, `check inspect`, `check compare`, early stock visual checks, `stockVisualChecks`, and Windows doctor diagnostics.
- System skills (`flow`, `flow-check`, `flow-audit`, `flow-critic`, `flow-interview`, `flow-verify`, `flow-align`) align on optional compare and inspect tools and Windows command hygiene.
- Manual interactive verification (`F.3`) remains for the project owner to exercise end-to-end on Windows (`localhost:7173` dev server + live compare preview) before release.

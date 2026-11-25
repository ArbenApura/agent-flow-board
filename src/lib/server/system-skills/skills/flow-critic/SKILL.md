---
name: flow-critic
description: Use when the user types /flow-critic (alone or with plan, code, mockup or screens), or asks for a review, a critique or critics on Agent Flow Board. The one entry for the four independent-critic reviews. The plan review attacks a /flow plan before it is built, the code review checks the changes before commit sign-off and at the end of every item (after any code change or server, migration or auth work), and the mockup and screens reviews start only on the user's word, or on /flow's own end-of-plan step for a plan that changed a screen. It works out which review was meant from the argument, the words, the item and the working tree, runs it when clear, shows one pick card when not, and reads only that review's file.
---

# Flow critic: one entry for the four reviews

> The user's own rule files win over this skill's defaults (`/flow` Precedence and "Flow preferences"); the safety rules never move.

The four reviews live in this folder, one file each: `plan.md` (attacks a plan before it is built), `code.md` (reviews the changes before sign-off), `mockup.md` (attacks a design mockup against the real product) and `screens.md` (one critic for each screen, judging pictures). This entry only decides which one the user meant and hands over. **It writes no review rules of its own: after the pick, read `critic-rules.md` and the file of the chosen review, and nothing else.**

## 1. An argument settles it

`/flow-critic plan`, `/flow-critic code`, `/flow-critic mockup` and `/flow-critic screens` choose that review at once, with no card. An exact argument beats the table of section 2. The first word is the review; an item reference after it (`/flow-critic code <item reference>`) names the item to review and does not change the pick.

## 2. Work it out, in this order

1. **The user's words** (the table below). A mockup id or link means mockup. "One critic for each screen", "desktop, tablet and mobile" or "render the pictures" means screens. **Mockup and screens are chosen only from the user's words, never from the item or the working tree** (they cost the most and run only on the user's word, or on `/flow`'s own end-of-plan step).
2. **The item and the tree**, when the words name no kind: an item that is planned and not built, with a clean tree, means plan; changes in the working tree (`git status`, untracked files included) on a built or active item mean code. Both at once: code first (the plan review is a separate one afterwards).
3. Still no clear single answer (a clean tree and no open item, "review it", two equal readings): show the pick card of section 3.

| You typed or said | Review |
|---|---|
| "critique the plan", "attack the plan", "/flow-critic" on an item that is planned and not built | plan |
| "review the code", "review the diff", "check my changes", "before I commit", "/flow-critic" with changes in the tree | code |
| a mockup id or link, "critique the mockup" | mockup |
| "one critic for each screen", "check desktop, tablet and mobile", "look at the pictures, not the code" | screens |
| "review it", "critics", "/flow-critic" with a clean tree and no open item | pick card |
| a plan and code changes both present, no words | code (plan afterwards) |

Say the pick in one line ("Code review: 9 files changed, 2 untracked") and go on; the user can correct it.

## 3. The pick card

Ask once, as the last call of the turn, with the question tool as `/flow` "Asking with the question tool" says (a listed or deferred tool counts as present; load a deferred one first). Header "Which review?", options in this order with the best fit first and marked "(Recommended)": **Code review** (the changes in the working tree), **Plan review** (the item's plan, before it is built), **Mockup review** (a published mockup), **Screens review** (one critic for each screen). With no question tool, take the recommended one, say so in one line and go on. The answer is the user's message: it is the pick, never a go to build.

During a build or `/flow-autopilot`, `/flow` runs `/flow-critic` with the argument (`code`, `plan` or `screens`), which shows no card, and sizes the critics itself with the table in `critic-rules.md`.

## 4. Hand over

Read `critic-rules.md` in this folder, then the file of the chosen review and the files that review names: plan: `plan.md` (with `plan-template.md` and `plan-lenses.md`); code: `code.md` (with `code-template.md`, `code-lenses.md` and `checklists.md`); mockup: `mockup.md` (with `mockup-lenses.md`); screens: `screens.md` (with `critic-brief.md`). Follow that review from its first line. Do not read the files of the other reviews for this run. In a tool with no skills folder, read the same files with `workflow_get` name `flow-critic` and the file name. The critic count comes from the sizing table in `critic-rules.md`, and the review ends as its file says.

## Never

- Choose mockup or screens from the item state or the tree.
- Show more than one card, or a card when an argument or the words already settle it.
- Add review rules, lenses or counts here, or run a review without reading its file.
- Treat the pick as permission to build.

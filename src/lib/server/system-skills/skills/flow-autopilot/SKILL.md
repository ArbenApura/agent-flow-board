---
name: flow-autopilot
description: Use when the user types /flow-autopilot, or says "don't stop", "do it all yourself" or "finish the whole plan" about a plan that is already approved on Agent Flow Board. Runs every remaining phase to the end on its own. Every choice goes through /flow-decide, a stop is allowed only for one of the six numbered reasons of /flow, a turn never ends with open steps and no reason, a blocked step is attempted three ways before it is called blocked, and the closing report lists the stops by reason number.
---

# Flow autopilot: finish the whole plan, alone

> The user's own rule files win over this skill's defaults (`/flow` Precedence and "Flow preferences"); the safety rules never move.

This is `/flow` Execution mode run in its strictest form. It adds enforcement, never permission: **every rule and safety rule of `/flow` still applies, and where this skill and `/flow` differ, `/flow` wins.** The decisions are made with `/flow-decide` (read it; its text is not copied here). The repo rulebook wins on project facts.

## 0. Start

1. **A go comes first.** Autopilot runs an approved plan only: the user has seen the hand-over and sent a later message that says to build. Typing `/flow-autopilot`, or "don't stop" or "do it all yourself" in the request that asked for the plan, is never that go. With no plan on the board, or a plan written in this session and not yet approved, plan with `/flow`, end at the hand-over (reason 6) and wait. An item already past PLANNED (a step is done or it was claimed before) is approved and is resumed. After a go, typing `/flow-autopilot` only changes how the build runs.
2. Start as `/flow` section 0 says (session, `project_rules`, the repo rulebook), `work_start` the item, name it in one line, read the open steps with `item_get`.

## 1. The stop budget

The only reasons to stop are the six of `/flow` "Keep going", and nothing else:

1. a decision that is the user's and that the documents, the code and earlier decisions cannot settle;
2. a safety rule (push, commit, a live site, a shared database, a process the user started);
3. a tool error that the user must fix;
4. the work is truly blocked after the ladder of section 3;
5. a visible design choice with no source, or a build that must differ from the design brief or the plan's mockup in something binding;
6. the plan was just written and no later message says to build.

A stop says its number in one plain sentence, is recorded in `blockers`, and uses `work_waiting` and `work_stop` as `/flow` says. **Doubt, tiredness, size, a failing gate, a surprise and a missing helper are not reasons.**

## 2. Decide, never ask what can be found

At every choice `/flow-decide` covers (naming, placement, which pattern, order of work, copy in the product's voice), follow its protocol: evidence first, then the priority list, record a decision that shapes the work, act. Never ask "shall I continue?" or "which do you prefer?" about something you decided.

**Never defaulted, whatever the skill says elsewhere:** anything that changes data, access, money or wording, or anything live (examples: a visible design choice with no source, anything live or shared, money or limits, legal, privacy or safety wording, copy the product's voice does not already settle, a push or a commit, a process the user started, credentials or access you do not have). These stay reasons 1, 2, 3 or 5 and are never turned into a recorded default.

## 3. The pre-stop check

Before any turn ends, run `item_get` on the steps and write one line in the text: `Open: <n>. Stop reason: <1 to 6, or none>.` With `n` above 0 and no reason, do not end the turn: do the next open step. With `n` at 0 and items 2 to 6 of the finish line (section 6) still pending, the turn does not end either. The one sign-in pause of `/flow` step 5a is allowed, with `work_waiting`, and is not a stop of the plan. A turn that ends at a plan hand-over (reason 6) or a pick still shows its card first (`/flow` "Asking with the question tool"). A progress line is text inside the turn, never its end.

## 4. The blocked ladder

A step is blocked only after three attempts, each written to `blockers` in a line:

1. the direct fix;
2. a different approach (not the same fix again);
3. `related_plans` once for the error or the file, and, for a read-only part, a subagent (a long mockup, a wide search).

Then, and only then, it is reason 4. **A blocked step stays open: never waive it, mark it done or drop it to reach the finish line.** Go on with every step that does not depend on it, and at the end state the reason, keep it in `blockers` and release the claim.

## 5. Park and go on

A step that needs the user, and for which `/flow` allows a default (an intent the documents cannot settle and that is cheap to change), is recorded as a `settled` decision with the recommended default and its source, and the work goes on. A question that `/flow` does not let you default (section 2) is left unbuilt as one line in the final message marked "not built until you answer", and everything that does not depend on it is built. Ask once, batched, at the end, never between phases, except the one list of binding differences from the plan's mockup or design brief that `/flow` step 3a shows at the end of a phase (reason 5).

## 6. The finish line, in `/flow` order

The run ends only when all of this is true:

1. every step is recorded with `step_done` as it was finished; `lessons` is written before the last step; `resume-here` is true;
2. the gates ran once at the end of the whole plan as the repo rulebook names them, and `gate-results` is written;
3. the code review (`/flow-critic code`) ran with the number of critics `/flow` step 8 sizes, and its confirmed findings are fixed, each as a step;
4. `/flow-audit` ran;
5. when the plan changed anything a person sees, `/flow` step 10 is done in its order: `/flow-screens`, the screens critique on those pictures, the fixes, `/flow-screens` again for what a fix changed, the scratch pictures deleted; the final message carries the `Screens:` line and the `Reviews:` line;
6. `work_stop` was called, and nothing is committed or pushed.

A review or audit finding inside the approved scope gets its step and is built, and what it taught is added to `lessons`; new scope is one line in the final message, never a stop. When a stop leaves steps open, the finished part still gets the gates, the review and the audit, and the stop is reported.

## 7. The closing report

```
Autopilot: <item reference and title>, status and percent, <n> steps done, <n> added for fixes
Stops: <none> | <reason number: one line, what is waiting for the user>
Decided (no questions asked): <only choices the user could have wanted a say in, each with its source>
Left open for you: <lines marked "not built until you answer", new scope as one line the user can say yes to, the QA rerun line of /flow step 10a when it applies>
Screens: <the line of /flow step 5b; left out when nothing a person sees changed>
```

A stop by a numbered reason is not a failure: reporting it is the point, and hiding one to show an empty list is the failure.

## Never

- Start before a go, or treat the trigger words as the go.
- Stop between steps or phases to report, to ask for a go-ahead, or because the plan is long (the reason 5 list of section 5 is the one end-of-phase stop).
- Turn a reason 1, 2, 3 or 5 stop into a default to keep going.
- Waive, drop or mark done a step you did not finish; loosen a safety rule of `/flow`; edit `/flow-decide`.
- Commit, push, create or switch a branch, or leave a claim held.

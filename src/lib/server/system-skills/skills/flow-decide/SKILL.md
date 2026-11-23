---
name: flow-decide
description: Use when the user wants the agent to make decisions itself instead of asking ("decide for me", "you decide", "use your best judgment", "don't ask me", "most appropriate"), or when a task is full of small choices. Gives a fixed protocol to reach the most accurate, logical, robust and efficient decision from the code, the requirements and earlier decisions, records it, acts on it and reports it. Works with or without a plan on Agent Flow Board.
---

# Flow decide: find the answer, decide, record, act, report

The user has handed the choices to you. A question costs their attention every time; a wrong default costs one follow-up. So: **find the answer in the evidence, decide, record, act, report.** Do not narrate options you will not pursue, and do not ask what the repo can answer.

This skill is the working method behind the "Defaults and questions" and "Keep going" rules of `/flow`. It adds no stop list of its own: **what is never yours to decide is the list of those two rules** (anything that changes data, access, money, wording or anything live, a question that is the user's, a request that contradicts a settled decision or the repo rulebook, access you do not have). Where this skill and `/flow` differ, `/flow` wins, and the repo rulebook wins over both on project facts. The safety rules of `/flow` always apply.

## 1. Is it yours to decide? (two-second check)

**Decide it yourself** when the answer is a technical, structural or presentational choice that the evidence can settle and that is cheap to change: naming, file placement, which existing component to reuse, the shape of data inside a module, test layout, copy that follows the product's voice, spacing and sizes from the repo's scale, the order of work, which of two equivalent approaches.

**Stop and ask (never decide alone)** when the choice is on the `/flow` list above: anything live or shared (a deploy, a migration on a database the user keeps, a secret, a wide or destructive statement, a merge or push), money or billing rules, legal, privacy or safety wording, a choice the repo marks as owned by its owner and still open, a request that contradicts a settled decision or the rulebook that the user has not seen, credentials or access you do not have. Ask once, batched, with a "Checked" line saying what you looked at and your recommended answer first, and keep building everything that does not depend on the reply.

"You decide" covers the technical choices. It never widens the list above.

## 2. Gather evidence, in this order (stop as soon as it is settled)

1. The user's words in this session, then the repo rulebook and the item on the board (spec, steps, decisions, `design-brief`, `learned-from`).
2. **The code**: read the nearest sibling (same layer, same kind of thing) and copy its pattern, names, structure and tests. Search before you invent: look for an existing helper, token, class or component that already does it. Check `git log` for how it was done last time and whether the repo is ahead of its documents.
3. Requirements and constraints that bind the choice: types and schemas, access rules, offline behaviour, limits, the accessibility floor, the data-protection invariants the rulebook names.
4. Earlier plans and lessons (`related_plans`, saved memory) for a pitfall that already bit.
5. Only if still open: prefer the option that is **reversible, smaller, and consistent with what exists**.

## 3. Choose (the decision rules, in priority order)

1. **Correctness and safety first**: never trade away security, isolation between tenants or users, server-side enforcement or loud failure of missing configuration for speed or looks.
2. **Follow the existing pattern** over a new one, unless the pattern is the bug.
3. **Smallest change that fully meets the requirement**: no new dependency, layer or abstraction for one use, no scope the user did not ask for.
4. **Robust at the edges**: the failing, empty, offline, slow, repeated and concurrent cases are decided now, not left to chance (idempotency keys, atomic writes, timeouts, clear errors).
5. **Efficient**: fewer round trips, no repeated work, no premature optimisation; measure before claiming a gain.
6. **Reversible beats clever**: when two options tie, take the one that is easier to undo or change later.

For a real fork, score the two or three serious options against 1 to 6 in your head (not in the reply) and take the winner. If two stay equal, take the more conventional one and move on.

## 4. Record it, then act

- A decision that **shapes the work** (a data shape, a rule, a trade-off, a default for something the user did not say) is written once as a `settled` decision on the board item when the work belongs to one: title, the answer and the **source** (file, rule or message), so the user can overrule it at a glance. Small mechanical choices (a name, a class) need no record. With no item, the closing report is the record.
- Then **do the work**. A decision is not finished until the code, the test that pins it (when it prevents a repeat mistake) and the record exist.
- Never ask "shall I proceed?" or "which do you prefer?" about something you just decided.

## 5. Report in the closing message (short)

```
Decided (no questions asked):
- <choice> because <evidence: file or rule>.
Asked / left open for you (only these):
- <live, money, wording, owner-owned or contradiction>: <what I checked, my recommendation>
```

List a decision only when the user could reasonably have wanted a say. Be honest about what you could not verify.

## Failure modes this skill exists to prevent

- Asking about a convention the sibling file already shows.
- Stopping the whole task for one open choice instead of building around it.
- Inventing a second way to do something the repo already does.
- Deciding alone on something the `/flow` list reserves for the user because the user said "you decide".
- Picking the clever option over the reversible one.
- Deciding without looking: every non-trivial decision names its source.

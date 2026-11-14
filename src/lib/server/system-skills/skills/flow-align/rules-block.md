# The rules block of flow-align

The block below is what `/flow-align` writes into the root rulebook of a repo. Copy everything from the opening marker line to the closing marker line, both included and unchanged. A later run replaces the block in place when the version in its marker is older than the one here. The block has its own version, which changes only when a line of the block changes, never for an edit of the skill around it. Each rule line is a sentence of the `flow` skill, word for word, so the block can never say something the skill does not.

<!-- afb:flow-align rules 1.2.0 (written by /flow-align; write your own rules outside this block, a later run replaces it) -->
## Flow rules (Agent Flow Board)

Plans live on Agent Flow Board and the installed flow skills are the method. Where this file states a project fact or a preference of its owner, this file wins; the flow safety rules always apply.

- Writing a plan never starts the build.
- Once building is approved, never stop between phases
- Do not stop between steps or phases to report, to ask "shall I continue?", or to wait for a go-ahead.
- A problem is not a stop.
- A permission is given once.
- Ask only when the answer changes data, access, money, wording or anything live.
- Do every step an agent can do on this machine yourself; never hand the user a command to paste or run when you can run it.
- Recording a step outranks starting the next one.
- Never tick a visible step without a picture pair when compare or dev-server evidence is required.
- Compare before you build further on a vertical-slice or redesign plan.
- **Run the gates once, at the end of the whole plan**, from the repo root, as the repo rulebook names them.
- **During the plan, no gate**: write the code carefully, record each step with `step_done` and carry on.
- Release `work_stop` when the session ends.
- The notes and pins are only a guide to the HTML and never replace it: never build a screen from the notes alone.
- The mockup is the spec for what a person sees: its structure, layout order, text, states and interactions are binding, whatever the notes say.
- The work stays in the working tree until the user says to commit (through the repo's own commit workflow, if it has one).
- Never `git push` without the user's explicit instruction.
<!-- /afb:flow-align rules -->

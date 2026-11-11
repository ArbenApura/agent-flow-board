// ASKING THE OWNER ON THE BOARD: THE AGENT FILES A REQUEST, THE OWNER CLICKS ONCE, THE BRIDGE CLAIMS THE ANSWER ONCE AND MAKES THE SAME LOCAL SINGLE-USE CODE A TERMINAL MAKES
// Nothing here reads a terminal. A code is made only from a decision the board returned to the claim call (approve.ts keeps the list), never from an argument.
// The board is injected, so the tests use a fake one. A board that does not know the path gives a plain message with the terminal fallback, the only way left there.
// Every other refusal names what the agent does next and never sends the owner to a terminal (AFB-20261110-1448): the owner's switch, a reconnect, a retry.
// -- MODULES -- //
import { APPROVAL_ACTIONS, Refusal, UsageError, claimBoardDecisions, isApprovalAction, mintFromDecision, normaliseTarget } from './approve.js';
import { BoardError } from './board.js';
// -- CONSTANTS -- //
/** The most entries one ask holds (the board's cap). */
export const ASK_LIMIT = 20;
const FALLBACK = 'The owner can still make a code on a terminal: agent-flow-board check approve --action <action> --target <target>.';
// -- FUNCTIONS -- //
/** Reads `<action>:<target>;<action>:<target>` into entries. All of them are checked before anything is asked. */
export function parseEntries(text) {
    const entries = text
        .split(';')
        .map((e) => e.trim())
        .filter(Boolean)
        .map((e) => {
        const at = e.indexOf(':');
        const kind = at > 0 ? e.slice(0, at).trim() : '';
        const target = at > 0 ? e.slice(at + 1).trim() : '';
        if (!isApprovalAction(kind) || !target)
            throw new UsageError(`"${e.slice(0, 60)}" is not <action>:<target>. Actions: ${APPROVAL_ACTIONS.join(', ')}.`);
        return { action: kind, target };
    });
    if (!entries.length)
        throw new UsageError('--request-many needs at least one <action>:<target>.');
    if (entries.length > ASK_LIMIT)
        throw new UsageError(`--request-many asks for at most ${ASK_LIMIT} things at once.`);
    return entries;
}
/**
 * The target as the command that takes the code spells it. `check login` and `check secrets import` accept a code for `<org>/<NAME>` only,
 * so a bare registration name is given the organisation of the board asked: a code for another spelling would be granted and then refused.
 */
export function targetFor(action, target, org) {
    const text = String(target ?? '').trim();
    if ((action === 'login' || action === 'secrets') && org && text && !text.includes('/'))
        return `${org}/${text}`;
    return text;
}
/** A board that cannot take the ask says so in words an agent can act on. Only a board too old to approve leaves the terminal path. */
function explain(e) {
    if (e instanceof BoardError) {
        if (e.status === 404)
            throw new Refusal(`This board is older and cannot take approvals yet. ${FALLBACK}`);
        if (e.status === 401)
            throw new Refusal("The board refused this machine's connection. Connect again yourself: agent-flow-board check connect --server <board address> --org <slug> --json (approve its code with the tool_connection_approve tool), then ask again.");
        // Only the owner's switch is something to tell the owner; another refusal (a role, a limit) is passed on as it is
        if (e.status === 403)
            throw new Refusal(e.message.includes('Agent access')
                ? `${e.message} Tell the owner this once, in one line, and carry on with what needs no approval.`
                : e.message);
        if (e.status === 429)
            throw new Refusal(e.message);
    }
    if (e instanceof BoardError ||
        e instanceof TypeError ||
        e?.name === 'TimeoutError')
        throw new Refusal(`The board could not be reached (${e instanceof Error ? e.message.slice(0, 120) : 'no answer'}). Ask again; if it keeps failing run agent-flow-board check doctor --fix --json. This is not a step for the owner.`);
    throw e;
}
const REFUSED = {
    refused: 'The owner refused this.',
    expired: 'The request ran out of time before the owner decided. Ask again.',
    cancelled: 'The request was withdrawn. Ask again.',
    claimed: 'This approval was already used. Ask again if it is needed again.'
};
/**
 * Asks the owner on the board and waits for the click (up to `waitMinutes`). Returns the codes, one per approved entry and no more, or `waiting` with the ids to resume.
 * A refusal, an expiry and a cancel throw a Refusal with one plain sentence. An abort withdraws the request first so no orphan card stays.
 */
export async function askOwner(board, o) {
    const now = o.now ?? Date.now;
    const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    let ids = o.resume ?? [];
    let link = null;
    if (!ids.length) {
        if (!o.entries.length)
            throw new UsageError('Say what to ask for.');
        if (o.entries.length > ASK_LIMIT)
            throw new UsageError(`At most ${ASK_LIMIT} things can be asked in one request.`);
        const spelled = o.entries.map((e) => {
            if (!isApprovalAction(e.action))
                throw new UsageError(`"${e.action.slice(0, 30)}" is not an action (${APPROVAL_ACTIONS.join(', ')}).`);
            return {
                action: e.action,
                target: normaliseTarget(e.action, targetFor(e.action, e.target, o.org))
            };
        });
        // Two spellings of one target (hapra and <org>/hapra) are one ask: the board refuses the same entry twice
        const entries = spelled.filter((e, i) => spelled.findIndex((x) => x.action === e.action && x.target === e.target) === i);
        let asked;
        try {
            asked = await board.requestApprovals({
                requestId: o.requestId ?? `r${now().toString(36)}${Math.random().toString(36).slice(2, 12)}`,
                entries,
                ...(o.why ? { why: o.why.slice(0, 2000) } : {}),
                ...(o.project ? { project: o.project } : {})
            });
        }
        catch (e) {
            return explain(e);
        }
        ids = asked.requests.map((r) => r.id);
        link = asked.link;
        // With the person's switch on the board approves at once and there is nothing to say; a row that is still open is waiting for the switch
        if (asked.requests.some((r) => r.status === 'pending'))
            o.say(link
                ? `Waiting for the owner. Ask them to turn on "Let my agent handle approvals on its own" at ${link}.`
                : 'Waiting for the owner. Ask them to turn on "Let my agent handle approvals on its own" under Settings, Agent access.');
    }
    const deadline = now() + Math.max(0, o.waitMinutes) * 60_000;
    let states;
    for (;;) {
        if (o.signal?.aborted) {
            await board.cancelApprovals(ids).catch(() => undefined);
            throw new Refusal('Stopped. The request was withdrawn from the board.');
        }
        try {
            states = await board.pollApprovals(ids);
        }
        catch (e) {
            return explain(e);
        }
        if (states.length !== ids.length)
            throw new Refusal('The board no longer has this request. Ask again.');
        const bad = states.find((s) => REFUSED[s.status]);
        if (bad)
            throw new Refusal(REFUSED[bad.status]);
        if (states.every((s) => s.status === 'approved'))
            break;
        if (now() >= deadline)
            return { state: 'waiting', ids, link };
        await sleep(o.pollMs ?? 3000);
    }
    let claimed;
    try {
        claimed = await claimBoardDecisions(board, ids);
    }
    catch (e) {
        return explain(e);
    }
    if (claimed.length !== ids.length)
        throw new Refusal('The approval was used or ran out just now. Ask again.');
    // Each claimed decision must be one of the rows asked about: the board's row for this action and target, nothing else
    for (const c of claimed) {
        const asked = states.find((s) => s.id === c.id);
        if (!asked || asked.action !== c.action || asked.target !== c.target)
            throw new Refusal('The board answered with something that was not asked for, so no code was made.');
    }
    const codes = claimed.map((c) => {
        const made = mintFromDecision(c);
        return {
            action: c.action,
            target: c.target,
            code: made.code,
            expiresAt: made.expiresAt,
            by: c.decidedBy
        };
    });
    return { state: 'approved', codes };
}

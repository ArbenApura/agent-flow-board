// ONE EARLY, PLAIN ANSWER TO "CAN THIS SIGN IN USE THIS ORGANISATION?" FOR THE COMMANDS THAT HOLD A PERSONAL SIGN IN (SETUP, MOCKUP, CHECK PULL).
// It asks the organisation's own address. The server answers 403 for both a sign in that belongs to another organisation and an organisation that
// does not exist, on purpose, so there are only two outcomes here and nothing that tells the two apart. It never blocks on a network error.
// -- FUNCTIONS -- //
/** The command that signs in again, written the way an agent should run it. */
const loginCommand = (server, org) => `agent-flow-board login --json --server ${server} --org ${org}`;
export async function checkOrgAccess(input) {
    const { server, org, token } = input;
    if (!token)
        return {
            ok: false,
            message: `Not signed in to ${org} on ${server}. Run: ${loginCommand(server, org)}`
        };
    // A runner token (afx_) belongs to the checks runner and is never accepted by /mcp, so it is not asked
    if (token.startsWith('afx_'))
        return { ok: true };
    let status;
    try {
        const res = await input.fetch(`${server}/mcp/${org}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                authorization: `Bearer ${token}`
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
        });
        status = res.status;
    }
    catch {
        // The board cannot be reached right now: the command itself will say so
        return { ok: true };
    }
    if (status === 401)
        return {
            ok: false,
            message: input.fromEnv
                ? `The token in AFB_TOKEN is expired or revoked for ${server}. Set a current one.`
                : `The saved sign in for ${org} is expired or was revoked. Run: ${loginCommand(server, org)}`
        };
    // The board answers 404 for a malformed organisation address before it reads the token, which is the same "no such organisation" to the person
    if (status === 403 || status === 404)
        return {
            ok: false,
            message: input.fromEnv
                ? `The token in AFB_TOKEN is not valid for ${org}, or there is no such organisation. Use a token made for ${org}.`
                : `This sign in is not valid for ${org}, or there is no such organisation. Run: ${loginCommand(server, org)}`
        };
    return { ok: true };
}

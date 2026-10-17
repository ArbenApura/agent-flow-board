// DEVICE CODE SIGN IN FOR THE BRIDGE (RFC 8628). THE PERSON TYPES THE CODE ON THE SERVER'S /device PAGE; NOTHING IS PRE FILLED.
// -- FUNCTIONS -- //
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function deviceLogin(server, fetchImpl, log, options = {}) {
    const wait = options.wait ?? sleep;
    const start = await fetchImpl(`${server}/oauth/device/code`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: options.name ?? 'agent-flow-board bridge' })
    });
    if (!start.ok)
        throw new Error(`The server refused the sign in (${start.status}).`);
    const d = (await start.json());
    log(`To sign in, open ${d.verification_uri} and type this code: ${d.user_code}`);
    log(`The code works for ${Math.floor(d.expires_in / 60)} minutes. Waiting for you to approve it...`);
    let interval = d.interval * 1000;
    const deadline = Date.now() + d.expires_in * 1000;
    while (Date.now() < deadline) {
        await wait(interval);
        const res = await fetchImpl(`${server}/oauth/token`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                device_code: d.device_code
            }).toString()
        });
        const body = (await res.json());
        if (body.access_token)
            return { token: body.access_token, expiresInSeconds: body.expires_in ?? 0 };
        if (body.error === 'authorization_pending')
            continue;
        if (body.error === 'slow_down') {
            interval += 5000;
            continue;
        }
        throw new Error(body.error_description ?? body.error ?? 'The sign in failed.');
    }
    throw new Error('The code expired before it was approved. Run the command again.');
}

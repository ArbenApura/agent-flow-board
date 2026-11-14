// `check secrets import|list|forget`: THE COMMAND SIDE OF THE SEALED STORE (secrets.ts holds every rule)
// Import needs the owner's approval code (check approve --request --action secrets --target <org>/<NAME>): an agent cannot mint one. Names only are ever printed.
// -- MODULES -- //
import { strictList } from '../listFlags.js';
import { findRegistration } from './registry.js';
import { forgetSecrets, importSecrets, listSecrets } from './secrets.js';
// -- CONSTANTS -- //
export const SECRETS_USAGE = [
    'Usage: agent-flow-board check secrets <command> --org <slug> --project <NAME>',
    '  import --from <file> --keys A,B [--test-ref <ref>] [--test-inbox <email>] [--owner-said "<sentence>"] [--allow-service-role] --approval <code>',
    '  list                names of the sealed values, never a value',
    '  forget              removes every sealed value of the registration'
].join('\n');
// -- FUNCTIONS -- //
export async function secretsCommand(args, ctx) {
    const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
    const has = (name) => args.includes(name);
    const show = (value, text) => ctx.json ? ctx.out(JSON.stringify(value)) : ctx.log(text);
    try {
        const sub = args[0];
        const org = flag('--org');
        const name = flag('--project');
        if (!sub || !org || !name) {
            ctx.log(SECRETS_USAGE);
            return 2;
        }
        const reg = findRegistration(org, name);
        if (!reg)
            throw new Error(`There is no registration ${name} in ${org}. Register it first: check project ${name} --org ${org} --repo <dir>`);
        if (sub === 'list') {
            const listed = listSecrets(org, name);
            show({ ok: true, ...listed }, listed.keys.length
                ? `Sealed values: ${listed.keys.join(', ')}${listed.testRef ? ` (test project ${listed.testRef})` : ''}`
                : 'Nothing is sealed for this registration.');
            return 0;
        }
        if (sub === 'forget') {
            forgetSecrets(org, name);
            show({ ok: true }, `Forgot the sealed values of ${org}/${name}.`);
            return 0;
        }
        if (sub === 'import') {
            if (!reg.repo)
                throw new Error(`${name} is a live site: it has no repo to import keys from.`);
            const file = flag('--from');
            // The keys widen what the import seals: comma form or one quoted list, a stray extra word is refused (rule R2)
            const keys = strictList(args, '--keys', /^[A-Z][A-Z0-9_]*$/, 'environment keys (uppercase letters, digits and underscores, starting with a letter)');
            const approval = flag('--approval');
            if (!file || !keys)
                throw new Error('Say --from <file> and --keys A,B.');
            if (!approval)
                throw new Error(`Secrets are imported with the owner's approval code. Ask the owner on the board: agent-flow-board check approve --request --action secrets --target ${org}/${name}, then you pass --approval <code>.`);
            ctx.log(`Sealing keys: ${keys.join(', ')}.`);
            const done = importSecrets({
                org,
                name,
                repo: reg.repo,
                file,
                keys,
                testRef: flag('--test-ref'),
                testInbox: flag('--test-inbox'),
                ownerSaid: flag('--owner-said'),
                allowServiceRole: has('--allow-service-role'),
                approval
            });
            show({ ok: true, ...done }, `Sealed ${done.keys.length} value(s): ${done.keys.join(', ')}.`);
            return 0;
        }
        ctx.log(SECRETS_USAGE);
        return 2;
    }
    catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (ctx.json)
            ctx.out(JSON.stringify({ ok: false, event: 'error', error: message }));
        else
            ctx.log(message);
        return 2;
    }
}

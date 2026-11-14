// SYSTEM SKILLS RELEASE TOOL (AFB-20261021-0401): yarn skills:sync [--amend]
// src/lib/server/system-skills/skills is the only place the flow skills are edited. This records each skill's hash in
// manifest.json under its current version, and writes the same files into .claude/skills for the tools that read them there
// (.agents/skills is a link to the same folder). A file in a skill's folder there that the source no longer has is removed.
// A skill whose text changed while its version stayed the same is refused: bump the version in manifest.json first, add a
// changelog entry for the new bundle version, then run this again. --amend replaces the hash of a version not yet released.

// IMPORTED DEP-MODULES
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// IMPORTED MODULES
import { normalize, skillHash, type SkillFile } from '../src/lib/server/system-skills/hash';

// -- TYPES -- //

type Manifest = {
	bundle: { version: string; releasedAt: string };
	skills: Record<string, { version: string; history: { version: string; hash: string }[] }>;
	changelog: { version: string; date: string; notes: string[]; skills: Record<string, string> }[];
};

// -- CONSTANTS -- //

const ROOT = process.cwd();
const SOURCE = join(ROOT, 'src', 'lib', 'server', 'system-skills', 'skills');
const MANIFEST = join(ROOT, 'src', 'lib', 'server', 'system-skills', 'manifest.json');
const LOCAL = join(ROOT, '.claude', 'skills');
const amend = process.argv.includes('--amend');

// -- FUNCTIONS -- //

const filesOf = (name: string): SkillFile[] =>
	readdirSync(join(SOURCE, name))
		.filter((f) => f.endsWith('.md'))
		.sort()
		.map((path) => ({ path, text: normalize(readFileSync(join(SOURCE, name, path), 'utf8')) }));

// -- RUN -- //

const today = new Date().toISOString().slice(0, 10);
let manifest: Manifest;
try {
	manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest;
} catch {
	manifest = { bundle: { version: '1.0.0', releasedAt: today }, skills: {}, changelog: [] };
}
const names = readdirSync(SOURCE, { withFileTypes: true })
	.filter((d) => d.isDirectory())
	.map((d) => d.name)
	.sort();
let failed = false;
for (const name of names) {
	const files = filesOf(name);
	const hash = skillHash(files);
	const entry = (manifest.skills[name] ??= { version: '1.0.0', history: [] });
	const seen = entry.history.find((h) => h.version === entry.version);
	if (!seen) entry.history.push({ version: entry.version, hash });
	else if (seen.hash !== hash) {
		if (amend) seen.hash = hash;
		else {
			console.error(
				`${name}: the text changed but version ${entry.version} is already recorded. Bump it in manifest.json.`
			);
			failed = true;
			continue;
		}
	}
	for (const f of files) {
		mkdirSync(join(LOCAL, name), { recursive: true });
		writeFileSync(join(LOCAL, name, f.path), f.text);
	}
	// Remove a stale file (a lens file merged or renamed in the source) so no tool keeps loading old text
	const keep = new Set(files.map((f) => f.path));
	for (const entry of readdirSync(join(LOCAL, name), { withFileTypes: true }))
		if (entry.isFile() && entry.name.endsWith('.md') && !keep.has(entry.name)) {
			rmSync(join(LOCAL, name, entry.name));
			console.log(`${name}: removed stale ${entry.name}`);
		}
	console.log(`${name} ${entry.version} ${hash.slice(0, 12)}`);
}
if (failed) process.exit(1);
if (!manifest.changelog.length)
	manifest.changelog.push({
		version: manifest.bundle.version,
		date: manifest.bundle.releasedAt,
		notes: ['First release of the system skills bundle.'],
		skills: Object.fromEntries(names.map((n) => [n, manifest.skills[n].version]))
	});
writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, '\t')}\n`);
console.log(`Bundle ${manifest.bundle.version}. Wrote manifest.json and .claude/skills.`);

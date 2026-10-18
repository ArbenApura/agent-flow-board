// DRIFT GUARD (AFB-20261018-0622, ADR 6): yarn skills:sync
// Copies the repo's own skills from .claude/skills into the tracked workflow-docs the MCP serves, front matter removed, and
// writes the hash manifest the CI test checks. Editing a skill means running this before the commit, or CI fails.

// -- MODULES -- //
import { syncSkills } from '../src/lib/server/skills/docs';

// -- RUN -- //

const written = syncSkills();
for (const e of written) console.log(`${e.file} ${e.hash.slice(0, 12)}`);
console.log(`Wrote ${written.length} files and the manifest. Commit them with the skill change.`);

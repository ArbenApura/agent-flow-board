// STARTS THE GITHUB STAND IN ON A PORT FOR THE BROWSER CHECKS (THE PREVIEW IS POINTED AT IT BY .env.test)
import { startGithubMock } from '../support/githubMock.mjs';

const port = Number(process.argv[2] ?? process.env.AFB_GITHUB_MOCK_PORT ?? 5181);
await startGithubMock(port);
console.log(`GitHub mock listening on ${port}`);

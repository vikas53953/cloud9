# Cursor Lane G — GitHub engine report

## Delivery

- Branch: `cursor/github-engine`
- Remote: `https://github.com/vikas53953/cloud9`
- Branch URL: `https://github.com/vikas53953/cloud9/tree/cursor/github-engine`
- Command builders commit:
  `012e67dd32073635f40e57f7e60ca10442e43e1b`
- Handoff contract commit:
  `3cd042fe53bc52a26a6043ebdc0111c2becf928a`

## Files

- `packages/engine/src/github-ops.ts` — pure, guarded operation builders.
- `packages/engine/src/github-ops.test.ts` — exact argv, approval and injection
  tests.
- `docs/plans/github-ops-handoff.md` — frames and conductor wiring list; no
  wiring performed.
- `github-engine-REPORT.md` — this evidence report.

No existing source file was edited.

## Operations covered

1. Open an issue.
2. Comment on an issue.
3. Comment on a pull request.
4. Request user and team review.
5. List pull request review comments.
6. Read one pull request review comment.
7. Check out or update an existing pull request branch.
8. Resolve a pull request review thread.
9. Read pull request CI status.

Every operation returns argv, the shared guard's rendered command line, a plain
description, approval state and counted facts. The functions do not execute.

## Test evidence

### Red proof

The first package-test attempt exited `2` before implementation and reported:

```text
src/github-ops.test.ts: Cannot find module './github-ops.js'
```

After implementation, the first full engine run deliberately proved the new
suite could catch a bad assertion:

```text
tests 418
pass 417
fail 1
failing test: untrusted prose never becomes a command-line argument
```

The assertion was corrected to inspect decoded JSON stdin rather than look for
an unescaped quote inside encoded JSON.

### Green proof

- Focused GitHub operations: **11 tests, 11 passed, 0 failed**.
- Complete engine package: **418 tests, 418 passed, 0 failed**.
- Whole repository `npm run build`: **passed**.
  - shared TypeScript build passed;
  - engine TypeScript build passed;
  - relay TypeScript build passed;
  - desktop production build passed;
  - desktop typecheck passed.

## Break-proof pairs

| Promise | Test that breaks if the promise breaks |
|---|---|
| Each operation uses the intended GitHub endpoint/verb | Seven exact-argv tests cover all nine operation shapes |
| No generated command bypasses the engine's injection rule | Every returned `line` must equal `commandLine(tool, argv)` |
| Repository text cannot inject a command | All seven repo-taking builders reject `vikas53953/cloud9;calc` with `UnsafeArgumentError` |
| Titles, bodies and thread IDs never enter argv | Hostile prose is decoded from stdin and proved absent from every argv |
| A write cannot be built quietly | All five write builders throw `GitHubOperationApprovalError` without literal approval |
| Write cards use measured quantities | Exact facts assert 1 issue/comment/branch/thread and the actual reviewer count |
| Reads do not create approval noise | List comments, read comment and CI status all assert `needsApproval: false` |
| CI fields do not reintroduce the comma bug | Exact CI argv asserts repeated `--json` flags with no comma |
| This lane did not wire another team's files | Git status and commits contain only the four exclusive new files |

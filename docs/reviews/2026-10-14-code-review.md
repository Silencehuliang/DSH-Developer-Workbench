# Code review — 2026-10-14

Two-axis review of the workbench implementation, per the `code-review` skill. The
two axes are reported separately and deliberately not merged: code can pass one
and fail the other, and reranking them into a single verdict is exactly what the
separation exists to prevent.

- **Fixed point:** `c08edf2` (`git diff c08edf2...HEAD`)
- **Commits:** 15, `c8b53ee` … `444a7fa`
- **Scale:** 106 files, ~11 400 insertions
- **Spec:** GitHub issue #1
- **Standards sources:** `AGENTS.md`, `docs/agents/*.md`, plus each module's own
  self-declared invariants, plus the Fowler smell baseline
- **Scope:** our code only. `plugin/skills/**` is vendored upstream content (MIT)
  and was not reviewed.

Both axes ran as parallel sub-agents; the findings below are theirs, aggregated.

---

## Standards

### Documented-standard breaches

1. **`plugin/client.js:699` — hardcoded colour.** `color: '#fff'` in
   `S.buttonPrimary`, against `AGENTS.md` («前端颜色一律用主题 token，不要写死»),
   and contradicting the file's own header claim that colours come from theme
   tokens. **Hard.**
2. **The no-literal-colour assertion did not guard the rule.** `verify.mjs`
   scanned only `STYLE_TEXT`; inline style objects were unscanned, which is
   precisely how #1 survived.
3. **The tracker's documented third tier is unreachable.** `AGENTS.md` fixes the
   order project → mapping → global default, but `lib/tracker.js:133-135` models
   tier three as a caller-supplied `fallback` and no call site passes one, so
   `source: 'global-default'` cannot occur in production.
4. **The host suite could skip itself silently.** One wrapping `try/catch` printed
   "skip host routes" for *any* exception while the run still exited 0 — a broken
   route or a bug in the suite could hide behind the word "skip".
5. **`plugin/package.json` `files` omits `ATTRIBUTION.md` and
   `LICENSE-mattpocock-skills`** — the MIT attribution would not travel with the
   package.

### Baseline smells (all judgement calls)

- **Divergent Change** — `WorkbenchPage` ≈ 425 lines with 20 `useState`s owning
  ten unrelated concerns; `verify.mjs` similarly mixes four suites.
- **Duplicated Code** — five near-identical fetch effects; `overrideStage` /
  `clearStageOverride` differing only in one argument; `createCommandRunner`
  re-implementing the runner in `lib/git.js`.
- **Shotgun Surgery** — one new setting touches three files.
- **Data Clumps** — the board shape is rebuilt in five branches.
- **Speculative Generality** — `maxFileBytes` has no caller; `VERSION` is
  duplicated from `package.json` with only a comment holding them together.

## Spec

### Missing or partial

- **Story 7** — `/overview` only replays the last *persisted* stage, so every row
  except the active project shows the placeholder.
- **Story 24** — the artifact scan reads local files only, so for this repository
  (whose tracker holds its spec) no spec is ever listed or previewable.
- **Story 28** — no Git overview in the right column; `lastCommit` is computed and
  shipped but never rendered.
- **Story 30** — no upstream artifact path enters any dispatch prompt.
- **Stories 13/14** — the stage evidence is prose in a `<p>`, not expandable to
  the files that decided it.
- **The `/state` decision** — `feature` and `lastSessionId` are read but never
  written.
- **Tier three** (as above) and **story 8** (`sessionCount` counts all sessions,
  not active ones).

### Not asked for

- `/probe` and `probeDirectory` — no client caller.
- `resume` and the workbench-chosen handoff filename (sanctioned later by ticket
  #9, absent from the original spec).
- The `/settings` page (sanctioned later by ticket #10).
- General contract drift: `/project` → `/artifacts` + `/tickets` + `/stage`;
  `/skills/install` dropped (intentional).

### Implemented but wrong

- **`review` / `pr` / `retro` are unreachable.** `record.reviews` and
  `record.pullRequests` are only ever read; nothing writes them, so a project
  whose tickets are all done reports `review` forever. The tests exercise the pure
  function and never its missing input.
- **Story 43** — `ProjectRow` was a `div` with `onClick`: mouse-only, while the
  stylesheet styled `.dw-project:focus-visible` and a comment claimed every
  interactive row was a real `<button>`.
- **Story 42** — the same `#fff` as above.

### Verified satisfied

`order: -10` placement; per-project tracker resolution (declaration → mapping →
ask at bind); ticket parsing including CRLF, cycles and unread edges; 27
package-served skills with the four-state self-check; three null-gated session
seats; zh/en dictionaries; two test seams.

### Spec text caveat

The spec's ticket section presents local markdown under `.scratch/` as *the*
tracker, and its contract lists `/skills/install` even though "Out of Scope"
forbids copying skills into a project. Both would mislead a reader; only
`AGENTS.md` carries the correction. A future reader of issue #1 alone would be
misled.

---

## What happened to the findings

**Fixed inline** (documented-standard breaches and the test-integrity hole — all
cheap, and two of them undermined other claims):

| Finding | Fix |
|---|---|
| Hardcoded `#fff` | now `var(--dsw-alias-bg-base)` |
| The colour audit could not see it | new assertion walks every rendered tree's inline styles, plus a guard that the walk is not vacuous |
| `ProjectRow` mouse-only | now a real `<button>` with a UA-style reset |
| Duplicate `StagePanel` key in `__test` | removed |
| The host suite could skip silently | one preflight decides reachability; an exception from a reachable server is now a **failure**, never a skip |

**Filed as tickets** (#12–#20): review/pr/retro writers, project-row completeness,
specs on an issue tracker, Git overview, artifact paths in prompts, tracker tier
three, package `files`, `/probe`'s role, and the refactor assessment.

**Not filed** (deliberate, already sanctioned by later tickets): `resume`, the
handoff filename, the settings page, and the contract drift.

---

## Summary

- **Standards:** 5 findings — worst: the host suite could report success while
  skipping itself, which put every other assurance in question.
- **Spec:** 10 findings — worst: three of the eight pipeline stages were
  unreachable, because nothing wrote the facts they read.

---
name: renault-feature
description: |
  Implements a feature in sowel-plugin-renault (MyRenault cloud integration). Use when:
  - User asks to "implement", "create a feature", "support a new Renault model"
  - User says "implémenter", "créer une feature", "supporter un nouveau modèle Renault"
  Same workflow as the Sowel core (sowel-feature): spec with gates, branch, tests, agent review, PR, explicit merge approval.
argument-hint: "[description de la feature ou du modèle à supporter]"
---

# sowel-plugin-renault — feature workflow

Feature request: $ARGUMENTS

Follow EVERY phase IN ORDER. Each phase has a GATE. Do NOT skip gates. Do NOT combine phases.

Conventions live in `CLAUDE.md`. Read its non-negotiable rules before designing anything; they are not reopened by a spec without saying so.

---

## Phase 1: Understand & Clarify

1.1 Read `CLAUDE.md`, `docs/specs-index.md` and `specs/` (there may already be a spec for this).
1.2 Ask clarifying questions until a complete spec can be written without assumptions: what, why, scope in/out, data, API surface used, edge cases.
1.3 Search the codebase for similar patterns before inventing.
1.4 **For an endpoint or a model**, establish behaviour from evidence, never from a guess:

- a response captured from the real account (secrets, VIN and coordinates scrubbed), or a named public source (hacf-fr/renault-api, evcc) with its commit;
- for each endpoint: path, version, the models it works on, the error it returns elsewhere (`err.func.wired.forbidden`, `notFound`…);
- an action is never sent to a car to "see what happens" without the owner's explicit agreement for that action.

1.5 If the feature needs something the core does not offer (an equipment type, a category, an API method), write it down as a **core issue** to open, with its own product argument. Do not work around it here.

> **GATE 1**: requirements clear, existing patterns checked, endpoint evidence in hand, core dependencies identified.

## Phase 2: Document the spec

```bash
ls specs/ | tail -1          # next number
mkdir specs/NNN-<kebab-name>
```

Write three files, in English (CI fails a new spec folder missing one):

| File              | Content                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `spec.md`         | Context, goals, non-goals, functional requirements, acceptance criteria, edge cases                   |
| `architecture.md` | API calls (paths, payloads, errors), data and order flows, contracts with Sowel's API, file changes   |
| `plan.md`         | Implementation steps and the **test plan** (module, scenario, expected), including recorded responses |

Then **a row in `docs/specs-index.md`** for the new folder, in the same commit. `npm run validate` fails without it.

Present a summary to the user and ask: "Voulez-vous que j'implémente ?"

> **GATE 2**: three files written, test plan included, index row added, user said "oui" / "go".

## Phase 3: Branch & implement

```bash
git checkout main && git pull
git checkout -b feat/<name>      # feat/ fix/ refactor/ docs/
```

Implementation order:

1. Types and pure modules first (response decoding, contract mapping), testable without the network
2. Fixtures (recorded responses, secrets/VIN/coordinates scrubbed)
3. The HTTP client behind an interface, so the plugin is tested against a fake API
4. Devices declared through discovery, readings through `updateDeviceData`
5. Orders (actions), with their outcome reported
6. Tests
7. `manifest.json` (settings, version), README (supported models table)

Tests are mandatory: every scenario of the plan's test plan gets a test, next to its module, Vitest. No test calls Renault.

> **GATE 3**: on a feature branch, order followed, every planned scenario has a test.

## Phase 4: Validate

```bash
npm run validate     # typecheck, typecheck:tests, lint, format:check, test, build, specs index
```

Zero errors. This is exactly what CI runs.

When the change touches the API client and the owner's account is available, also run it against the real account (reads freely; actions only with the owner's agreement) and paste the outcome (redacted) in the PR. Say plainly when that was not possible.

> **GATE 4**: validate is green; hardware check done or explicitly not done.

## Phase 5: Agent review

Spawn a review agent on `git diff main...HEAD` with the spec as intent. Checklist: correctness and edge cases, conventions in `CLAUDE.md` (secrets never logged, no coordinates, never throw, rate budget, no destructive action), scope (nothing beyond the spec), tests match the plan, no secret in fixtures, no weakened gate. Fix blocking findings, re-run Phase 4, summarise the outcome.

> **GATE 5**: no unresolved blocking finding.

## Phase 6: Commit & PR

Conventional commits, scopes: auth, api, vehicles, devices, orders, polling, manifest, ci. Tick acceptance criteria in `spec.md` and tasks in `plan.md`. No `Co-Authored-By: Claude` line.

```bash
git push -u origin feat/<name>
gh pr create --title "feat(scope): ..." --body "Summary / Changes / Test plan"
```

> **GATE 6**: PR URL shared with the user.

## Phase 7: Wait for merge approval

**Never merge without an explicit "oui" / "merge" / "go".** Then:

```bash
gh pr merge <n> --squash --delete-branch && git checkout main && git pull
```

Then close the loop on the record, before saying you are done: tick the spec's status to ✅ in `docs/specs-index.md` (one-line PR), and open the core issues identified in Phase 1.5 if they are not open yet.

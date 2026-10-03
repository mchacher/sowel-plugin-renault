# CLAUDE.md

Guidance for Claude Code (and any AI agent) working on `sowel-plugin-renault`. First file to read. Same method as the Sowel core: spec with gates, feature branch, tests, agent review, PR, explicit merge approval.

## What this is

A Sowel **integration plugin** for **Renault cars**, through the MyRenault cloud — the private API the official app uses. One MyRenault account, any number of cars: each one is published as an ordinary Sowel device carrying the **electric vehicle contract** of core spec 183 (battery level, range, plugged, charging state, report time, at home, mileage, charge limit, and the `wake` / `charge_start` orders).

Its first purpose: let a charging recipe know the car's battery level, and **wake a sleeping car** so a paused charge can resume. Measured on the owner's Renault Rafale (2026-10-03): the car sleeps minutes after a charge pauses, ignores everything the charger can do, and wakes on a remote lights command; `charging-start` is forbidden for that model.

## Where to find context

| You want to know...                         | Read this                                                                                            |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| The contract this plugin publishes          | `mchacher/sowel`: `specs/183-electric-vehicle-equipment/`, `src/shared/electric-vehicle-contract.ts` |
| The MyRenault API (auth, endpoints, errors) | [docs/renault-api.md](docs/renault-api.md) — the research brief, with sources                        |
| How Sowel loads and isolates a plugin       | `mchacher/sowel`: `docs/technical/plugin-development.md`, `src/plugins/scoped-deps.ts` (spec 111)    |
| The API slice this plugin relies on         | `src/sowel-api.ts` (hand-synced with the core's `src/shared/plugin-api.ts`)                          |
| The charger the cars plug into              | [`sowel-plugin-tuya`](https://github.com/mchacher/sowel-plugin-tuya) and core spec 182               |
| Every feature specified here                | [docs/specs-index.md](docs/specs-index.md) — one row per spec, CI-gated                              |

The core repo is expected as a sibling directory (`../sowel`).

## Non-negotiable rules

- **Publish the core contract, by category.** Every point a car exposes that the contract defines carries its `ev_*` category; everything else (fuel, climate, tyre pressures, raw codes) is `generic`. A missing concept is a core issue, never a workaround here.
- **Secrets.** The password and the Gigya login token live in settings (`password` type) and nowhere else: never logged, at any level, in whole or in part; never in a fixture, a test or an issue. Prefer storing the long-lived login token over re-sending the password.
- **No coordinates.** The car's position is read only to compute `at_home` against the home location; latitude and longitude are never published, logged or stored.
- **No VIN in logs or fixtures.** Use the model label and the last four characters.
- **Respect Renault's rate budget.** One request at a time per account, a global budget (about 40 calls per hour), backoff on `err.func.wired.overloaded`. Reads return the car's last report: polling faster does not make the data fresher.
- **No destructive action.** Never rewrite a user's charge schedule or settings to obtain a side effect (evcc's "MY24" wake does; we do not). An action is sent only when a user or a recipe asks for it.
- **Probe per model, remember.** Endpoints differ by model; a `forbidden` / `notFound` answer is remembered per car so the plugin stops asking. Transient errors (unauthorized, overloaded, 5xx) are never remembered as "unsupported".
- **Never throw** from a timer or a handler. `executeOrder` rejects with a user-readable reason (`charge start is not allowed for this vehicle`), never with a raw API error carrying tokens.
- **Spec 111 isolation**: devices with `integrationId === "renault"`, settings under `integration.renault.*` plus `home.latitude/longitude/timezone`, events `system.integration.*` / `system.alarm.*` only.

## Tech

Node 24, TypeScript strict, ESM (`NodeNext`). The HTTP client is written here (no maintained Node library exists), following hacf-fr/renault-api and evcc; runtime dependencies are chosen in a spec. Vitest. ESLint + Prettier as in the core. `console.*` is an error: use the injected pino logger.

```bash
npm install
npm run validate        # typecheck, typecheck:tests, lint, format:check, test, build, specs index — exactly what CI runs
npx vitest run <file>   # one test file
```

## Git workflow

- Feature branches for anything non-trivial: `feat/`, `fix/`, `refactor/`, `docs/`. Main is protected (PR required, linear history, CI green).
- Conventional commits. Scopes: `auth`, `api`, `vehicles`, `devices`, `orders`, `polling`, `manifest`, `ci`.
- **Never merge a PR without explicit user approval** ("oui", "merge", "go").
- **Never add `Co-Authored-By: Claude` lines** in commit messages or PR bodies.
- Every new `specs/NNN-name/` folder needs `spec.md`, `architecture.md`, `plan.md` **and a row in `docs/specs-index.md`**.
- A release is a PR (version bump in `package.json` **and** `manifest.json`, changelog entry), a tag on main, then the **registry hash bump in the core** (spec 089). See the `renault-release` skill.

## Skills

| Skill             | When                                                            |
| ----------------- | --------------------------------------------------------------- |
| `renault-feature` | Implementing a feature or a new model: spec, branch, tests, PR. |
| `renault-release` | Bumping, tagging, publishing, and bumping the registry hash.    |

## Answering the user

Short and ordered. One or two lines for the what, one bullet per finding or decision. French or English, whichever the user uses.

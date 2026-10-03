# Spec 001 — MyRenault account, cars as electric vehicles, remote wake

- **Status**: Draft
- **Date**: 2026-10-03
- **Related**: core spec 183 (electric vehicle contract — what this plugin publishes), core spec 182 (EV charger), core spec 111 (plugin isolation), [docs/renault-api.md](../../docs/renault-api.md) (the API reference, with what was measured)
- **Cars**: the owner's Renault Rafale E-Tech plug-in hybrid (XHN1CP) now, a Megane E-Tech soon — same account

## Context

The owner charges a Renault on a dé charger driven by Sowel. When a charge pauses, the car falls asleep within minutes and nothing the charger can do resumes it; a remote command sent through the MyRenault cloud does (measured: the lights command, which does not even flash the lights, restarted the charge thirteen seconds later). The same cloud reports the car's battery level, which is what a charging recipe needs to aim at a percentage rather than a number of kWh.

This spec connects one MyRenault account to Sowel and publishes every electric or plug-in hybrid car on it as a device carrying the core electric vehicle contract.

## Goals

1. Log in to MyRenault with the owner's e-mail and password, keep the session alive with the long-lived login token, and survive key drift and token expiry.
2. Discover the account's electric and plug-in hybrid cars and publish each as a device with the contract categories of core spec 183.
3. Keep their data current within Renault's rate budget, and say how old it is (`reported_at`).
4. Implement `wake` (lights on the models where it works) and, where the maker allows it, `charge_start` and the `charge_limit` order.
5. Never leak a secret, a VIN or a coordinate.

## Non-goals

- **Two-factor authentication.** Not required on the owner's account (measured). If Renault asks for it (Gigya `403101`), the plugin reports it clearly and stops; implementing the e-mail code flow is a later spec (it needs a code typed by the user, i.e. a UI path the plugin API does not offer yet).
- **Climate control, horn, lights, location as user features.** Lights is used internally to implement `wake`; the rest is not exposed.
- **Charge schedules and charge mode.** Forbidden on the Rafale; never rewritten (evcc's "MY24" wake overwrites the schedule — not done here).
- **Non-electric Renault cars** (petrol, full hybrid): not published.
- **Other brands of the same platform** (Dacia, Alpine): the account type filter keeps MyRenault only.

## Functional requirements

### Settings and session

- **FR1** Settings: `email` (required), `password` (password type, required), `locale` (default `fr_FR`), `gigya_api_key` and `kamereon_api_key` (optional overrides of the shipped defaults, for when Renault rotates them), `home_radius_m` (default 200).
- **FR2** Login: Gigya `accounts.login` → login token → `getAccountInfo` (person id) → `getJWT` (15 min). The login token is stored in the plugin's own settings (`login_token`, never shown) so a restart does not resend the password; the JWT is refreshed from the login token 60 s before it expires; on Gigya `403005`/`403013` the login token is dropped and the plugin logs in again with the password.
- **FR3** Failures are told apart, once per transition: `403042` invalid credentials (status `error`; the message adds "or Renault changed its API key", since Renault answers the same code for both); `403101` two-factor authentication required (status `error`, a `system.alarm.raised` with the explanation); network failure (status `disconnected`, retry with backoff 1 → 30 min).
- **FR4** No secret (password, login token, JWT), no VIN beyond its last four characters and no coordinate is ever written to a log line, a published value, an error message or a fixture.

### Discovery

- **FR5** On start and every 24 h: person → accounts of type `MYRENAULT` → vehicles. A car is published when its `engineEnergyType` (else `energy.code`) is `ELEC`, `ELECX` or `PHEV` and its link has details. Its source id — which the core also uses as the device's default name — is the model label and the VIN's last four characters (`Rafale 3061`): the full VIN stays in request paths only.
- **FR6** Each car is a device with the contract data points of core spec 183 (`ev_battery_level`, `ev_range`, `ev_plugged`, `ev_charging_state`, `ev_reported_at`, `ev_at_home`, `ev_mileage`, `ev_charge_limit` when available) and the plug-in hybrid's fuel range and quantity as `generic` extras.
- **FR7** Orders are declared per model from a capability table seeded from the reference library and from what was measured: the Rafale (XHN1CP) declares `wake` and no `charge_start` (forbidden, measured); the Megane E-Tech (XCB1VE) and unknown models declare `charge_start`. `charge_limit` (data and order) is declared while soc-levels answers (measured: it does on the Rafale). An order or a read refused with `forbidden`/`notFound` is removed from the device and remembered for that car.

### Polling

- **FR8** One request at a time per account, and a budget of 40 requests per rolling hour shared by all cars. Battery status every 10 min per car; cockpit and location every 60 min; soc-levels once at start and after a write. When the budget is spent, polls wait.
- **FR9** The plugin declares itself a polling integration (`getPollingInfo`, the battery cadence): the core then waits twice that before calling an order unconfirmed — a car reports a minute or more after an order, and the default 30 s raised a false "not confirmed" on every charge-limit change (found on the candidate instance). `reported_at` is the car's own `battery-status.timestamp`, never the poll time. The device stays `online` while the cloud answers; a car whose report is days old stays online (the age tells the story).
- **FR10** `err.func.wired.overloaded` pauses all polling 15 min. `err.func.wired.unauthorized` refreshes the JWT once and retries once (the retry counts against the budget); repeated, it pauses all requests 15 min, as it can mean throttling. Wrong credentials or two-factor met later, from a poll, stop every poll and set status `error`: the password is never resent in a loop.

### Contract mapping

- **FR11** `charging_state` from `plugStatus` and `chargingStatus` as in docs/renault-api.md ("Contract mapping"); an unknown code keeps the previous value and is logged once.
- **FR12** `at_home` is true when the car's location is within `home_radius_m` of Sowel's home position (`home.latitude`/`home.longitude`); the coordinates are used for that comparison only and discarded. Without a home position, `at_home` is not published.

### Orders

- **FR13** `wake` sends the lights action (`horn-lights`, target `lights`). It resolves when Renault accepts it; the plugin then reads the battery status again after 60 s (the car reports once awake).
- **FR14** `charge_start` sends the model's charge-start action (KCA, or KCM for the Megane E-Tech family). A `forbidden` answer rejects with "charge start is not allowed for this vehicle" and removes the order (FR7).
- **FR15** The `charge_limit` order posts soc-levels with the current `socMin` and the requested target rounded to 5 within 55–100; the reading follows on the next soc-levels read.
- **FR16** `executeOrder` rejects with a short, user-readable reason; never with a raw API body.

## Acceptance criteria

- [x] With e-mail and password, the plugin logs in, publishes the owner's Rafale with its battery level, range, plugged and charging state, report time, mileage, fuel extras, and `at_home`.
- [x] A restart reuses the stored login token (no password sent); an expired JWT is refreshed transparently.
- [x] `wake` on the sleeping Rafale wakes it (charge resumes on the dé charger), measured.
- [x] `charge_start` is not declared on the Rafale; on an unknown model a `forbidden` answer removes it.
- [x] Never more than 40 requests per hour per account; `overloaded` pauses 15 min.
- [x] No password, token, full VIN or coordinate in any log, value, error or fixture — tested with sentinels.
- [x] `npm run validate` and CI green.

## Edge cases

| Case                                 | Expected                                                          |
| ------------------------------------ | ----------------------------------------------------------------- |
| Wrong password                       | Status `error`, "invalid e-mail or password"; no retry storm      |
| Renault rotates the Gigya key        | Same `403042`; message suggests the key; settings can override it |
| Two-factor authentication enforced   | Status `error`, alarm raised, no retry loop                       |
| Car in deep sleep                    | Reads keep returning the last report; `reported_at` shows its age |
| Privacy mode (`err.func.privacy.on`) | Location-based `at_home` not published; other data as available   |
| Second car added to the account      | Appears at the next daily discovery (or a plugin restart)         |
| Car removed from the account         | Its device goes away (stale device removal)                       |
| No home position in Sowel            | `at_home` not published                                           |

## Decisions

Taken by the agent, flagged for the owner: 40 requests/hour budget and the cadences of FR8; the login token persisted in the plugin's settings; a 200 m home radius; lights as the default wake (measured on the Rafale); two-factor authentication detected but not implemented.

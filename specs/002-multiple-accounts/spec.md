# Spec 002 — Several MyRenault accounts

- **Status**: In progress
- **Date**: 2026-10-21
- **Related**: spec 001 (one account, cars as electric vehicles), core spec 111 (plugin isolation), core `IntegrationSettingDef` (`text` / `password` / `number` / `boolean` only)

## Context

MyRenault ties a car to one identity: a second car in the household (the owner's partner just took a Megane E-Tech) cannot live on the same login, so it comes with its own e-mail and password. Spec 001 reads exactly one account: one `Session`, one rate budget, one login token, one status, one alarm. Sowel's settings form has no repeatable group and an integration is a singleton, so "several accounts" has to fit in the flat settings of the one `renault` integration.

## Goals

1. Connect up to **three** MyRenault accounts at once; every electric car of each is published as in spec 001.
2. **Zero migration**: an installation configured with spec 001 keeps working untouched and is "account 1".
3. **Isolation between accounts**: one account failing (wrong password, two-factor, network) never stops, purges or hides another's cars.
4. Each account has its own Renault budget, session, retry and alarm.

## Non-goals

- A repeatable settings group or an "Add account" button: that is a core feature, argued separately if three slots ever fall short.
- A different locale, home radius or API keys per account: these stay shared.
- Two-factor (still spec 001's non-goal).
- Moving a car between accounts: the device is keyed by model and VIN tail, so it follows the car, and the account only decides who talks to Renault.

## Functional requirements

### Settings

- **FR1** Three account slots in the form. Slot 1 keeps the spec 001 keys `email` and `password`; slots 2 and 3 use `email_2`, `password_2`, `email_3`, `password_3`. Each slot also has an optional `account_label` (`_2`, `_3`) naming it in logs and alarms; default `Compte 1`, `Compte 2`, `Compte 3`. `locale`, `home_radius_m`, `gigya_api_key`, `kamereon_api_key` are shared.
- **FR2** A slot is active when its e-mail and password are both set. A slot with only one of the two is ignored and a warning (label only) is logged. The integration is configured when at least one slot is active.
- **FR3** Login tokens are stored per slot (`login_token`, `login_token_2`, `login_token_3`); never shown. The capability memory stays a single shared setting, keyed by the VIN's last four characters as today.

### Connection per account

- **FR4** Every active slot runs its own connection: `Session`, `RateLimiter` (40 requests per rolling hour **per account**), `Kamereon`, `Account`, scheduler, retry backoff (1 → 30 min) and failure state. A failure of one is handled exactly as spec 001 FR3 and FR10 say, for that connection only.
- **FR5** Two-factor on a slot raises `renault.two-factor` (slot 1, unchanged id) or `renault.two-factor.2` / `.3`, its message prefixed by the label; resolved when that slot connects.
- **FR6** Integration status: `connected` when at least one account is connected; `error` when every active account is in `error`; `disconnected` otherwise. `system.integration.connected` / `disconnected` fire on transitions of that aggregate.
- **FR7** A log line about an account carries its label, never its e-mail; no secret, VIN beyond four characters, or coordinate (spec 001 FR4 unchanged).

### Devices

- **FR8** Stale-device removal runs **only when every active account completed a discovery in the same round**, over the union of their cars. If any account is failing, nothing is removed anywhere (a cold start with one account down must not purge its cars). Emptying a slot therefore removes its cars at the next complete discovery.
- **FR9** If two accounts list the same car (same source id), the first account in slot order owns it; the second logs once and skips it.
- **FR10** `executeOrder`, `refresh` and polling address the account that owns the device. `refresh` reads one battery per car across all accounts.

## Acceptance criteria

- A spec 001 installation, restarted on this version with no settings change, publishes the same devices, with no new login (stored token reused) and no device removed.
- With two active slots, both cars are published; breaking slot 2's password leaves slot 1's car polling and `online`, status `connected`, no device removed.
- A wake order on the Megane goes through slot 2's session, not slot 1's.
- Clearing slot 2 and restarting removes the Megane device once slot 1 has discovered.

## Edge cases

- All slots empty → `not_configured`.
- Same e-mail in two slots → both run (harmless); the duplicate car is skipped by FR9.
- Slot 2 fails at the very first start while slot 1 works → the Megane device does not exist yet, nothing to purge; retry per FR4.
- Renault answers `overloaded` on slot 2 → only slot 2's limiter pauses.

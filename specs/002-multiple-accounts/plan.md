# Spec 002 — Plan

## Steps

- [x] 1. `config.ts`: slots, `readConfig`, schema, `loginTokenKey` + tests (old single-account settings read as slot 1).
- [x] 2. `account.ts`: `discover()` returns the seen set, drop stale removal, `isOwned` + adapt tests.
- [x] 3. `connection.ts`: move the per-account lifecycle out of `index.ts` + tests.
- [x] 4. `index.ts`: aggregate status, alarms, routing, stale pass + adapt/extend `index.test.ts`.
- [x] 5. `manifest.json` (kept equal to `SETTINGS_SCHEMA`), version 0.2.0, README, CHANGELOG.
- [ ] 6. Live check on the owner's instance: the Rafale unchanged after update, then the Megane added through slot 2 (reads only, then one wake with the owner's agreement).

## Test plan

| Module       | Scenario                                                          | Expected                                                          |
| ------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------- |
| `config`     | Spec 001 settings only (`email`, `password`)                      | one account, slot 1, same token key                               |
| `config`     | Slots 1 and 3 complete, slot 2 empty                              | two accounts, labels `Compte 1` / `Compte 3`                      |
| `config`     | Slot 2 with e-mail only                                           | not an account; reported as incomplete                            |
| `config`     | Custom `account_label_2`                                          | used as the label                                                 |
| `config`     | `isConfigured` with only slot 2 complete                          | true                                                              |
| `account`    | Two vehicle links, one already owned elsewhere                    | owned one skipped, one log                                        |
| `account`    | `discover()` success                                              | returns the seen ids; `removeStaleDevices` not called             |
| `connection` | Wrong credentials                                                 | state `error`, retries stop, other connections untouched          |
| `connection` | Network failure                                                   | `disconnected`, retry 1 → 30 min doubling                         |
| `connection` | Two-factor                                                        | slot-specific alarm id, label in the message; resolved on connect |
| `connection` | Own login token key                                               | slot 2 stores/reads `login_token_2` only                          |
| `index`      | Slot 1 ok, slot 2 wrong password                                  | status `connected`; slot 1 car polling; no device removed         |
| `index`      | Both ok, one car left slot 2                                      | stale pass over the union removes only that car                   |
| `index`      | Slot 2 down at start, devices already in DB                       | `removeStaleDevices` not called                                   |
| `index`      | Slot given another e-mail, old token stored                       | old token dropped, new login                                      |
| `index`      | Stop while a discovery is queued; stop with an alarm raised       | nothing raised after stop; alarm resolved                         |
| `index`      | Car handed from slot 1 to slot 2                                  | not removed; slot 2 polls it                                      |
| `index`      | Both slots in error                                               | status `error`                                                    |
| `index`      | Order on a slot-2 car                                             | sent with slot 2's kamereon                                       |
| `index`      | Same car on both accounts                                         | one device, owned by slot 1                                       |
| `index`      | **Secrets never leak**: sentinel passwords and e-mails of 3 slots | none in logs, values, errors, alarm messages                      |
| `index`      | Each limiter independent                                          | slot 2 `overloaded` does not pause slot 1                         |

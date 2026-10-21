# Spec 002 — Architecture

## Shape

```
RenaultPlugin (index.ts)           aggregate status, alarms, orders routing, stale cleanup
  └─ Connection × N (connection.ts)  one per active slot
       ├─ Session      (login token stored under the slot's key)
       ├─ RateLimiter  (40/h, this account only)
       ├─ Kamereon
       ├─ Scheduler    (discovery retry/refresh)
       └─ Account      (cars, one scheduler per car) — shared CapabilityMemory
```

The per-account half of today's `index.ts` (`start`, `connect`, `failed`, `failOnce`, retry state) moves into `Connection`. `index.ts` keeps what is global: status aggregate, polling info, `executeOrder` routing, the stale-device pass.

## Settings (config.ts)

- `ACCOUNT_SLOTS = [1, 2, 3]`; `slotKey(base, slot)` → `base` for slot 1, `${base}_${slot}` otherwise.
- `readConfig(settings)` returns `{ shared: {locale, country, keys, homeRadiusM}, accounts: AccountSlot[] }`, `AccountSlot = { slot, label, email, password }`, only complete slots; partially filled slots are reported separately so the plugin can warn once.
- `SETTINGS_SCHEMA` (and `manifest.json`, kept in sync as today): `email`, `password`, `account_label`, `email_2`, `password_2`, `account_label_2`, `email_3`, `password_3`, `account_label_3`, then the shared `locale`, `home_radius_m`, `gigya_api_key`, `kamereon_api_key`. Only slot 1's pair is not required in the manifest sense beyond today's flags; `isConfigured` is "any complete slot".
- `loginTokenKey(slot)`: `integration.renault.login_token[_N]`. `CAPABILITIES_KEY` unchanged.

## Connection

`Connection` takes `{ slot, label, config, deps, http, memory, onChange }` and exposes `start()`, `stop()`, `state` (`connected | disconnected | error`), `lastDiscovery` (set of source ids, or null), `vehicle(sourceId)`, `refreshBatteries()`, `size`. It owns the retry/backoff and the `failOnce` de-duplication per slot. It reports `onChange` to the plugin, which recomputes the aggregate (FR6) and emits the integration events.

`Account` is unchanged except `discover()` no longer calls `removeStaleDevices`: it returns the set of source ids it saw (and still throws on failure). `AccountContext.onHealth` stays per connection.

## Stale cleanup (FR8)

After any `discover()` success, the plugin checks `connections.every(c => c.lastDiscovery)`; if so it calls `deviceManager.removeStaleDevices(integrationId, union)`; otherwise it does nothing. `lastDiscovery` is reset to `null` when a connection starts (so a restart is a new round), and kept after a success until the next one.

## Duplicate car (FR9)

The plugin gives `Account` an `isOwned(sourceId)` callback backed by earlier connections in slot order; a car owned elsewhere is skipped with one info log. (Discovery runs per connection concurrently, so ownership is "first connection that registered it", which in slot order is deterministic enough for a rare case; the loser only logs.)

## Orders

`executeOrder(device, …)` asks each connection `vehicle(device.sourceDeviceId)` and uses the first hit; none → `this vehicle is not connected`.

## Alarms

`alarmId = slot === 1 ? "renault.two-factor" : \`renault.two-factor.${slot}\``; raised/resolved per `Connection` through a callback.

## Files

| File                            | Change                                                         |
| ------------------------------- | -------------------------------------------------------------- |
| `src/config.ts`                 | slots, `readConfig` shape, schema, `loginTokenKey`             |
| `src/connection.ts`             | new — per-account lifecycle                                    |
| `src/account.ts`                | `discover()` returns the seen set; no stale removal; `isOwned` |
| `src/index.ts`                  | aggregate over connections, routing, stale pass                |
| `manifest.json`, `package.json` | settings, version 0.2.0                                        |
| `README.md`, `CHANGELOG.md`     | multi-account section                                          |

# Spec 001 — Architecture

```
TypeScript, Node 24 fetch (no runtime dependency)

RenaultPlugin (src/index.ts)                 settings, lifecycle, status, executeOrder routing, alarms
  └─ Account (src/account.ts)                discovery every 24 h, one Vehicle per car, scheduler
       ├─ Session (src/api/session.ts)       Gigya login / login token / JWT refresh — the only holder of secrets
       ├─ Kamereon (src/api/kamereon.ts)     GET/POST with headers, error decoding → KamereonError(kind)
       │     └─ RateLimiter (src/api/rate.ts) one at a time, 40 / rolling hour, 15 min pause on overloaded
       └─ Vehicle (src/vehicle.ts)           polls per endpoint, capability memory, contract mapping, orders
             └─ mapping (src/mapping.ts)     pure: Renault payloads → contract values (charging_state, at_home…)
```

- **Pure first**: `mapping.ts` (status codes → `charging_state`, plug fallback, ISO normalisation, haversine `at_home`), `models.ts` (capability table by model code), `errors.ts` (Gigya / Kamereon error → kind). Tested without the network.
- **HTTP behind an interface** (`Http` = `fetch`-like); tests inject a fake that replays recorded responses (secrets, VIN, coordinates scrubbed).
- **Secrets**: only `Session` sees the password, login token and JWT; errors leaving it are rebuilt from codes, never from bodies; a `redact()` strips the VIN to its last four characters in every log context.

## Settings (`integration.renault.*`)

| Key                | Type       | Notes                                                   |
| ------------------ | ---------- | ------------------------------------------------------- |
| `email`            | text       | required                                                |
| `password`         | password   | required                                                |
| `locale`           | text       | default `fr_FR` (Gigya/Kamereon keys and `country`)     |
| `gigya_api_key`    | text       | optional override                                       |
| `kamereon_api_key` | text       | optional override                                       |
| `home_radius_m`    | number     | default 200                                             |
| `login_token`      | (internal) | written by the plugin, not in the schema; never logged  |
| `capabilities`     | (internal) | JSON `{ vinSuffix: { endpoint: "forbidden" \| "ok" } }` |

The plugin writes only under its own namespace (spec 111 allows it).

## Device

Source id (and default name): model label + the VIN's last four characters (`Rafale 3061`); the VIN itself is used in request paths only. `manufacturer: "Renault"`, `model`: model label, `powerSource: "mains"`.

| Key              | Type    | Category            | Unit | From                                    |
| ---------------- | ------- | ------------------- | ---- | --------------------------------------- |
| `battery_level`  | number  | `ev_battery_level`  | %    | battery-status `batteryLevel`           |
| `range`          | number  | `ev_range`          | km   | `batteryAutonomy`                       |
| `plugged`        | boolean | `ev_plugged`        |      | `plugStatus`                            |
| `charging_state` | enum    | `ev_charging_state` |      | mapping                                 |
| `reported_at`    | string  | `ev_reported_at`    |      | `timestamp`                             |
| `at_home`        | boolean | `ev_at_home`        |      | location + home position                |
| `mileage`        | number  | `ev_mileage`        | km   | cockpit `totalMileage`                  |
| `charge_limit`   | number  | `ev_charge_limit`   | %    | soc-levels `socTarget` (when available) |
| `fuel_range`     | number  | `generic`           | km   | cockpit `fuelAutonomy` (PHEV)           |
| `fuel_quantity`  | number  | `generic`           | L    | cockpit `fuelQuantity` (PHEV)           |

| Order          | Type    | Category              | Notes                           |
| -------------- | ------- | --------------------- | ------------------------------- |
| `wake`         | boolean | `ev_wake`             | value ignored (momentary)       |
| `charge_start` | boolean | `ev_charge_start`     | per capability                  |
| `charge_limit` | number  | `set_ev_charge_limit` | min 55, max 100; per capability |

Keys equal the contract aliases on purpose: the core binds by category anyway, and the alias fallback then agrees.

## Scheduling

A single queue per account; each Vehicle registers jobs (`battery` 10 min, `cockpit` 60 min, `location` 60 min, `soc` at start). The limiter grants one call at a time within 40 per rolling hour; with two cars that is 12 + 2 + 2 = 16 calls/hour, leaving room for orders and retries. Discovery runs on start and every 24 h.

## Capability table (`models.ts`)

| Model code | Car           | `charge_start`               | `wake` | soc-levels                         |
| ---------- | ------------- | ---------------------------- | ------ | ---------------------------------- |
| `XHN1CP`   | Rafale (PHEV) | none (forbidden, measured)   | lights | read: yes (measured); write: probe |
| `XCB1VE`   | Megane E-Tech | KCM `charge/start`           | lights | yes                                |
| other      | —             | KCA `charging-start` (probe) | lights | probe                              |

A `forbidden` / `notFound` answer updates the remembered capabilities and re-declares the device without the order or point.

## File changes

`src/index.ts`, `src/config.ts`, `src/account.ts`, `src/vehicle.ts`, `src/mapping.ts`, `src/models.ts`, `src/api/{session,kamereon,rate,errors,http}.ts`, `src/__fixtures__/*.json` (recorded, scrubbed), tests next to each module, `manifest.json` settings, README.

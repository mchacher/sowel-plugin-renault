# Sowel plugin: renault

Renault cars in [Sowel](https://docs.sowel.org), through the **MyRenault cloud** (the private API the official app uses). One account, any number of cars, each published as an **electric vehicle** (core spec 183): battery level, electric range, plugged and charging state, the time of the car's last report, at home or not, mileage, charge limit — and a **wake** order that lets a charging recipe resume a charge the car paused by falling asleep.

## Setup

In Sowel, **Integrations → Renault**: your MyRenault e-mail and password. Optional: the account locale (`fr_FR`), the radius around Sowel's home position that counts as "at home" (200 m), and the Gigya / Kamereon keys, only if Renault rotates the ones shipped with the plugin.

The password is sent once; the plugin then keeps Renault's long-lived login token. Accounts that require two-factor authentication are not supported yet (the plugin says so and raises an alarm). When the integration shows `error`, the reason is in Sowel's logs (wrong e-mail or password, or a rotated Renault key).

## What each car publishes

| Point                         | Category            | Notes                                             |
| ----------------------------- | ------------------- | ------------------------------------------------- |
| `battery_level`               | `ev_battery_level`  | %                                                 |
| `range`                       | `ev_range`          | electric range, km                                |
| `plugged`                     | `ev_plugged`        |                                                   |
| `charging_state`              | `ev_charging_state` | unplugged, idle, scheduled, waiting, charging…    |
| `reported_at`                 | `ev_reported_at`    | the car's own report time — a sleeping car is old |
| `at_home`                     | `ev_at_home`        | needs Sowel's home position; no coordinate kept   |
| `mileage`                     | `ev_mileage`        | km                                                |
| `charge_limit`                | `ev_charge_limit`   | the car's charge target, %                        |
| `fuel_range`, `fuel_quantity` | `generic`           | plug-in hybrids                                   |

Orders: `wake` (a remote lights command — it wakes a sleeping car, measured on the Rafale), `charge_start` (where the model allows it; not on the Rafale), `charge_limit` (55–100 %, step 5).

Renault's cloud is polled within 40 requests per hour per account: battery every 10 min, mileage and position every hour. Reads return the car's last report; a sleeping car does not report.

## Development

```bash
npm install
npm run validate        # typecheck, lint, format, tests, build, specs index — what CI runs
```

Install on a Sowel instance through a personal source (core spec 136), or copy `manifest.json`, `package.json`, `dist/` and `node_modules/` into `plugins/renault/`.

Releases: tag `vX.Y.Z` on main; the workflow publishes `sowel-plugin-renault-X.Y.Z.tar.gz`. The registry in `mchacher/sowel` must then be bumped with the tarball's SHA256 (spec 089).

## Credits

The API knowledge comes from [hacf-fr/renault-api](https://github.com/hacf-fr/renault-api) (used by Home Assistant) and [evcc](https://github.com/evcc-io/evcc). Not affiliated with Renault.

## License

AGPL-3.0, like Sowel.

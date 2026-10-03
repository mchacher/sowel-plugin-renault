# Spec 001 — Plan

## Steps

- [ ] 1. Record and scrub fixtures from the owner's account (reads only): person, vehicles, battery-status, cockpit, hvac-status, location (coordinates replaced), and the `forbidden` body of charging-start.
- [ ] 2. Pure modules: `mapping.ts`, `models.ts`, `api/errors.ts` + tests.
- [ ] 3. `api/http.ts` interface, `api/rate.ts`, `api/session.ts`, `api/kamereon.ts` + tests with a fake HTTP.
- [ ] 4. `vehicle.ts`, `account.ts` (discovery, scheduler, capability memory) + tests with fake timers.
- [ ] 5. `index.ts`, `config.ts`, manifest settings, README.
- [ ] 6. Live check on the owner's account: login, publish the Rafale, `wake` on the sleeping car with the charge resuming on the dé charger (owner's agreement for the action).

## Test plan

| Module     | Scenario                                                                                      | Expected                                                            |
| ---------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `mapping`  | Each `chargingStatus` × `plugStatus` case of the table                                        | the documented `charging_state`                                     |
| `mapping`  | `plugStatus` missing, `chargingStatus` 0.3                                                    | plugged true                                                        |
| `mapping`  | Timestamp with offset / with `Z`                                                              | ISO UTC                                                             |
| `mapping`  | Location 150 m / 350 m from home, radius 200                                                  | at_home true / false; coordinates absent from the result            |
| `mapping`  | No home position                                                                              | at_home absent                                                      |
| `models`   | XHN1CP / XCB1VE / unknown                                                                     | orders per the capability table                                     |
| `errors`   | Gigya 403042, 403101, 403005; Kamereon forbidden, notFound, unauthorized, overloaded, privacy | the right kind                                                      |
| `session`  | Login with password → login token stored                                                      | `accounts.login` once, token persisted, JWT obtained                |
| `session`  | Restart with a stored login token                                                             | no `accounts.login`; `getJWT` only                                  |
| `session`  | JWT at exp − 30 s                                                                             | refreshed before the request                                        |
| `session`  | getJWT → 403005                                                                               | token dropped, login with password                                  |
| `session`  | 403101                                                                                        | `TwoFactorRequired` raised, no retry                                |
| `kamereon` | unauthorized once                                                                             | JWT refreshed, request retried once                                 |
| `rate`     | 41st request in the hour                                                                      | waits until the oldest leaves the window                            |
| `rate`     | overloaded                                                                                    | all requests paused 15 min                                          |
| `vehicle`  | Battery poll                                                                                  | `updateDeviceData` with the contract keys; reported_at from the car |
| `vehicle`  | `wake`                                                                                        | lights action sent; battery re-read 60 s later                      |
| `vehicle`  | `charge_start` → forbidden                                                                    | rejects with the readable reason; order removed and remembered      |
| `vehicle`  | `charge_limit` order 83                                                                       | POST `{socMin: current, socTarget: 85}`                             |
| `account`  | Vehicles list with a petrol car and a PHEV                                                    | only the PHEV published                                             |
| `account`  | Car removed from the account                                                                  | stale device removed                                                |
| `index`    | **Secrets never leak**: every path with sentinel password, token, VIN, coordinates            | none in logs, values, errors                                        |

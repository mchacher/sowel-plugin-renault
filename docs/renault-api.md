# The MyRenault API — reference for this plugin

Research brief written on 2026-10-03 from the source code of [hacf-fr/renault-api](https://github.com/hacf-fr/renault-api) `main` @ affe3d1 (**RA**, the library Home Assistant uses), [evcc](https://github.com/evcc-io/evcc) `master` @ 007582d (**EV**, `vehicle/renault/`), and Home Assistant core `dev` @ 73f53f7 (**HA**, `components/renault/`), plus the issues cited. Measurements on the owner's account are marked **[measured]**.

This is a private, undocumented API. Everything here can change without notice; the plugin is built to survive that (see Risks).

## Base URLs and keys

The keys below are public constants shipped by RA and evcc (they identify the app, not a user). They have changed before (RA #2098, May 2026), so the plugin ships them as defaults that settings can override.

| What                                               | Value                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Gigya (EU)                                         | `https://accounts.eu1.gigya.com`                                                           |
| Gigya API key (fr_FR and EU locales, except fr_LU) | `3_VgdkgtIRH3AdHvJm-cjV2ug2EFE0lxt0IJzMC4MFqZjFpn_GYFXVdNZ19L7wZX0N` **[measured: works]** |
| Kamereon (EU)                                      | `https://api-wired-prod-1-euw1.wrd-aws.com`                                                |
| Kamereon API key                                   | `YjkKtHmGfaceeuExUDKGxrLZGGvtVS0J`                                                         |

The remote key file RA and evcc fall back on (`…myrapp-one.s3…/configuration/android/config_<locale>.json`) returned HTTP 403 on 2026-10-03.

## Authentication

1. `POST {gigya}/accounts.login` — form `ApiKey`, `loginID`, `password` → `sessionInfo.cookieValue` = **login token** (long-lived; HA persists it instead of the password since 2026.6).
2. `POST {gigya}/accounts.getAccountInfo` — `ApiKey`, `login_token` → `data.personId`.
3. `POST {gigya}/accounts.getJWT` — `ApiKey`, `login_token`, `fields=data.personId,data.gigyaDataCenter`, `expiration=900` → `id_token` (JWT, 15 min).

Refresh: decode `exp` (no signature check), treat as expired 60 s early, call `getJWT` again with the login token. On `403005` / `403013` drop the login token and log in again.

Kamereon headers: `Content-type: application/vnd.api+json`, `apikey: <kamereon key>`, `x-gigya-id_token: <JWT>`; query `?country=FR`.

### Errors

| Code                                    | Meaning                                                          |
| --------------------------------------- | ---------------------------------------------------------------- |
| Gigya `403042`                          | Invalid login or password — also seen when the API key drifted   |
| Gigya `403101`                          | Two-factor authentication pending (body carries a `regToken`)    |
| `err.func.wired.unauthorized`           | JWT expired/revoked — or throttling (HA core #161228, inference) |
| `err.func.wired.forbidden`              | Endpoint not allowed for this model                              |
| `err.func.wired.notFound` / `not-found` | No data for this car                                             |
| `err.func.wired.overloaded`             | Quota exceeded                                                   |
| `err.func.privacy.on`                   | Privacy mode on in the car                                       |
| `err.tech.500`, `err.tech.501`          | Upstream failure / not supported                                 |

**Two-factor authentication** (RA #2132, open; enforced on some accounts since 2026-06): no library supports it yet. An open PR (RA #2257) implements the e-mail code flow (`webSdkBootstrap` → `tfa.initTFA` → `tfa.email.getEmails` → `sendVerificationCode` → `completeVerification` → `finalizeTFA` → `login` again, keeping the gmid/ucid device context). Not needed on the owner's account **[measured: plain login works]**.

## Discovery

- `GET {kam}/commerce/v1/persons/{personId}?country=FR` → `accounts[]` — keep `accountType == "MYRENAULT"`.
- `GET {kam}/commerce/v1/accounts/{accountId}/vehicles?country=FR` → `vehicleLinks[]{vin, status, vehicleDetails{model{code,label}, energy{code}, engineEnergyType}}`. Electric if `engineEnergyType` (else `energy.code`) is `ELEC`, `ELECX` or `PHEV`; skip links without details.

## Reads

Prefix: `{kam}/commerce/v1/accounts/{accountId}/kamereon`. Reads return the car's **last report** (look at its timestamp); they never wake it.

| Data         | Path                                            | Fields used                                                                                                  |
| ------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Battery      | `/kca/car-adapter/v2/cars/{vin}/battery-status` | `timestamp`, `batteryLevel`, `batteryAutonomy` (km), `plugStatus`, `chargingStatus`, `chargingRemainingTime` |
| Cockpit      | `/kca/car-adapter/v1/cars/{vin}/cockpit`        | `totalMileage`, `fuelAutonomy`, `fuelQuantity`                                                               |
| HVAC         | `/kca/car-adapter/v1/cars/{vin}/hvac-status`    | `hvacStatus`, `socThreshold`, `lastUpdateTime`                                                               |
| Location     | `/kca/car-adapter/v1/cars/{vin}/location`       | `gpsLatitude`, `gpsLongitude`, `lastUpdateTime` — for `at_home` only                                         |
| Charge limit | `/kcm/v1/vehicles/{vin}/ev/soc-levels`          | `socMin`, `socTarget`, `lastEnergyUpdateTimestamp` (not wrapped in `data`)                                   |

`chargingStatus`: 0.0 not charging · 0.1 waiting for a planned charge · 0.2 charge ended · 0.3 waiting for current · 0.4 energy flap open · 1.0 charging · −1.0 error (ZE50) / not charging (older) · −1.1 unavailable · −1.3…−1.6 V2G/V2L. `plugStatus`: 0 unplugged, 1 plugged, −1 plug error.

## Actions

| Action                            | Path                                                    | Body                                                                                    |
| --------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Lights / horn                     | `/kca/car-adapter/v1/cars/{vin}/actions/horn-lights`    | `{"data":{"type":"HornLights","attributes":{"action":"start","target":"lights"}}}`      |
| Charge start (KCA)                | `/kca/car-adapter/v1/cars/{vin}/actions/charging-start` | `{"data":{"type":"ChargingStart","attributes":{"action":"start"}}}`                     |
| Charge start (KCM, Megane E-Tech) | `/kcm/v1/vehicles/{vin}/charge/start`                   | same body                                                                               |
| Pause / resume (KCM)              | `/kcm/v1/vehicles/{vin}/charge/pause-resume`            | `{"data":{"type":"ChargePauseResume","attributes":{"action":"resume"}}}`                |
| Set charge limit                  | `/kcm/v1/vehicles/{vin}/ev/soc-levels` (POST)           | raw `{"socMin":20,"socTarget":80}` — both required; target 55–100, step 5; asynchronous |
| HVAC                              | `/kca/car-adapter/v1/cars/{vin}/actions/hvac-start`     | `{"data":{"type":"HvacStart","attributes":{"action":"start","targetTemperature":21}}}`  |

**Never**: evcc's "MY24" wake (POST `ev/settings` with a hard-coded schedule) and RA's `kcm-settings` charge start both overwrite the user's charge schedule.

## Measured on the owner's Rafale (XHN1CP, plug-in hybrid)

- **[measured]** Login with the fr_FR key above; battery-status, cockpit, hvac-status, location answer; charge-mode `forbidden`; lock-status and res-state `notFound`.
- **[measured]** `charging-start` → `err.func.wired.forbidden` (refused by the server, whatever the car's state).
- **[measured]** The car sleeps minutes after a paused charge; a charger restart or a 20 s mains cut does not wake it; **the lights action wakes it** (the lights do not flash) and the charge resumed 13 s later. The horn wakes it too.
- **[measured]** `hvac-status.socThreshold` = 10 (HVAC refused below 10 % battery).
- Unknown: whether `soc-levels` answers on XHN1CP (not documented in RA).

## Contract mapping (core spec 183)

| Sowel point        | Renault source                                                                                                                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `battery_level`    | `battery-status.batteryLevel`                                                                                                                                                                                              |
| `range`            | `battery-status.batteryAutonomy`                                                                                                                                                                                           |
| `plugged`          | `plugStatus == 1` (fallback on `chargingStatus` when unknown)                                                                                                                                                              |
| `charging_state`   | plugStatus −1 → error · 0 or chargingStatus 0.4 → unplugged · 1.0/−1.6 → charging · 0.2 → completed · 0.1 → scheduled · 0.3/−1.3 → waiting · −1.0 plugged → error · 0.0/−1.4/−1.5 plugged → idle · −1.1/unknown → previous |
| `reported_at`      | `battery-status.timestamp`, normalised to ISO UTC                                                                                                                                                                          |
| `at_home`          | distance(location, home.latitude/longitude) < a radius; coordinates discarded                                                                                                                                              |
| `mileage`          | `cockpit.totalMileage`                                                                                                                                                                                                     |
| `charge_limit`     | `soc-levels.socTarget` (absent when forbidden)                                                                                                                                                                             |
| `wake`             | lights action (Rafale); per-model strategy                                                                                                                                                                                 |
| `charge_start`     | KCA or KCM per model; absent when forbidden                                                                                                                                                                                |
| `set_charge_limit` | POST soc-levels keeping `socMin`                                                                                                                                                                                           |

## Rate budget

HA: 60 calls/hour per account, one at a time, 15 min pause on `overloaded`; users report bursts of `unauthorized` since late 2025 when polling too fast (HA core #161228, workaround ~43/hour). evcc caches 15 min. Plan for ~40 calls/hour: battery every 5–10 min, cockpit/location every 30–60 min, soc-levels on start and after a write.

# Changelog

All notable changes to this plugin. Versions follow semver; the registry in `mchacher/sowel` carries the SHA256 of each released tarball.

## Unreleased (v0.2.0)

**Several MyRenault accounts** — spec 002. Renault ties a car to one login, so a second car in the household needs its own.

- **Up to three accounts**, as numbered slots in the settings (`E-mail MyRenault 2`, `Mot de passe MyRenault 2`, an optional account name). Slot 1 is the account you already have: nothing to change, nothing re-logged.
- **Independent accounts**: each has its own session, request budget (40 per hour) and retry. A wrong password or two-factor on one never stops, hides or removes the cars of another; the two-factor alarm names the account.
- **Status**: connected as soon as one account is; error only when all are.
- **Cars that left an account** are removed only once every account has answered, so an account that is down at startup never costs you its devices. Emptying a slot removes its cars at the next complete discovery.

## v0.1.0

First release. **Renault cars in Sowel through the MyRenault cloud**, each published as an electric vehicle (core spec 183) — spec 001, checked live on a Renault Rafale plug-in hybrid.

- **What you get**: battery level, electric range, plugged and charging state, the car's own report time, at home (no coordinate kept), mileage, the car's charge limit, and a plug-in hybrid's fuel range and quantity as extras.
- **Orders**: `wake` (a remote lights command — it wakes a sleeping car so a paused charge resumes; measured on the Rafale), `refresh` (read the car's latest report now, core spec 184), `charge_limit` (55–100 %, step 5), and `charge_start` on the models that allow it (not the Rafale).
- **Within Renault's budget**: one request at a time, at most 40 per hour per account; battery every 10 minutes, mileage and position every hour. Declared as a polling integration, so Sowel waits for the car's next report before calling an order unconfirmed.
- **Setup**: your MyRenault e-mail and password; the plugin then keeps Renault's login token. Accounts requiring two-factor authentication are not supported yet (reported, with an alarm).
- **Privacy**: no password, token, full VIN or GPS coordinate in any log, value or error.

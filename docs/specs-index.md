# Specs index — sowel-plugin-renault

Every feature ever specified in this repository, one row each, newest last. A
CI check (`scripts/check-specs-index.sh`) fails a pull request that creates a
`specs/NNN-name/` folder without its row here.

Status: 📝 Draft · 🚧 In progress · ✅ Shipped

| #   | Title                                                     | Status | Summary                                                                                                                                                                                                                                                                                                                                                                          |
| --- | --------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 001 | MyRenault account, cars as electric vehicles, remote wake | 📝     | One MyRenault account (Gigya login token, JWT refresh, key overrides, 2FA detected), its electric and plug-in hybrid cars published with the core spec 183 contract, polled within a 40 calls/hour budget, `wake` by the lights action (measured on the Rafale), `charge_start` and `set_charge_limit` where the model allows. No secret, full VIN or coordinate ever published. |

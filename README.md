# Sowel plugin: renault

Renault cars in [Sowel](https://docs.sowel.org), through the **MyRenault cloud** (the private API the official app uses). One account, any number of cars, each published as an **electric vehicle** (core spec 183): battery level, electric range, plugged and charging state, the time of the car's last report, at home or not, mileage, charge limit — and a **wake** order that lets a charging recipe resume a charge the car paused by falling asleep.

## Status

Skeleton: the plugin starts, stops and reports its status. The account, the cars and the wake order arrive with spec 001.

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

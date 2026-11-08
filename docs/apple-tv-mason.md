# Apple TV builds on request

Mason's `tvos` workflow creates a signed, standalone Release IPA and publishes
it under `app.teamstation.tv`. It runs only when explicitly requested, including
on `master` and `develop`. Pushes and branch polling continue to run the existing
mobile `build` workflow; they do not build Apple TV.

Send an authenticated request to the Mason server's `POST /api/v2/runs` endpoint:

```json
{
  "project": "teamstation",
  "branch": "develop",
  "workflow": "tvos"
}
```

Use `"branch": "master"` for a production build. With the default parameters,
master targets production and other branches target the standing develop server.
To target a numbered development seat instead, add `"params": { "seat": "2" }`
(seats 1–8 are accepted). The selected server is embedded in the native build.
The workflow must exist on the requested branch; merging it into develop does
not add it to master until that change is promoted.

The archive installs the root and Apple TV dependencies, installs the tvOS pods,
and archives the `TeamStationTV` scheme with tvOS ad hoc signing. Mason must have
the `app.teamstation.tv` app registered for tvOS and the target Apple TVs registered
with the signing account. The run publishes the IPA and saves its debug symbols.
The resulting app runs without Metro. This workflow does not upload to TestFlight
or install the app on a TV.

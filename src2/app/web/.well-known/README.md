# Proving the domain owns the app

Apple and Google decide whether a link may open an app by **fetching a file from
the domain over HTTPS**. These are those files, and they ship inside `dist` so a
deploy cannot lose them — the versions directory is replaced wholesale, and a
copy placed on the box by hand is one deploy from gone.

Neither platform follows a redirect on the way here, so the host in the e-mail
must be the host that serves these. Caddy has to answer `/.well-known/*` **before**
the single-page fallback, and as `application/json`: `apple-app-site-association`
has no extension, so a file server guesses `application/octet-stream`, and the
SPA fallback would hand back `index.html` — which Apple fetches, finds is not
JSON, and quietly declines.

Both files are placeholders until the phone app exists: `TEAMID` is the Apple
team prefix, and `sha256_cert_fingerprints` wants the release and debug signing
fingerprints. The domain half is worth serving now anyway — it is correct long
before there is an app to open, and it means no e-mail has to be reissued the
day there is one.

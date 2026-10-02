# TS Distributor REST API

TS Distributor serves JSON over HTTP/1.1 on `http://127.0.0.1:8771` from launch until it quits
(`Packages/DistributorAPI`, answered by `App/APIAdapter.swift`). It is bound to loopback, so only
this Mac can reach it, and there are no tokens. `-apiPort <n>` moves it; a debug build launched
with `-harness -noIPad` never touches the cable, which is the way to try the API while an iPad is
plugged in.

`GET /api/v1` lists every route with a line on what it does; start there.

## Conventions

- Dates are ISO 8601 in UTC. A field with no value is left out, not sent as `null`.
- A recording's files are named by **track**: `primary`, or `camera:<source id>`. Wherever a track
  is asked for, a camera's name (`home`, `camera:home`) works too.
- Errors are `{"error": "<code>", "message": "<what to do>"}` with the status:

| Status | Codes | Means |
|---|---|---|
| 400 | `badRequest`, `confirmRequired` | The request is wrong; the message says what |
| 404 | `notFound` | No such recording, run or route |
| 405 | `methodNotAllowed` | The path exists, but not with that method |
| 409 | `runInProgress` | One run at a time; the message names the one under way |
| 412 | `iPadNotAttached`, `noDestination`, `notOnMac`, `teamStationSignedOut` | Something has to happen first; the message says what |
| 423 | `directorBusy` | TS Director is recording or streaming, and the run needs a file from it |
| 502 | `iPadFailed` | The iPad did not do what was asked |

## Routes

| Route | Answer |
|---|---|
| `GET /api/v1` | `APIIndex`: the routes and a paragraph about the API |
| `GET /api/v1/status` | `APIStatus`: the iPad (`none`, `waitingForDirector`, `attached`, `failed`, with whether TS Director records or streams), the export folder, the run under way or the last one, and the TeamStation account (without its games — see `GET /api/v1/teamstation`) |
| `GET /api/v1/events` | The status as newline-delimited JSON (`APIEvent`), once on connecting and again each time it changes |
| `GET /api/v1/recordings` | `APIRecordingList`: the attached iPad's takes (`source: "iPad"`), else the last list seen from one (`source: "cache"`, with `savedAt`). Each take lists its files with `onMac` (`saved`, `interrupted`, `missing`), their paths, whether the iPad has already stitched them, and the combined video |
| `GET /api/v1/recordings/{id}` | One `APIRecording` |
| `GET /api/v1/recordings/{id}/still?track=&at=` | One JPEG (at most 640×360) from the iPad, `at` seconds in (default 10) |
| `DELETE /api/v1/recordings?ids=361,362&confirm=true` | `{deleted, refused}`: deletes takes on the iPad; the take being recorded is refused |
| `POST /api/v1/recordings/{id}/download` | 202 `APIRun`: the files onto this Mac, the Mac and the iPad stitching side by side. Body `{tracks?, reprocess?}` |
| `POST /api/v1/recordings/{id}/export` | 202 `APIRun`: the files, then the combined video if the settings make one, then uploads if the settings upload. Body `{tracks?, reprocess?, combined?, upload?}` overrides |
| `POST /api/v1/recordings/{id}/combined` | 202 `APIRun`: the combined video, fetching any file it needs. Body `{combined: {include?, audioCamera?}}` |
| `POST /api/v1/recordings/{id}/upload` | 202 `APIRun`: uploads files already on this Mac to a game on TeamStation; 412 `notOnMac` for one that is not. Body `{upload: {game, tracks?, title?}}`, where `game` is an id from `GET /api/v1/teamstation` |
| `POST /api/v1/runs` | 202 `APIRun` for exactly the `APIRunRequest` given: `{kind?, recording, tracks?, reprocess?, combined?, upload?}` |
| `GET /api/v1/runs/current` | The run under way, or the last one |
| `GET /api/v1/runs/{id}` | `APIRun`: each file, the combined video and each upload, with `state` (`queued`, `fetching`, `stitching`, `downloading`, `uploading`, `done`, `failed`), `fraction`, `detail` and `result` (the saved file, or the video's page) |
| `DELETE /api/v1/runs/{id}` | Cancels. Saved files stay; a cut-off download resumes next time |
| `GET /api/v1/settings` | `DistributorSettings`, as this Mac holds them |
| `PATCH /api/v1/settings` | `APISettingsPatch`: `destination`, `createCombined`; what is left out stays. Saved here and given to the iPad now or when it is next attached |
| `GET /api/v1/teamstation` | `APITeamStation`: `signedIn` or `signedOut`, the e-mail, and the games already played that an upload can name. Signing in is done in the app — it takes a code from an e-mail |

## Upload titles

`upload.title` is the title field of the upload sheet: the recording's date and a space
(`2026-09-13 `) unless given, then whatever describes the game. Each video's title is that plus
what it is: nothing for the primary output, the camera's name, or `combined`. That suffix is not
decoration — the library reads it to tell one angle of a take from another. Every file of a take
is placed at the recording's own start, so a take's angles line up however far apart they were
sent.

## Example

```bash
B=http://127.0.0.1:8771/api/v1
curl -s $B/status
curl -s $B/recordings | jq '.recordings[] | {id, startedAt, files: [.files[] | {name, onMac}]}'
run=$(curl -s -X POST $B/recordings/361/export -d '{"upload":{"game":"gam_..."}}' | jq -r .id)
curl -s $B/runs/$run | jq '{isFinished, files: [.files[] | {name, state, fraction}], uploads}'
curl -s -N $B/events            # follow along until the run says isFinished
```

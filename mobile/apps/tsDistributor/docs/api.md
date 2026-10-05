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
| 409 | `runInProgress` | One run at a time; the message names the one under way. Several recordings go in one run instead |
| 412 | `iPadNotAttached`, `noDestination`, `noGame`, `teamStationSignedOut` | Something has to happen first; the message says what |
| 423 | `directorBusy` | TS Director is recording or streaming, and the run needs a file from it |
| 502 | `iPadFailed` | The iPad did not do what was asked |

## Routes

| Route | Answer |
|---|---|
| `GET /api/v1` | `APIIndex`: the routes and a paragraph about the API |
| `GET /api/v1/status` | `APIStatus`: the iPad (`none`, `waitingForDirector`, `attached`, `failed`, with whether TS Director records or streams), the export folder, the run under way or the last one, and the TeamStation account (without its games — see `GET /api/v1/teamstation`) |
| `GET /api/v1/events` | The status as newline-delimited JSON (`APIEvent`), once on connecting and again each time it changes |
| `GET /api/v1/recordings` | `APIRecordingList`: the attached iPad's takes (`source: "iPad"`), else the last list seen from one (`source: "cache"`, with `savedAt`). Each take lists its files with `onMac` (`saved`, `interrupted`, `missing`), their paths, whether the iPad has already stitched them, whether their segments are kept here (`segmentsOnMac`, see [kept segments](#kept-segments)), the combined video, and `gameId` and `gameTitle`: the TeamStation game TS Director filed it under |
| `GET /api/v1/recordings/{id}` | One `APIRecording` |
| `GET /api/v1/recordings/{id}/still?track=&at=` | One JPEG (at most 640×360) from the iPad, `at` seconds in (default 10) |
| `DELETE /api/v1/recordings?ids=361,362&confirm=true` | `{deleted, refused}`: deletes takes on the iPad; the take being recorded is refused |
| `DELETE /api/v1/recordings/{id}/segments` | `{recording, removed, bytes}`: removes the segments [kept](#kept-segments) on this Mac for the take, and says how much room that gave back; 409 `segmentsInUse` while a run is exporting it. The saved files stay |
| `POST /api/v1/recordings/{id}/download` | 202 `APIRun`: the files onto this Mac — everything off the iPad first, then stitched here. Body `{tracks?, reprocess?}` |
| `POST /api/v1/recordings/{id}/export` | 202 `APIRun`: the files, then the combined video if the settings make one (see [the combined video](#the-combined-video)), then — with this Mac signed in and the take filed under a game — uploads to that game. Body `{tracks?, reprocess?, combined?, upload?}` overrides |
| `POST /api/v1/recordings/{id}/combined` | 202 `APIRun`: the combined video, fetching any file it needs. Body `{combined: {include?, audioCamera?}}` |
| `POST /api/v1/recordings/{id}/upload` | 202 `APIRun`: uploads to the take's game on TeamStation. A file it sends that is not on this Mac yet is fetched first, and a combined video that goes up and is not here is made first. Body `{upload?: {game?, tracks?, title?}, combined?}`; `game` (an id from `GET /api/v1/teamstation`) is needed only for a take TS Director filed under no game, or to send it somewhere else |
| `POST /api/v1/runs` | 202 `APIRun` for exactly the `APIRunRequest` given, of one recording or [several](#several-recordings-in-one-run): `{kind?, recording \| recordings \| takes, tracks?, reprocess?, combined?, upload?}`. `kind` is `custom` unless given |
| `GET /api/v1/runs/current` | The run under way, or the last one |
| `GET /api/v1/runs/{id}` | `APIRun`: `step` and `isDoneWithIPad` for the whole run, and in `takes`, for each recording, each file, the combined video and each upload, with `state` (`queued`, `fetching`, `fetched`, `stitching`, `downloading`, `uploading`, `finishing`, `done`, `failed`), `fraction`, `detail` and `result` (the saved file, or the video's page). `recording`, `folder`, `files`, `combined` and `uploads` repeat the first take's |
| `DELETE /api/v1/runs/{id}` | Cancels every recording of the run. Saved files stay; a cut-off download resumes next time |
| `GET /api/v1/settings` | `DistributorSettings`, as this Mac holds them |
| `PATCH /api/v1/settings` | `APISettingsPatch`: `destination`, `createCombined`, `upload: {choice: {primary?, cameras?, combined?}}` (the files an upload sends when a request does not list them); what is left out stays. Saved here and given to the iPad now or when it is next attached |
| `GET /api/v1/teamstation` | `APITeamStation`: `signedIn` or `signedOut`, the e-mail, and the games already played that an upload can name. Signing in is done in the app — it takes a code from an e-mail |

## Upload titles

`upload.title` is the title field of the upload sheet: the game's dated title as TS Director filed
the take (`2026-09-13 Mission Trails at Bandits`), or the recording's date and whatever describes
the game, unless given. Each video's title is that plus what it is: nothing for the primary output,
the camera's name, or `combined`. That suffix is not decoration — the library reads it to tell one
angle of a take from another. Every file of a take is placed at the recording's own start, so a
take's angles line up however far apart they were sent.

## A run's order

Every file a run needs comes off the iPad before anything else happens: the files asked for, the
ones its uploads send, and the ones its combined video is made from. TS Director is held off
recording and streaming only while they come off; then this Mac stitches the files and makes the
combined video, then the uploads go. None of that needs the iPad, so it can be unplugged once the
files are in (`isDoneWithIPad`) and the run carries on.

## Kept segments

A file is stitched on this Mac from the take's archive segments, which come off the iPad first.
They stay afterwards, in `<day>/.tsDistributor-segments/<recording>/`, one folder per file, laid
out as the iPad lays its own out (`index.sqlite` beside `Archives/`), so a file can be stitched
again — `reprocess: true`, or a saved file that went missing — with no iPad attached: nothing of
such a run needs the iPad, and it never asks TS Director to hold off recording. A cancelled run
keeps the segments of every file that was wholly off the iPad; a fetch cut short leaves nothing.
They take as much room as the files stitched from them, so remove a take's once its files are
right: `DELETE /api/v1/recordings/{id}/segments`.

## Several recordings in one run

A run takes one recording or several. Several go through each step together, so the iPad is
needed once however many there are: every file of every recording comes off the iPad under one
hold on TS Director (`step` `fetching`), and only then does this Mac stitch them all
(`stitching`), make the combined videos asked for (`combining`) and send the uploads
(`uploading`), each step taking the recordings in the order given. The whole run has to fit on
this Mac's disk before anything is written, since every recording's segments are here at once.

Name the recordings with one of:

- `recording`: one, as the routes under `/recordings/{id}` do;
- `recordings: [101, 102]`: several, each as the rest of the request says;
- `takes: [{recording, tracks?, combined?, upload?}]`: several, each with what it does differently
  from the rest of the request. A take's `tracks` and `combined` replace the request's; its
  `upload` replaces the request's field by field, so `{"upload": {"game": "gam_…"}}` sends that
  take to its own game with the files the request lists.

A request wrong about any recording (one not listed, named twice, a game not found) starts
nothing. The run reports each recording in `takes`, in the order given.

## The combined video

A combined video is made only when asked for:

| Run | Made when |
|---|---|
| `download` | Never |
| `custom` | `combined` is `true` or `{include?, audioCamera?}`; absent or `false`, never |
| `combined` | Always; that is what it is for (`false` answers 400) |
| `export` | `combined` is `true` or `{include?, audioCamera?}`, or, left out, the settings' `createCombined` is on |
| `upload` | It goes up and is not saved yet: `upload.tracks` lists `combined`, or, left out, the settings' `upload.choice.combined` is on |

`"combined": false` makes none whatever the settings say, for every kind; an upload of it then
answers 400. `PATCH /api/v1/settings {"createCombined": false, "upload": {"choice": {"combined": false}}}`
turns off both settings that pull one in.

## Example

```bash
B=http://127.0.0.1:8771/api/v1
curl -s $B/status
curl -s $B/recordings | jq '.recordings[] | {id, startedAt, files: [.files[] | {name, onMac}]}'
run=$(curl -s -X POST $B/recordings/361/upload | jq -r .id)   # to the game TS Director filed it under
curl -s $B/runs/$run | jq '{isFinished, files: [.files[] | {name, state, fraction}], uploads}'
curl -s -N $B/events            # follow along until the run says isFinished

# Four takes in one run, each to its own game, the primary output only, no combined video.
run=$(curl -s -X POST $B/runs -d '{
  "kind": "export", "combined": false, "upload": {"tracks": ["primary"]},
  "takes": [
    {"recording": 101, "upload": {"game": "gam_a"}}, {"recording": 102, "upload": {"game": "gam_b"}},
    {"recording": 103, "upload": {"game": "gam_c"}}, {"recording": 104, "upload": {"game": "gam_d"}}
  ]}' | jq -r .id)
curl -s $B/runs/$run | jq '{step, isDoneWithIPad, takes: [.takes[] | {recording, files: [.files[] | {name, state}], uploads: [.uploads[] | .state]}]}'
```

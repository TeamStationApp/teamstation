# Camera identity

## The problem

RTSP itself has no device identity. The VM33s do advertise on the LAN, just not as `_rtsp._tcp`.
They publish `_awx_service._tcp` (AuditoryWorks) with TXT `modelname=VM33_00D9D` (sticker serial)
and `wlanmac`. The unique id is `modelname` when present, otherwise the TXT MAC — never a MAC
read from iOS networking. The Bonjour instance name (`00D9D 3rd`) is the default display name.
SRV port 25644 is closed; media stays RTSP `:554`.

DHCP still moves addresses. Binding by unique id is what keeps the operator's name, the tile and
the archive on the same camera after a lease change. The IP is where the camera answers this
instant, shown under the name so the operator can check the tripod sticker. It is never who the
camera is.

## The model

Three types, in `DirectorSources/CameraIdentity.swift`, plus `CameraAdvertisement`:

| Type | Lifetime | What it is |
|---|---|---|
| `CameraEndpoint` | one session | Host, port and path RTSP answered on. Transient. Display only. |
| `CameraAdvertisement` | one session | TXT unique id, NearStream name, current host. |
| `CameraRecord` | forever | Named camera, keyed by UUID, with `hardwareID` (or CNAME). |
| `CameraBinding` | one session | This endpoint is that camera, and who decided so. |

The record is keyed by a UUID rather than by its name, because the name is a label the operator edits
mid-game. Were the name the key, every correction would orphan that camera's archive segments and
telemetry history.

`SourceID` — what the archive, the tiles and the telemetry are all keyed by — is the camera's
record UUID when NearStream TXT (`modelname`, else `wlanmac`) or RTSP `CNAME` has identified it.
Unidentified sockets get a process-local `session-` id so four farm ports stay four rows. That key
is not persisted and is not derived from the address.

## The rules

`CameraIdentityRules` is pure, so all of this is unit tested without a network or a simulator:

1. **Auto-match by unique id.** An endpoint whose paired advertisement's unique id (TXT
   `modelname`, else `wlanmac`, else Cameraman `uuid`) matches a record's `hardwareID` is bound to
   it, marked `autoByIdentity`.
2. **Auto-match by CNAME.** TS Cameraman (and any camera that presents an SDP/RTCP `CNAME`) is
   bound on that identifier, marked `autoByCNAME`. Address is never a match key.

`CameraIdentityRules.pair` decides which advertisement describes which endpoint:

- A **TS Cameraman** advertisement (TXT `uuid`) describes the endpoint whose CNAME is that uuid.
  Before a socket has said anything, it describes only the exact endpoint it announced (host, port
  and path). It never describes an endpoint because they share an address: a released lease goes to
  the next phone, and the last phone's advertisement would otherwise name it.
- A **NearStream** advertisement has nothing its sockets repeat, so it still pairs by its TXT `ip=`.

The subnet sweep asks every address about 554 (NearStream) and 8554 (TS Cameraman on both
platforms), and its `DESCRIBE` probe keeps a Cameraman's UUID CNAME, so a phone whose Bonjour never
reaches the iPad is still recognised by its record — name included — the moment the sweep finds it.
Only UUID-form CNAMEs are taken at sweep time: every VM33 sends the same firmware string
(`Hamedal Server/1.0 (…)`) as its CNAME, which identifies none of them.
3. **First sight adopts the advertised name.** A new unique id creates a record named from the
   Bonjour instance. Later TXT name changes do not overwrite an operator name.
4. **The operator wins.** A `manual` binding is never overridden by a later automatic match.
5. **Names are unique.** Naming a camera "Third Base" when that name is taken yields "Third Base 2".
6. **Choosing a camera that is in use swaps it.**
7. **Relocation follows unique id or CNAME.** A leftover IP is not a candidate. Until the camera
   advertises again, the row stays unbound.

## What the operator sees

Each row's name is the rename control: one tap opens an inline editor, and the keyboard's Done key
commits. A camera that has advertised is shown under that name with an `ID` badge as soon as it is
found. The operator can still rename it; that local name follows the unique id across IP changes. A
socket with no unique id is `Unnamed` until the operator names it or the camera advertises.

There is no menu for picking a different cached camera, and no "forget". Both existed for the days
when a row was keyed by address and two cameras that swapped DHCP leases each came up under the
other's name. An IP address is never a camera identifier now, so there is nothing for the operator
to correct by hand: the unique id and the CNAME follow the camera, and the automatic binding does
the rest. The `/bind-camera` and `/forget-camera` harness commands remain for tests.

The row shows `host:port` underneath the name. There is no IP badge: the address is not an identity.

## Where it lives

`CameraRegistry` owns the cache and the session's bindings. `AWXServiceBrowser` browses
`_awx_service._tcp`; `RTSPDiscovery` still confirms RTSP `:554` before a row is live.
Records persist in `UserDefaults` only when they have a hardened id (TXT or CNAME). Bindings do not.
Source-list enable state persists only for CameraRecord UUIDs, not for session or address keys.

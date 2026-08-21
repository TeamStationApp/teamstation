# Camera identity

## The problem

RTSP itself has no device identity. The VM33s do advertise on the LAN, just not as `_rtsp._tcp`.
They publish `_awx_service._tcp` (AuditoryWorks) with TXT `modelname=VM33_00D9D` (sticker serial)
and `wlanmac`. The unique id is `modelname` when present, otherwise the TXT MAC — never a MAC
read from iOS networking. The Bonjour instance name (`00D9D 3rd`) is the default display name.
SRV port 25644 is closed; media stays RTSP `:554`.

DHCP still moves addresses. Binding by unique id is what keeps the operator's name, the tile and
the archive on the same camera after a lease change.

## The model

Three types, in `DirectorSources/CameraIdentity.swift`, plus `CameraAdvertisement`:

| Type | Lifetime | What it is |
|---|---|---|
| `CameraEndpoint` | one session | Host, port and path RTSP answered on. Transient. |
| `CameraAdvertisement` | one session | TXT unique id, NearStream name, current host. |
| `CameraRecord` | forever | Named camera, keyed by UUID, with `hardwareID` and last host. |
| `CameraBinding` | one session | This endpoint is that camera, and who decided so. |

The record is keyed by a UUID rather than by its name, because the name is a label the operator edits
mid-game. Were the name the key, every correction would orphan that camera's archive segments and
telemetry history.

`SourceID` — what the archive, the tiles and the telemetry are all keyed by — is derived from the
binding: the camera's UUID when there is one, and the address when there is not. That is what makes a
camera keep its tile and keep writing to the same archive after moving to a new address.

## The rules

`CameraIdentityRules` is pure, so all of this is unit tested without a network or a simulator:

1. **Auto-match by unique id.** An endpoint whose TXT `modelname` (else `wlanmac`) matches a
   record's `hardwareID` is bound to it, marked `autoByIdentity`. This outranks address matching.
2. **Auto-match by address.** If there is no unique id, an endpoint whose host is a camera's
   `lastKnownHost` is bound, marked `autoByHost`.
3. **First sight adopts the advertised name.** A new unique id creates a record named from the
   Bonjour instance. Later TXT name changes do not overwrite an existing record.
4. **The operator wins.** A `manual` binding is never overridden by a later automatic match.
5. **Names are unique.** Naming a camera "Third Base" when that name is taken yields "Third Base 2".
6. **Choosing a camera that is in use swaps it.**
7. **Relocation by unique id is not a guess.** When TXT says this serial is now at a new host, the
   record moves with it. The old "exactly one free endpoint" rule remains for cameras that never
   advertised.

## What the operator sees

Each row names its camera through a menu. A camera that has advertised is shown under that name with
an `AUTO` badge as soon as it is found. The operator can still rename it; that local name follows the
unique id across IP changes.

The row shows the address underneath, and an `AUTO` or `MANUAL` badge saying how the app arrived at
the name.

## Where it lives

`CameraRegistry` owns the cache and the session's bindings. `AWXServiceBrowser` browses
`_awx_service._tcp`; `RTSPDiscovery` still confirms RTSP `:554` before a row is live.
Records persist in `UserDefaults`; bindings do not.

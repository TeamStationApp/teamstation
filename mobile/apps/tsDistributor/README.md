# TS Distributor

A macOS app that pulls TS Director's recordings off the iPad over a USB-C cable, splitting the
stitching between the Mac and the iPad, and stitching with the Director's own code.

- **Transport.** usbmuxd, the daemon every Mac runs for attached iPhones and iPads, opens a byte
  pipe to TS Director's loopback server on port 8770 (`tsDirector/Packages/DirectorLink`). A
  loopback forwarder (`Packages/UsbMux`) makes that answer on 127.0.0.1 here, so the app speaks
  plain HTTP to it: about 540 MB/s on one connection, 700 MB/s on three, measured on an M4 iPad
  Pro with `tools/usbmuxProbe`.
- **Protocol.** `Packages/DirectorClient` calls the routes and downloads files resumably; the
  message types are in `../common/DistributorWire`. The routes are listed in
  [docs/protocol.md](docs/protocol.md).
- **Stitching.** `../common/DirectorExport` is the same package TS Director exports with. The Mac
  takes the first file, the iPad the second, then whichever is free.
- **Combined video.** `Packages/CombinedVideo` puts up to four cameras on a 4K canvas as HEVC at
  4 Mb/s per camera, with one camera's sound.
- **TeamStation.** `../common/TeamStationKit` signs this Mac in and sends each file to one game,
  in parts, asking first what already landed so a cut-off upload carries on where it stopped. The
  same code TS Director uploads with, so both resume the same way.
- **Settings on both devices.** The Mac keeps its copy in
  `~/Library/Application Support/TS Distributor` (`Packages/MacState`); TS Director keeps the same
  on the iPad. They are brought together whenever the iPad is
  attached, each group from whichever side changed it last, so the Distributor works with the iPad
  away. Windows are not restored.
- **REST API.** `Packages/DistributorAPI` serves the Distributor's work as JSON on
  `127.0.0.1:8771`; see [docs/api.md](docs/api.md), and the `ts-distributor-api` skill for
  driving it from an agent.

## Using it

1. Open TS Director on the iPad and plug it into the Mac. TS Distributor finds it; the Director
   shows a MAC pill.
2. The gear at the top right opens Settings: the folder to save into (this Mac's own), whether the
   iPad shares the stitching ("Enable iPad Stitching", off by default, so the Mac stitches every
   file), whether to make a combined video, and TeamStation (an e-mail address, then the code it
   sends).
3. Pick a recording, tick its files, Export. With the combined video on, lay the cameras out first;
   then the game it belongs to and which of its files go up — or Export Without Uploading, which
   saves them and stops there. Each video is titled from the game, with the camera's name after it,
   because that is how the library tells one angle of a take from another.
4. Each file shows whether it is already on this Mac. Files already here need nothing from the iPad,
   so a cut-off export (an upload that failed, a combined video never made) can be picked up with
   Export even while TS Director records or streams; only fetching and stitching wait for the iPad.
   "Stitch again" makes every ticked file afresh from the recording, and the combined video with
   them, instead of using files already here or prepared on the iPad.

TS Director must be open and in front on the iPad: iOS takes a background app's listener down.
With no iPad the window says so; Settings, and files already on this Mac, still work.

## Build and test

```bash
scripts/build.sh        # regenerates Distributor.xcodeproj and builds TS Distributor.app
scripts/install.sh      # builds it for release and puts it in /Applications
scripts/package.sh      # builds it for release into a disk image for another Mac (~/Desktop)
scripts/test-unit.sh    # swift test for every package the app is built from
```

A debug build launched with `-harness -noIPad` never touches the cable: the way to see and drive
the no-iPad window, and the API, while an iPad is plugged in.

The plans are `~/.cursor/plans/202609131549-gsDistributor.md` and, for the API, the Mac's own
state, `~/.cursor/plans/202609142144-gsDistributorApiHighlights.md`. Highlights are no longer
part of this app; they went with PeerTube, which was the only place they could be written.

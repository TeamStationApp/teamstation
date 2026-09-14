# GS Distributor

A macOS app that pulls GS Director's recordings off the iPad over a USB-C cable, splitting the
stitching between the Mac and the iPad, and stitching with the Director's own code.

- **Transport.** usbmuxd, the daemon every Mac runs for attached iPhones and iPads, opens a byte
  pipe to GS Director's loopback server on port 8770 (`gsDirector/Packages/DirectorLink`). A
  loopback forwarder (`Packages/UsbMux`) makes that answer on 127.0.0.1 here, so the app speaks
  plain HTTP to it: about 540 MB/s on one connection, 700 MB/s on three, measured on an M4 iPad
  Pro with `tools/usbmuxProbe`.
- **Protocol.** `Packages/DirectorClient` calls the routes and downloads files resumably; the
  message types are in `../common/DistributorWire`. The routes are listed in
  [docs/protocol.md](docs/protocol.md).
- **Stitching.** `../common/DirectorExport` is the same package GS Director exports with. The Mac
  takes the first file, the iPad the second, then whichever is free.
- **Combined video.** `Packages/CombinedVideo` puts up to four cameras on a 4K canvas as HEVC at
  4 Mb/s per camera, with one camera's sound.
- **PeerTube.** `../common/PeerTubeKit` signs in (on the iPad, which keeps the tokens in its
  Keychain) and uploads (from the Mac, resumably, in 8 MiB chunks).
- **No state on the Mac.** Settings, layouts and the PeerTube sign-in live on the iPad. Windows are
  not restored.

## Using it

1. Open GS Director on the iPad and plug it into the Mac. GS Distributor finds it; the Director
   shows a MAC pill.
2. The gear at the top right opens Settings: the folder to save into (this Mac's own), whether to
   make a combined video, and PeerTube (instance host, then sign in).
3. Pick a recording, tick its files, Export. With the combined video on, lay the cameras out first;
   with PeerTube on, the title comes next (it starts with the date, which can be changed), with the
   channel and privacy, which start on the last ones used (privacy 6 where the instance has it).

GS Director must be open and in front on the iPad: iOS takes a background app's listener down.

## Build and test

```bash
scripts/build.sh        # regenerates Distributor.xcodeproj and builds GS Distributor.app
scripts/install.sh      # builds it for release and puts it in /Applications
scripts/test-unit.sh    # swift test for every package the app is built from
```

The plan is `~/.cursor/plans/202609131549-gsDistributor.md`.

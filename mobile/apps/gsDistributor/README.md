# GS Distributor

A macOS app that pulls GS Director's recordings off the iPad over a USB-C cable, splitting the
stitching between the Mac and the iPad, and stitching with the Director's own code.

- **Transport.** usbmuxd, the daemon every Mac runs for attached iPhones and iPads, opens a byte
  pipe to GS Director's loopback server on port 8770 (`gsDirector/Packages/DirectorLink`). A
  loopback forwarder (`Packages/UsbMux`) makes that answer on 127.0.0.1 here, so the app speaks
  plain HTTP to it: about 540 MB/s on one connection, 700 MB/s on three, measured on an M4 iPad
  Pro with `tools/usbmuxProbe`.
- **Protocol.** `Packages/DirectorClient` calls the routes and downloads files resumably; the
  message types are in `../common/DistributorWire`.
- **Stitching.** `../common/DirectorExport` is the same package GS Director exports with.
- **No state on the Mac.** Settings, layouts and the PeerTube sign-in live on the iPad. Windows are
  not restored.

GS Director must be open and in front on the iPad: iOS takes a background app's listener down.

## Build and test

```bash
scripts/build.sh        # regenerates Distributor.xcodeproj and builds GS Distributor.app
scripts/test-unit.sh    # swift test for every package the app is built from
```

The plan is `~/.cursor/plans/202609131549-gsDistributor.md`.

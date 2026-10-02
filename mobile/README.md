# TeamStation's native apps

Each app has its own README, build scripts and tests:

```
mobile/
  apps/
    common/               Swift packages shared by the apps
    tsCameraman/          TS Cameraman, iPhone
    tsCameramanAndroid/   TS Cameraman, Android
    tsDirector/           TS Director, iPad
    tsDistributor/        TS Distributor, Mac
    tsNdiProbe/           an NDI receive probe
    tsPreview/            TS Preview
  icons/                  the app icons' sources and their generator
  test/                   the maestro-d client the apps' e2e tests share
  tools/                  bench tools
```

`package.json` here is a workspace of the apps' scripts only; none of them
installs an npm dependency.

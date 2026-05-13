# GameStation's native apps

Each app has its own README, build scripts and tests:

```
mobile/
  apps/
    common/               Swift packages shared by the apps
    gsCameraman/          GS Cameraman, iPhone
    gsCameramanAndroid/   GS Cameraman, Android
    gsDirector/           GS Director, iPad
    gsDistributor/        GS Distributor, Mac
    gsNdiProbe/           an NDI receive probe
    gsPreview/            GS Preview
  icons/                  the app icons' sources and their generator
  test/                   the maestro-d client the apps' e2e tests share
  tools/                  bench tools
```

`package.json` here is a workspace of the apps' scripts only; none of them
installs an npm dependency.

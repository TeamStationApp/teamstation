pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "tsSpeedyAndroid"

include(":app")

// The TAG One radar and its Bluetooth link, shared with TS Cameraman and the TeamStation app.
include(":streamcore")
project(":streamcore").projectDir = file("../common/android/streamcore")

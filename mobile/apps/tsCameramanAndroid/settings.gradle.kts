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

rootProject.name = "tsCameramanAndroid"

include(":app")

// Capture, lens, encoder and radar code shared with the TeamStation app's phone streaming.
include(":streamcore")
project(":streamcore").projectDir = file("../common/android/streamcore")

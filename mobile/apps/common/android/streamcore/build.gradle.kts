// The media and radar code TS Cameraman and the TeamStation app's phone streaming share: Camera2
// capture and lens discovery, the GL renderer, MediaCodec encoders, adaptive bitrate and the radar
// link. Both builds include it as `:streamcore` with this directory as its projectDir.
//
// The plugins are applied by id with no versions: each including build supplies them (Cameraman's
// root plugins block, the React Native app's buildscript classpath). Coverage (Kover) is applied
// from Cameraman's root build, so the React Native build, which has none, configures this file as
// it stands.
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.teamstation.streamcore"
    compileSdk = 37

    defaultConfig {
        // Android 11. Anything newer the code calls is guarded with Build.VERSION.SDK_INT, and
        // lint's NewApi check below fails the build on a call that is not.
        minSdk = 30
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        // Robolectric's newest runtime is API 36; the tests name the levels they run at.
        targetSdk = 36
        unitTests {
            isReturnDefaultValues = true
            isIncludeAndroidResources = true
            all { test ->
                // The golden vectors TS Director's tests write, which the stream and recording ports
                // assert byte for byte.
                test.systemProperty("mediaFixtures", file("../../MediaFixtures").absolutePath)
                // The end-to-end runs (RtmpInteropTest, RecordingExportTest) are gated on these, and
                // must run again whenever they change rather than be skipped as up to date.
                listOf(
                    "TS_RTMP_INTEROP_URL", "TS_RTMP_INTEROP_MODE", "TS_RTMP_INTEROP_FIXTURE", "TS_RTMP_INTEROP_SECONDS",
                    "TS_RTMP_INTEROP_LOG", "TS_RECORDING_E2E_DIR"
                )
                    .forEach { name -> test.inputs.property(name, System.getenv(name) ?: "") }
            }
        }
    }

    lint {
        error += "NewApi"
        abortOnError = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    // RadarLink publishes its state as a StateFlow.
    api("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.16.1")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
}

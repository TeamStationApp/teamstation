import java.net.URI

/**
 * This app's own link host, from its gitignored clientConfig.json (the deployment repository's
 * `appLinks.mjs client cameraman` writes it): `appOrigin`, or empty without one.
 */
val appOrigin: String = run {
    val file = rootProject.file("clientConfig.json")
    if (!file.exists()) return@run ""
    @Suppress("UNCHECKED_CAST")
    val config = groovy.json.JsonSlurper().parse(file) as Map<String, Any?>
    (config["appOrigin"] as? String).orEmpty()
}
val appLinkHost: String = if (appOrigin.isEmpty()) "" else URI(appOrigin).host

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlinx.kover")
}

android {
    namespace = "app.teamstation.cameraman"
    compileSdk = 36
    buildToolsVersion = "36.0.0"
    ndkVersion = "27.1.12297006"

    defaultConfig {
        applicationId = "app.teamstation.cameraman"
        // Android 14. FOREGROUND_SERVICE_CAMERA and the typed-service rules that let this app keep
        // capturing in the background were introduced there, and the whole point of this build is
        // that it runs backgrounded.
        minSdk = 34
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"

        // Empty, the usual case, is app.teamstation.app. A special build sets
        // TS_PRIMARY_HOST=devhost3.example-ts.test and sign-in follows it.
        val primaryHost = (System.getenv("TS_PRIMARY_HOST") ?: "").trim().ifEmpty { "app.teamstation.app" }
        buildConfigField("String", "TS_PRIMARY_HOST", "\"${primaryHost.replace("\"", "")}\"")
        // The link host sign-in links are mailed to; empty asks for ordinary web links.
        buildConfigField("String", "TS_APP_ORIGIN", "\"${appOrigin.replace("\"", "")}\"")
        manifestPlaceholders["appLinkHost"] = appLinkHost

        // Where crashes are reported; empty, the usual local build, reports nothing.
        val sentryDsn = (System.getenv("TS_SENTRY_DSN") ?: "").trim()
        buildConfigField("String", "TS_SENTRY_DSN", "\"${sentryDsn.replace("\"", "")}\"")
        // The `sentryTest` launch extra works only in a build made for testing it
        // (TS_SENTRY_TESTS=1): the launcher activity is exported, and a shipped build must not
        // let another app crash it.
        buildConfigField("boolean", "TS_SENTRY_TESTS", (System.getenv("TS_SENTRY_TESTS") == "1").toString())

        // Only for the Pixel this ships to. The one native call is `SocketQueue`'s.
        ndk { abiFilters += listOf("arm64-v8a") }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    signingConfigs {
        // The release build is signed with the debug keystore, so `installRelease` works on a
        // handset without provisioning a release keystore for a match-day tool.
        getByName("debug") {
            storeFile = file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        getByName("debug") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    sourceSets {
        getByName("main") {
            java.srcDirs("src/main/kotlin")
        }
        getByName("test") {
            java.srcDirs("src/test/kotlin")
        }
    }

    testOptions {
        unitTests {
            isReturnDefaultValues = true
            isIncludeAndroidResources = true
        }
    }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2025.09.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.4")
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.security:security-crypto:1.1.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // Java and native (NDK) crash reporting.
    implementation("io.sentry:sentry-android:8.60.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
    testImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
    testImplementation("org.robolectric:robolectric:4.16.1")
}

// The sign-in link filter for the app's link host, added to every variant's manifests only when
// the build has one, so a build without config claims no https address.
androidComponents {
    onVariants { variant ->
        if (appLinkHost.isNotEmpty()) variant.sources.manifests.addStaticManifestFile("src/appLinks/AndroidManifest.xml")
    }
}

kover {
    reports {
        // The total report is the UI, radar and event-control suite's own 90% gate. The debug variant's report is
        // unfiltered: it is the JaCoCo XML that `COVERAGE=1 scripts/test-unit.sh` hands to the
        // repository's changed-line gate, which needs every class a branch might touch.
        total {
            filters {
                includes {
                    classes(
                        "app.teamstation.cameraman.ui.SettingsBody",
                        "app.teamstation.cameraman.ui.RadarSettingsCard",
                        "app.teamstation.cameraman.ui.RadarSettingsCardKt",
                        "app.teamstation.cameraman.ui.SpeedOverlay",
                        "app.teamstation.cameraman.ui.LoginFlow",
                        "app.teamstation.cameraman.radar.*",
                        "app.teamstation.cameraman.eventcontrol.*",
                        "app.teamstation.cameraman.scoreboard.SignInLink*",
                        "app.teamstation.cameraman.ui.SignInLinkToastKt"
                    )
                }
            }
            verify {
                rule {
                    minBound(90)
                }
            }
        }
    }
}

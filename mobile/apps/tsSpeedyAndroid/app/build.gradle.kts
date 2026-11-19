plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlinx.kover")
}

android {
    namespace = "app.teamstation.speedy"
    compileSdk = 37
    buildToolsVersion = "37.0.0"

    defaultConfig {
        applicationId = "app.teamstation.speedy"
        // Android 14, as TS Cameraman: Bluetooth's runtime permissions (API 31+) are all it asks for.
        minSdk = 34
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
    }

    signingConfigs {
        // Signed with the debug keystore, as TS Cameraman is; Mason re-signs the release APK.
        getByName("debug") {
            storeFile = file(System.getenv("TS_ANDROID_DEBUG_KEYSTORE") ?: "debug.keystore")
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
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    sourceSets {
        getByName("main") {
            java.srcDirs("src/main/kotlin")
            // The voice clips are TS Speedy for iOS's, played from the same files.
            assets.srcDirs("../../common/SpeedyVoice/Sources/SpeedyVoice/Clips")
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

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(project(":streamcore"))
    implementation(platform("androidx.compose:compose-bom:2025.09.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.material3:material3")
    // The gear and the speaker, as TS Cameraman draws its icons.
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.4")
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
    testImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
    testImplementation("org.robolectric:robolectric:4.16.1")
}

kover {
    reports {
        // The whole app is held to 90%. The debug report is also the JaCoCo XML that
        // `COVERAGE=1 scripts/test-unit.sh` hands to the repository's changed-line gate.
        total {
            filters {
                includes {
                    classes("app.teamstation.speedy.*")
                }
                excludes {
                    // Compose's generated singletons for lambdas hold no logic of their own.
                    classes("*ComposableSingletons*")
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

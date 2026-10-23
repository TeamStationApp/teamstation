package app.teamstation.cameraman.observability

import app.teamstation.cameraman.core.InMemoryIdentityStore
import app.teamstation.cameraman.engine.AppEnvironment
import app.teamstation.cameraman.harness.LaunchConfiguration
import app.teamstation.streamcore.core.InMemorySettingsStore
import app.teamstation.streamcore.core.StreamSettings
import java.net.ServerSocket
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class EnvironmentLogTest {
    @Test fun realRecordingAndListenerFailureProduceClosedEvents() = runBlocking {
        val context = RuntimeEnvironment.getApplication()
        val batches = mutableListOf<String>()
        val root = Files.createTempDirectory("record-log").toFile()
        AppLog.close()
        AppLog.start(context, "https://public@logs.example.test/1") { file, endpoint ->
            LogClient(file, endpoint) { synchronized(batches) { batches.add(it) }; 202 }
        }
        val occupied = ServerSocket(0)
        val environment = AppEnvironment(
            context, launch = LaunchConfiguration(advertise = false, persistSettings = false,
                settings = StreamSettings(audioEnabled = true, port = occupied.localPort)),
            store = InMemoryIdentityStore(), settingsStore = InMemorySettingsStore()
        )
        try {
            environment.setPermissions(false, true, false)
            environment.startRecording(root)
            environment.finishRecording()
            environment.setBroadcasting(true)
            val deadline = System.currentTimeMillis() + 3000
            while (environment.stateDump().getJSONObject("server").isNull("lastError") && System.currentTimeMillis() < deadline) Thread.sleep(20)
            AppLog.close()
            val text = batches.joinToString("")
            assertTrue(text.contains("recording_started"))
            assertTrue(text.contains("recording_stopped"))
            assertTrue(text.contains("stream_failed"))
            assertFalse(text.contains("Address already in use"))
        } finally {
            environment.setBroadcasting(false)
            environment.camera.close()
            occupied.close()
            AppLog.close()
            root.deleteRecursively()
        }
    }
}

package app.teamstation.cameraman.observability

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
class AppLogTest {
    @Test fun startupPartitionsStorageAndDrainsLifecycle() = runBlocking {
        AppLog.close()
        val batches = mutableListOf<String>()
        var calls = 0
        AppLog.start(RuntimeEnvironment.getApplication(), "https://public@logs.example.test/1") { file, endpoint ->
            calls++
            assertEquals("https://logs.example.test/ingest/1", endpoint)
            assertTrue(file.name.matches(Regex("[a-f0-9]{64}\\.jsonl")))
            LogClient(file, endpoint) { synchronized(batches) { batches.add(it) }; 202 }
        }
        AppLog.start(RuntimeEnvironment.getApplication(), "https://public@other.example.test/2") { _, _ -> error("Already started") }
        AppLog.close()
        assertEquals(1, calls)
        val rows = batches.joinToString("").lines().filter { it.isNotEmpty() }
        assertEquals(2, rows.size)
        assertTrue(rows[0].contains("service_started"))
        assertTrue(rows[1].contains("service_stopped"))
    }
    @Test fun endpointsRequirePublicHttpsRouting() {
        assertEquals("https://logs.example.test/ingest/12", LogEndpoint.from("https://public@logs.example.test/12"))
        for (raw in listOf("", "not a url", "http://key@example.test/1", "https://key:secret@example.test/1", "https://key@example.test/1?q=x", "https://key@example.test/1#x", "https://example.test/1", "https://key@example.test/path/1")) assertNull(LogEndpoint.from(raw))
    }
    @Test fun queueIsDrainedBeforeClosingAndDisabledStartupDoesNothing() = runBlocking {
        val root = Files.createTempDirectory("app-log").toFile()
        try {
            val text = StringBuilder()
            val client = LogClient(root.resolve("queue"), "https://logs.example.test/ingest/1") { text.append(it); 202 }
            client.record(LogRecord(LogKind.STARTED))
            client.record(LogRecord(LogKind.STREAM_FAILED, error = LogError.INTERNAL))
            client.close()
            assertEquals(2, text.lines().count { it.isNotEmpty() })
            assertTrue(text.startsWith("{\"D\":"))
            client.record(LogRecord(LogKind.STOPPED))
            AppLog.close()
            AppLog.start(RuntimeEnvironment.getApplication(), "")
            AppLog.record(LogKind.ERROR, error = LogError.UNKNOWN)
            AppLog.close()
        } finally { root.deleteRecursively() }
    }
}

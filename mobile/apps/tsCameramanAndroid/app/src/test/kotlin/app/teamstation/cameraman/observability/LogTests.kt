package app.teamstation.cameraman.observability

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.nio.file.Files
import java.time.Instant
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class LogTests {
    private val instant = Instant.parse("2026-01-01T12:00:00.000Z")
    private val id = UUID.fromString("00000000-0000-4000-8000-000000000001")
    private fun row(kind: LogKind = LogKind.STARTED) = LogRecord(kind, instant, id)
    private fun folder() = Files.createTempDirectory("log-test").toFile()
    private fun rejects(block: () -> Unit) { try { block(); fail("must reject") } catch (_: IllegalArgumentException) {} }

    @Test fun contract() {
        System.getenv("OBSERVABILITY_GOLDEN_PATH")?.let { path ->
            File(path).writeText(LogKind.entries.joinToString("") { row(it).jsonLine() })
        }
        for (kind in LogKind.entries) {
            val row = row(kind)
            assertTrue(row.jsonLine().startsWith("{\"D\":\"2026-01-01T12:00:00.000Z\","))
            assertEquals(1, row.jsonLine().count { it == '\n' })
            assertEquals(row, LogRecord.decode(row.jsonLine()))
            assertTrue(Charsets.UTF_8.encode(row.jsonLine()).remaining() < 4 * 1024)
        }
        for (op in LogOperation.entries) for (error in LogError.entries) {
            val row = LogRecord(LogKind.ERROR, instant, id, op, error, 12.0, 3)
            assertEquals(row, LogRecord.decode(row.jsonLine()))
        }
        val video = LogRecord(LogKind.RECORDING_STARTED, instant, id, video = "vid_demo")
        assertEquals(video, LogRecord.decode(video.jsonLine()))
        for (ms in listOf(-1.0, 15001.0, Double.NaN, Double.POSITIVE_INFINITY)) rejects { LogRecord(LogKind.ERROR, milliseconds = ms) }
        for (n in listOf(-1, 1_000_000_001)) rejects { LogRecord(LogKind.ERROR, count = n) }
        rejects { LogRecord(LogKind.ERROR, video = "vid_demo") }
        rejects { LogRecord(LogKind.RECORDING_STARTED, video = "private?token=chat") }
        rejects { LogRecord(LogKind.RECORDING_STARTED, operation = LogOperation.RECORD) }
        rejects { LogRecord(LogKind.RECORDING_STARTED, count = 1) }
        for ((key, value) in listOf("A" to "other", "R" to 2, "L" to "fatal")) {
            val text = JSONObject(row().jsonLine()).put(key, value).toString()
            rejects { LogRecord.decode(text) }
        }
        val dirty = JSONObject(row().jsonLine()).put("chat", "private-canary")
        dirty.getJSONObject("P").put("password", "secret-canary")
        assertFalse(LogRecord.decode(dirty.toString()).jsonLine().contains("canary"))
    }

    @Test fun queuePersistenceAndLimits() = runTest {
        val root = folder()
        try {
            val file = File(root, "sub/queue")
            val sent = mutableListOf<String>()
            var now = instant
            val queue = LogQueue(file, { now }, 1) { sent.add(it); 200 }
            queue.enqueue(row()); queue.enqueue(row())
            assertEquals(1, queue.count())
            queue.enqueue(row().copy(id = UUID.randomUUID()))
            assertEquals(1, queue.dropped)
            val restored = LogQueue(file, { now }) { sent.add(it); 200 }
            assertEquals(1, restored.count())
            restored.flush(); restored.flush()
            assertEquals(0, restored.count()); assertEquals(1, sent.size)
            now = instant.plusSeconds(604801)
            queue.flush(); queue.enqueue(row())
            assertEquals(0, queue.count())
            queue.enqueue(row().copy(at = now.plusSeconds(301)))
            assertEquals(0, queue.count())
            val broken = LogQueue(root, { instant }) { 200 }
            broken.enqueue(row()); assertTrue(broken.storageFailed)
            val zero = LogQueue(File(root, "zero"), { instant }, -1) { 200 }
            zero.enqueue(row()); assertEquals(0, zero.count())
        } finally { root.deleteRecursively() }
    }

    @Test fun queueBatchRetryAndStop() = runTest {
        val root = folder()
        try {
            var now = instant
            var status = 429
            var calls = 0
            val queue = LogQueue(File(root, "queue"), { now }) { body ->
                calls++; assertTrue(body.trim().lines().size <= 50)
                if (status == 0) throw IllegalStateException()
                status
            }
            repeat(51) { queue.enqueue(row().copy(id = UUID.randomUUID())) }
            for (code in listOf(429, 408, 500, 0)) {
                status = code; queue.flush(); queue.flush(); now = now.plusSeconds(61)
            }
            assertEquals(4, calls); assertEquals(51, queue.count())
            status = 200; queue.flush(); assertEquals(1, queue.count())
            status = 400; queue.flush(); assertEquals(0, queue.count()); assertEquals(1, queue.dropped)
            queue.start(backgroundScope); queue.start(backgroundScope)
            advanceTimeBy(5001); runCurrent()
            queue.stop(); queue.start(backgroundScope); queue.enqueue(row()); queue.flush()
            assertEquals(0, queue.count())
        } finally { root.deleteRecursively() }
    }

    @Test fun lateSendAndCorruptRestore() = runTest {
        val root = folder()
        try {
            val file = File(root, "queue")
            for (text in listOf("garbage", " ".repeat(524289), row().copy(at = instant.minusSeconds(604801)).jsonLine())) {
                file.writeText(text)
                val queue = LogQueue(file, { instant }) { 200 }
                assertEquals(0, queue.count())
            }
            val started = CompletableDeferred<Unit>()
            val finished = CompletableDeferred<Int>()
            val queue = LogQueue(file, { instant }) { started.complete(Unit); finished.await() }
            queue.enqueue(row())
            val pending = async { queue.flush() }
            started.await(); queue.flush(); queue.stop(); finished.complete(200); pending.await()
            assertEquals(1, queue.count())
        } finally { root.deleteRecursively() }
    }

    @Test fun httpSender() = runTest {
        rejects { LogQueue.sender("http://example.test") }
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            assertEquals("POST", chain.request().method)
            assertEquals("application/x-ndjson; charset=utf-8", chain.request().body!!.contentType().toString())
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(202).message("Accepted").body("".toResponseBody()).build()
        }.build()
        assertEquals(202, LogQueue.sender("https://example.test/events", client)(row().jsonLine()))
    }
}

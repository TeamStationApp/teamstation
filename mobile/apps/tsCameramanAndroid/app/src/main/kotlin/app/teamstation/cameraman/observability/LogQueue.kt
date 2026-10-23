package app.teamstation.cameraman.observability

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.time.Instant
import java.util.concurrent.TimeUnit
import kotlin.math.min
import kotlin.math.pow

/** Serialized bounded queue with durable sanitized records and independent transport failures. */
class LogQueue(
    private val file: File,
    private val now: () -> Instant = { Instant.now() },
    private val capacity: Int = 500,
    private val send: suspend (String) -> Int,
) {
    private val mutex = Mutex()
    private var records = mutableListOf<LogRecord>()
    private var sending = false
    @Volatile private var stopped = false
    private var failures = 0
    private var retryAt = Instant.MIN
    private var timer: Job? = null
    var dropped = 0; private set
    var storageFailed = false; private set

    init {
        try {
            if (file.isFile && file.length() <= 524288) {
                records = file.readLines().takeLast(500).mapNotNull { line ->
                    try { LogRecord.decode(line) } catch (_: Exception) { null }
                }.filter { validTime(it) }.toMutableList()
                trim()
            }
        } catch (_: Exception) { storageFailed = true }
    }

    suspend fun count(): Int = mutex.withLock { records.size }
    @Synchronized fun start(scope: CoroutineScope) {
        if (timer != null || stopped) return
        timer = scope.launch { while (true) { delay(5000); flush() } }
    }
    @Synchronized fun stop() { stopped = true; timer?.cancel(); timer = null }

    suspend fun enqueue(row: LogRecord) = mutex.withLock {
        if (!stopped && validTime(row)) {
            if (records.none { it.id == row.id }) records.add(row)
            trim(); persist()
        }
    }

    suspend fun flush() {
        val batch = mutex.withLock {
            if (stopped || sending || now() < retryAt) return
            trim()
            if (records.isEmpty()) return
            sending = true
            records.take(50)
        }
        val status = try { send(batch.joinToString("") { it.jsonLine() }) } catch (_: Exception) { 0 }
        mutex.withLock {
            sending = false
            if (stopped) return
            if (status in 200..299 || (status in 400..499 && status != 408 && status != 429)) {
                val ids = batch.map { it.id }.toSet()
                records.removeAll { it.id in ids }
                if (status >= 400) dropped += batch.size
                failures = 0; retryAt = Instant.MIN; persist()
            } else {
                failures = min(8, failures + 1)
                retryAt = now().plusMillis((min(60000.0, 1000 * 2.0.pow(failures)) * (0.5 + Math.random() * 0.5)).toLong())
            }
        }
    }

    private fun validTime(row: LogRecord) = row.at >= now().minusSeconds(604800) && row.at <= now().plusSeconds(300)
    private fun trim() {
        val before = records.size
        records.removeAll { !validTime(it) }
        while (records.size > capacity.coerceIn(0, 500)) records.removeAt(0)
        dropped += before - records.size
    }
    private fun persist() {
        try {
            file.parentFile?.mkdirs()
            val temp = File(file.parentFile, file.name + ".new")
            temp.writeText(records.joinToString("") { it.jsonLine() })
            Files.move(temp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            storageFailed = false
        } catch (_: Exception) { storageFailed = true }
    }

    companion object {
        fun sender(endpoint: String, client: OkHttpClient = OkHttpClient.Builder().callTimeout(10, TimeUnit.SECONDS).build()): suspend (String) -> Int {
            require(endpoint.startsWith("https://"))
            return { body -> withContext(Dispatchers.IO) {
                val request = Request.Builder().url(endpoint)
                    .post(body.toRequestBody("application/x-ndjson".toMediaType())).build()
                client.newCall(request).execute().use { it.code }
            } }
        }
    }
}

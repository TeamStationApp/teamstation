package app.teamstation.cameraman.observability

import android.content.Context
import app.teamstation.cameraman.BuildConfig
import java.io.File
import java.net.URI
import java.security.MessageDigest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch

object LogEndpoint {
    fun from(dsn: String): String? = try {
        val url = URI(dsn)
        if (url.scheme != "https" || url.host.isNullOrEmpty() || url.query != null || url.fragment != null ||
            !Regex("^[A-Za-z0-9_-]{1,64}$").matches(url.rawUserInfo ?: "") ||
            !Regex("^/[0-9]{1,20}$").matches(url.path ?: "")) null
        else URI("https", null, url.host, url.port, "/ingest" + url.path, null, null).toString()
    } catch (_: Exception) { null }
}

/** A bounded input channel keeps logging from blocking camera and streaming callbacks. */
class LogClient(file: File, endpoint: String, send: suspend (String) -> Int = LogQueue.sender(endpoint)) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val input = Channel<LogRecord>(500, BufferOverflow.DROP_OLDEST)
    private val queue = LogQueue(file, send = send)
    private val worker = scope.launch { for (record in input) queue.enqueue(record) }
    init { queue.start(scope) }
    fun record(value: LogRecord) { input.trySend(value) }
    suspend fun close() {
        input.close()
        worker.join()
        queue.flush()
        queue.stop()
        scope.cancel()
    }
}

object AppLog {
    @Volatile private var client: LogClient? = null
    @Synchronized fun start(
        context: Context,
        dsn: String = BuildConfig.TS_SENTRY_DSN,
        makeClient: (File, String) -> LogClient = { file, endpoint -> LogClient(file, endpoint) },
    ) {
        if (client != null) return
        val endpoint = LogEndpoint.from(dsn) ?: return
        val partition = MessageDigest.getInstance("SHA-256").digest(endpoint.toByteArray()).joinToString("") { "%02x".format(it) }
        client = makeClient(File(context.filesDir, "observability/$partition.jsonl"), endpoint)
        record(LogKind.STARTED, operation = LogOperation.SERVICE)
    }
    fun record(kind: LogKind, operation: LogOperation? = null, error: LogError? = null, video: String? = null) {
        try { client?.record(LogRecord(kind, operation = operation, error = error, video = video, version = "${BuildConfig.VERSION_NAME}+${BuildConfig.VERSION_CODE}")) }
        catch (_: Exception) { /* Logging cannot fail the operation it observes. */ }
    }
    suspend fun close() {
        record(LogKind.STOPPED, operation = LogOperation.SERVICE)
        val prior = synchronized(this) { client.also { client = null } }
        prior?.close()
    }
}

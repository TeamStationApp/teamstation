package app.teamstation.observability

import android.content.Context
import java.net.URI
import io.sentry.SentryEvent
import io.sentry.SentryLevel
import io.sentry.AsyncHttpTransportFactory
import io.sentry.Hint
import io.sentry.ISerializer
import io.sentry.SentryEnvelope
import io.sentry.SentryEnvelopeItem
import io.sentry.SentryItemType
import io.sentry.hints.Retryable
import io.sentry.hints.SubmissionResult
import io.sentry.transport.ITransport
import io.sentry.util.HintUtils
import io.sentry.android.core.SentryAndroid
import io.sentry.android.core.SentryAndroidOptions
import io.sentry.protocol.SentryException
import io.sentry.protocol.SentryStackFrame
import io.sentry.protocol.SentryStackTrace

/** The JS beforeSend hook never sees native crashes. Both hosts use this boundary. */
object NativeSentryPrivacy {
    fun configure(options: SentryAndroidOptions) {
        options.isSendDefaultPii = false
        options.isEnableAutoSessionTracking = false
        options.isSendClientReports = false
        options.isAttachScreenshot = false
        options.isAttachViewHierarchy = false
        options.maxBreadcrumbs = 0
        options.setBeforeSend { event, _ -> scrub(event) }
        options.setBeforeBreadcrumb { _, _ -> null }
        options.setTransportFactory { settings, request ->
            transport(AsyncHttpTransportFactory().create(settings, request), settings.serializer)
        }
    }

    /** Cached NDK envelopes can also contain minidumps or attachments: none leave the device. */
    fun transport(delegate: ITransport, serializer: ISerializer): ITransport = object : ITransport by delegate {
        override fun send(envelope: SentryEnvelope, hint: Hint) {
            val items = envelope.items.take(50).mapNotNull { item ->
                try {
                    if (item.header.type != SentryItemType.Event || item.header.length > 262144) null
                    else item.getEvent(serializer)?.let { SentryEnvelopeItem.fromEvent(serializer, scrub(it)) }
                } catch (_: Exception) { null }
            }
            if (items.isEmpty()) {
                val result = HintUtils.getSentrySdkHint(hint)
                (result as? Retryable)?.setRetry(false)
                (result as? SubmissionResult)?.setResult(true)
                return
            }
            delegate.send(SentryEnvelope(envelope.header.eventId, null, items), hint)
        }
    }

    fun start(context: Context, dsn: String, version: String, build: String) {
        val valid = try {
            val url = URI(dsn)
            url.scheme == "https" && !url.host.isNullOrEmpty() && url.query == null && url.fragment == null &&
                Regex("^[A-Za-z0-9_-]{1,64}$").matches(url.rawUserInfo ?: "") &&
                Regex("^/[0-9]{1,20}$").matches(url.path ?: "")
        } catch (_: Exception) { false }
        if (!valid) return
        SentryAndroid.init(context) { options ->
            options.dsn = dsn
            options.release = "app.teamstation.app@$version+$build"
            configure(options)
        }
    }

    fun scrub(event: SentryEvent): SentryEvent {
        val safe = SentryEvent(event.timestamp)
        safe.eventId = event.eventId
        safe.level = if (event.level == SentryLevel.FATAL) SentryLevel.FATAL else SentryLevel.ERROR
        safe.release = event.release?.takeIf { Regex("^app\\.teamstation\\.(app|cameraman)@[0-9][0-9A-Za-z.+_-]{0,63}$").matches(it) }
        val source = event.exceptions?.lastOrNull()
        val allowed = setOf("Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "IllegalStateException", "IllegalArgumentException", "RuntimeException", "OutOfMemoryError", "SIGABRT", "SIGSEGV")
        val exception = SentryException().apply {
            type = source?.type?.takeIf { it in allowed } ?: "Error"
            value = "internal"
            stacktrace = SentryStackTrace(source?.stacktrace?.frames.orEmpty().takeLast(32).mapNotNull { frame ->
                val file = frame.filename?.substringAfterLast('/')?.substringAfterLast('\\')
                val line = frame.lineno
                val known = file in setOf("App.tsx", "api.ts", "sentry.ts", "index.ts", "VideoView.tsx", "VideoView.native.tsx", "MultiCamView.tsx", "StreamingScreen.native.tsx", "SentrySetup.kt", "MainActivity.kt", "index.android.bundle", "main.jsbundle") || (file != null && Regex("^app-[A-Z0-9]{8}\\.js$").matches(file))
                if (!known || line == null || line !in 1..1_000_000) null
                else SentryStackFrame().apply {
                    filename = file; lineno = line
                    colno = frame.colno?.takeIf { it in 0..100_000_000 }
                }
            }.takeLast(3))
        }
        safe.exceptions = listOf(exception)
        return safe
    }
}

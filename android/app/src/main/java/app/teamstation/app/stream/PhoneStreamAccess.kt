package app.teamstation.app.stream

import app.teamstation.streamcore.phonestream.PhoneStreamException
import kotlinx.coroutines.CancellationException

/** The engine could not be made, so phone streaming is unavailable in this process, for [reason]. */
class PhoneStreamUnavailable(val reason: String) : Exception(reason)

/**
 * Makes the process's engine once and keeps how that went. The module initialises at every launch,
 * and an engine whose catalog would not open (SQLite full, or unable to open its file) threw there
 * and crash-looped the app for everyone, streaming or not. Now each call refuses with
 * [PhoneStreamUnavailable] instead, and the engine is not tried again at every call.
 */
class EngineOnce<E : Any> {
    private var outcome: Result<E>? = null

    /** The engine, made by [make] the first time; throws [PhoneStreamUnavailable] when it could not be. */
    @Synchronized
    fun get(make: () -> E): E {
        val known = outcome ?: try {
            Result.success(make())
        } catch (error: Exception) {
            Result.failure(error)
        }.also { outcome = it }
        return known.getOrElse { error ->
            throw PhoneStreamUnavailable("Phone streaming could not start: ${error.message ?: error.javaClass.simpleName}")
        }
    }

    /** The engine, or null when it could not be made. */
    fun getOrNull(make: () -> E): E? =
        try {
            get(make)
        } catch (error: PhoneStreamUnavailable) {
            null
        }
}

/** What a call that threw rejects its promise with: a code JavaScript knows, and a message. */
object PhoneStreamRefusal {
    fun of(error: Throwable): Pair<String, String?> =
        when (error) {
            // The code JavaScript already has for a build without streaming, with why in the message.
            is PhoneStreamUnavailable -> "unsupported" to error.reason
            is PhoneStreamException -> error.code.rawValue to error.message
            is CancellationException -> "cancelled" to "cancelled"
            else -> "failed" to (error.message ?: error.javaClass.simpleName)
        }
}

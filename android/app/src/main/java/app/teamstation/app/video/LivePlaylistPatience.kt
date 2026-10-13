package app.teamstation.app.video

import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.exoplayer.hls.playlist.DefaultHlsPlaylistTracker
import androidx.media3.exoplayer.hls.playlist.HlsPlaylistTracker
import androidx.media3.exoplayer.source.MediaSource
import com.brentvatne.common.api.Source
import com.brentvatne.exoplayer.RNVExoplayerPlugin
import com.brentvatne.react.ReactNativeVideoManager

/**
 * Lets a live playlist stay quiet for as long as TeamStation keeps it open.
 *
 * TeamStation keeps a live playlist open for eight minutes after its
 * publisher leaves (`RECONNECT_GRACE_MS` in `src/server/live/controller.ts`),
 * so a phone that leaves the camera and comes back carries on in the same
 * playlist, and closes it with `EXT-X-ENDLIST` after that. Media3 gives up
 * on a live playlist that has not changed for 3.5 target durations, 21 s of
 * 6 s segments: a viewer that had caught up with a phone that left failed
 * with `PlaylistStuckException` and stayed failed when the phone came back.
 *
 * Every HLS player in the app is built with a playlist tracker that waits
 * out the grace, and a minute more, for any target duration of two seconds or
 * longer. The player waits at the end of what was written, buffering, and
 * plays on by itself when the playlist grows; once the playlist is closed it
 * plays to its end and ends, as before. A recording's playlist is closed from
 * the start and is never checked for this at all.
 */
@OptIn(UnstableApi::class)
object LivePlaylistPatience : RNVExoplayerPlugin {
    /** How long TeamStation keeps a live playlist open with nobody publishing. */
    const val GRACE_MS = 8 * 60_000L

    /** Beyond the grace, for the server's last write and the player's next look. */
    const val MARGIN_MS = 60_000L

    /** The shortest target duration the patience is worked out for. */
    const val SHORTEST_TARGET_MS = 2_000L

    /** Media3's multiple of the target duration after which an unchanged playlist is stuck. */
    const val STUCK_TARGET_DURATIONS: Double = (GRACE_MS + MARGIN_MS).toDouble() / SHORTEST_TARGET_MS

    /** How long a playlist with this target duration may stay unchanged. */
    fun stuckAfterMs(targetDurationMs: Long): Long = (targetDurationMs * STUCK_TARGET_DURATIONS).toLong()

    private val trackerFactory =
        HlsPlaylistTracker.Factory { dataSourceFactory, loadErrorHandlingPolicy, parserFactory, cmcdConfiguration ->
            DefaultHlsPlaylistTracker(
                dataSourceFactory,
                loadErrorHandlingPolicy,
                parserFactory,
                cmcdConfiguration,
                STUCK_TARGET_DURATIONS,
            )
        }

    /** Every `<Video>` built after this asks it for its media source factory. */
    fun register() {
        ReactNativeVideoManager.getInstance().registerPlugin(this)
    }

    override fun overrideMediaSourceFactory(
        source: Source,
        mediaSourceFactory: MediaSource.Factory,
        mediaDataSourceFactory: DataSource.Factory,
    ): MediaSource.Factory? = (mediaSourceFactory as? HlsMediaSource.Factory)?.setPlaylistTrackerFactory(trackerFactory)

    override fun onInstanceCreated(id: String, player: ExoPlayer) = Unit

    override fun onInstanceRemoved(id: String, player: ExoPlayer) = Unit
}

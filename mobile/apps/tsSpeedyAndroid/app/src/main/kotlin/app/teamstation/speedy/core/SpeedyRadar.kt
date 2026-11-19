package app.teamstation.speedy.core

/** The one radar TS Speedy pairs. The app backs it with the shared `RadarFleet`; tests with a fake. */
interface SpeedyRadar {
    val status: RadarStatus
    /** After every change to [status]. */
    var onChange: (() -> Unit)?
    /** A reading: pitch and exit in mph, zero for a side the reading does not carry. */
    var onSpeeds: ((Int, Int) -> Unit)?
    fun start()
    /** Bluetooth, Location or the permission may have changed: look again. */
    fun refresh()
    /** Lists the unpaired radars in range in [RadarStatus.nearby]. */
    fun startPairing()
    fun stopPairing()
    /** Pairs [name], replacing the radar paired before it. */
    fun pair(name: String)
    fun unpair()
}

/** Plays a phrase's clips, one phrase after another. */
interface PhrasePlayer {
    fun play(clips: List<String>)
    /** Stops what is playing and drops what is waiting. */
    fun stop()
}

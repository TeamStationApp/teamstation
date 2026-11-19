package app.teamstation.speedy.core

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Everything TS Speedy's two screens show and do. */
class SpeedyModel(
    private val radar: SpeedyRadar,
    private val player: PhrasePlayer,
    private val audioSetting: AudioSetting,
    private val scheduler: Scheduler,
    private val clock: () -> Long = System::currentTimeMillis,
    val uiTest: Boolean = false
) {
    private val boardFlow = MutableStateFlow(SpeedBoard())
    val board: StateFlow<SpeedBoard> = boardFlow.asStateFlow()

    private val statusFlow = MutableStateFlow(radar.status)
    val radarStatus: StateFlow<RadarStatus> = statusFlow.asStateFlow()

    private val audioFlow = MutableStateFlow(audioSetting.isOn)
    val audioOn: StateFlow<Boolean> = audioFlow.asStateFlow()

    /**
     * The last phrase handed to the player, as words, or "muted" for a reading heard with audio
     * off. Kept only for UI tests, which cannot hear.
     */
    private val speechFlow = MutableStateFlow("")
    val speechLog: StateFlow<String> = speechFlow.asStateFlow()

    private val settingsFlow = MutableStateFlow(false)
    val showingSettings: StateFlow<Boolean> = settingsFlow.asStateFlow()

    private val announcer = Announcer(audioFlow.value, scheduler) { speak(it) }
    private var sequence: Cancellable? = null

    init {
        radar.onChange = { statusFlow.value = radar.status }
        radar.onSpeeds = { pitch, exit -> receive(pitch, exit) }
    }

    fun start() {
        radar.start()
        statusFlow.value = radar.status
    }

    /** Bluetooth, Location or the permission may have changed. */
    fun refresh() {
        radar.refresh()
        statusFlow.value = radar.status
    }

    val now: Long get() = clock()
    fun pitchText(nowMs: Long): String = boardFlow.value.text(SpeedBoard.Side.PITCH, nowMs)
    fun exitText(nowMs: Long): String = boardFlow.value.text(SpeedBoard.Side.EXIT, nowMs)

    /** A reading from the radar: on screen at once, and to the announcer. */
    fun receive(pitch: Int, exit: Int) {
        if (pitch <= 0 && exit <= 0) return
        boardFlow.value = boardFlow.value.receive(pitch, exit, clock())
        if (audioFlow.value) {
            announcer.receive(pitch, exit)
        } else if (uiTest) {
            speechFlow.value = "muted"
        }
    }

    fun setAudio(on: Boolean) {
        audioFlow.value = on
        audioSetting.isOn = on
        announcer.audioOn = on
        if (!on) player.stop()
    }

    fun toggleAudio() = setAudio(!audioFlow.value)

    fun openSettings() {
        settingsFlow.value = true
    }

    fun closeSettings() {
        radar.stopPairing()
        settingsFlow.value = false
    }

    fun startPairing() = radar.startPairing()
    fun stopPairing() = radar.stopPairing()

    fun pair(name: String) {
        radar.pair(name)
        radar.stopPairing()
    }

    fun unpair() = radar.unpair()

    /** Acts on a `tsspeedy://test/…` link when launched for a UI test; ignores every link otherwise. */
    fun handle(link: String): Boolean {
        if (!uiTest) return false
        when (val command = ControlCommand.parse(link) ?: return false) {
            is ControlCommand.RadarFeed -> receive(command.pitch, command.exit)
            is ControlCommand.RadarSequence -> {
                sequence?.cancel()
                receive(command.pitch, 0)
                sequence = scheduler.after(command.gapMs) { receive(0, command.exit) }
            }
            ControlCommand.Reset -> {
                sequence?.cancel()
                sequence = null
                boardFlow.value = SpeedBoard()
                announcer.reset()
                player.stop()
                speechFlow.value = ""
            }
        }
        return true
    }

    private fun speak(clips: List<String>) {
        if (uiTest) speechFlow.value = Phrase.words(clips)
        player.play(clips)
    }
}

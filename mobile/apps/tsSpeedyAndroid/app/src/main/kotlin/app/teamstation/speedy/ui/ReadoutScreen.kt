package app.teamstation.speedy.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.VolumeOff
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.teamstation.speedy.core.ReadoutMetrics
import app.teamstation.speedy.core.SpeedyModel
import kotlinx.coroutines.delay

/** The whole app: the readout, with Settings over it while open. */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun SpeedyScreen(model: SpeedyModel, onAllowBluetooth: () -> Unit, keepsScreenOn: () -> Boolean) {
    val showingSettings by model.showingSettings.collectAsState()
    // UI tests find views by their test tags, as resource ids.
    // One screen at a time: the readout's controls must not take touches, or TalkBack's focus,
    // from under Settings.
    Box(Modifier.fillMaxSize().semantics { testTagsAsResourceId = true }) {
        if (showingSettings) SettingsScreen(model, onAllowBluetooth) else ReadoutScreen(model, keepsScreenOn)
    }
}

/** The readout's numbers: heavy, with every digit the same width. */
fun readoutStyle(sizeSp: Float) = TextStyle(
    fontSize = sizeSp.sp,
    fontWeight = FontWeight.Black,
    fontFeatureSettings = "tnum",
    color = Color.White
)

/** How wide [text] draws at size 1, in pixels per sp. */
fun unitWidth(measurer: TextMeasurer, text: String): Float =
    measurer.measure(text, readoutStyle(100f), softWrap = false).size.width / 100f

@Composable
fun ReadoutScreen(model: SpeedyModel, keepsScreenOn: () -> Boolean) {
    val board by model.board.collectAsState()
    val audioOn by model.audioOn.collectAsState()
    val status by model.radarStatus.collectAsState()
    val speechLog by model.speechLog.collectAsState()
    var now by remember { mutableLongStateOf(model.now) }
    // Redrawn on each reading, and exactly when each side's five seconds run out.
    LaunchedEffect(board) {
        now = model.now
        for (expiry in board.expiries) {
            val wait = expiry - model.now
            if (wait > 0) delay(wait)
            now = model.now
        }
    }
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current

    Box(Modifier.fillMaxSize().background(Color.Black).safeDrawingPadding()) {
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val widthPx = with(density) { maxWidth.toPx() }
            val heightPx = with(density) { maxHeight.toPx() }
            val unit88 = remember(measurer) { unitWidth(measurer, ReadoutMetrics.REFERENCE) }
            val metrics = ReadoutMetrics.of(widthPx, heightPx, unit88)
            val pitch = board.text(app.teamstation.speedy.core.SpeedBoard.Side.PITCH, now)
            val exit = board.text(app.teamstation.speedy.core.SpeedBoard.Side.EXIT, now)
            Column(Modifier.fillMaxSize()) {
                Box(
                    Modifier.fillMaxWidth().height(with(density) { (metrics.lineY - metrics.gap).toDp() }),
                    contentAlignment = Alignment.BottomCenter
                ) {
                    Number(pitch, metrics.pitchSize, metrics, measurer, "speedy-pitch")
                }
                Spacer(Modifier.height(with(density) { metrics.gap.toDp() }))
                Box(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp).height(2.dp)
                        .background(Color.White.copy(alpha = 0.4f))
                )
                Spacer(Modifier.height(with(density) { metrics.gap.toDp() }))
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
                    Number(exit, metrics.exitSize, metrics, measurer, "speedy-exit")
                }
            }
        }

        IconButton(
            onClick = model::openSettings,
            modifier = Modifier.align(Alignment.TopEnd).padding(4.dp).testTag("speedy-settings")
        ) {
            Icon(Icons.Filled.Settings, contentDescription = "Settings", tint = Color.White.copy(alpha = 0.7f), modifier = Modifier.size(28.dp))
        }
        if (!status.isPaired) {
            Text(
                "Tap ⚙ to pair a radar",
                color = Color.White.copy(alpha = 0.6f),
                fontSize = 17.sp,
                modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 14.dp).testTag("speedy-pair-hint")
            )
        }
        IconButton(
            onClick = model::toggleAudio,
            modifier = Modifier.align(Alignment.BottomEnd).padding(4.dp)
                .testTag(if (audioOn) "speedy-audio-on" else "speedy-audio-off")
        ) {
            Icon(
                if (audioOn) Icons.AutoMirrored.Filled.VolumeUp else Icons.AutoMirrored.Filled.VolumeOff,
                contentDescription = if (audioOn) "Audio on" else "Audio off",
                tint = Color.White.copy(alpha = 0.7f),
                modifier = Modifier.size(28.dp)
            )
        }
        if (model.uiTest) {
            // Black on black: invisible from the stands, readable by a UI test.
            Column(Modifier.align(Alignment.TopStart).padding(4.dp)) {
                Text(speechLog.ifEmpty { "-" }, color = Color.Black, fontSize = 10.sp, modifier = Modifier.testTag("speedy-speech-log"))
                Text(
                    if (keepsScreenOn()) "keep-screen-on" else "screen-may-sleep",
                    color = Color.Black,
                    fontSize = 10.sp,
                    modifier = Modifier.testTag("speedy-awake")
                )
            }
        }
    }
}

@Composable
private fun Number(text: String, size: Float, metrics: ReadoutMetrics, measurer: TextMeasurer, tag: String) {
    // Measured once per string: the readout redraws every second with the same few.
    val unit = remember(measurer, text) { unitWidth(measurer, text) }
    val fitted = metrics.fitted(size, unit * size)
    Text(text, style = readoutStyle(fitted), maxLines = 1, softWrap = false, modifier = Modifier.testTag(tag))
}

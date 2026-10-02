package app.teamstation.cameraman.ui

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.teamstation.cameraman.core.BroadcastPolicy
import app.teamstation.cameraman.ui.theme.CameramanTokens
import kotlin.math.roundToInt

private val recordRed = Color(0xFFF23D47)
private val darkerRed = Color(0xFFC7292E)
private val brighterRed = Color(0xFFFF525C)

/** Idle record disc: darker and less saturated than the live red. */
private val idleRecordRed = Color(0xFF8C3A3F)

/** Idle center mark, a step off pure white. */
private val idleRecordMark = Color(0xFFE6E4E2)

/**
 * Corner of an iPhone app icon, as a fraction of the icon's side. Applied to the slider's short
 * side so the track and the knob read as that same curve rather than a tight rounded rectangle.
 */
private const val appIconCornerFraction = 0.28f
private val slideTrackCorner = 58.dp * appIconCornerFraction
private val slideKnobCorner = 52.dp * appIconCornerFraction

/**
 * Idle disc is a muted red with a gray-white circle. Live, the disc is the bright record red and
 * the mark is a white square; the next tap asks for a slide to stop.
 */
@Composable
fun BroadcastButton(isLive: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Surface(
        onClick = onClick,
        shape = CircleShape,
        color = if (isLive) recordRed else idleRecordRed,
        modifier = modifier
            .size(64.dp)
            .testTag("broadcast-button")
            .semantics {
                contentDescription = if (isLive) "Stop broadcasting" else "Start broadcasting"
            }
    ) {
        Box(contentAlignment = Alignment.Center) {
            if (isLive) {
                Box(
                    modifier = Modifier
                        .size(20.dp)
                        .clip(RoundedCornerShape(3.dp))
                        .background(Color.White)
                )
            } else {
                Box(
                    modifier = Modifier
                        .size(24.dp)
                        .clip(CircleShape)
                        .background(idleRecordMark)
                )
            }
        }
    }
}

/** Pulsing red pill, drawn to the left of the thermal badge while a broadcast is on. */
@Composable
fun BroadcastingPill(animate: Boolean, modifier: Modifier = Modifier) {
    val pulse = if (animate) {
        val transition = rememberInfiniteTransition(label = "broadcasting")
        val animated by transition.animateFloat(
            initialValue = 0f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(tween(700), RepeatMode.Reverse),
            label = "broadcasting-pulse"
        )
        animated
    } else {
        0f
    }
    Surface(
        shape = RoundedCornerShape(8.dp),
        color = androidx.compose.ui.graphics.lerp(darkerRed, brighterRed, pulse),
        modifier = modifier
            .testTag("broadcasting-pill")
            .semantics { contentDescription = "Broadcasting" }
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .height(CameramanTokens.chromePillHeight)
                .padding(horizontal = 14.dp)
        ) {
            Box(
                modifier = Modifier
                    .size(11.dp)
                    .clip(RoundedCornerShape(2.dp))
                    .background(Color.White)
            )
            Text(
                text = "Broadcasting",
                color = Color.White,
                fontWeight = FontWeight.Black,
                fontSize = 13.sp,
                letterSpacing = 1.sp
            )
        }
    }
}

/**
 * Confirm a stop. Start stays one tap. The knob has to travel [BroadcastPolicy.slideCommitFraction]
 * of the track; a shorter drag springs back.
 */
@Composable
fun SlideToStop(
    animate: Boolean,
    onStop: () -> Unit,
    modifier: Modifier = Modifier,
    label: String = "Slide to Stop",
    trackTag: String = "slide-to-stop-track"
) {
    var offsetPx by remember { mutableFloatStateOf(0f) }
    val pulse = if (animate) {
        val transition = rememberInfiniteTransition(label = "slide-to-stop")
        val animated by transition.animateFloat(
            initialValue = 0f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(tween(700), RepeatMode.Reverse),
            label = "slide-knob"
        )
        animated
    } else {
        0f
    }
    Box(
        modifier = modifier
            .width(272.dp)
            .height(58.dp)
            .clip(RoundedCornerShape(slideTrackCorner))
            .background(recordRed.copy(alpha = 0.72f))
            .testTag(trackTag)
            .pointerInput(Unit) {
                val travel = (size.width - 52.dp.toPx() - 6.dp.toPx()).coerceAtLeast(1f)
                detectHorizontalDragGestures(
                    onDragEnd = {
                        if (BroadcastPolicy.slideCommits((offsetPx / travel).toDouble())) {
                            offsetPx = travel
                            onStop()
                        } else {
                            offsetPx = 0f
                        }
                    },
                    onHorizontalDrag = { change, dragAmount ->
                        change.consume()
                        offsetPx = (offsetPx + dragAmount).coerceIn(0f, travel)
                    }
                )
            }
    ) {
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .matchParentSize()
                .testTag("slide-to-stop-label")
        ) {
            Text(
                text = label,
                color = Color.White,
                fontWeight = FontWeight.SemiBold,
                fontSize = 17.sp,
                textAlign = TextAlign.Center
            )
        }
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .padding(start = 3.dp)
                .offset { IntOffset(offsetPx.roundToInt(), 0) }
                .size(52.dp)
                .clip(RoundedCornerShape(slideKnobCorner))
                .background(androidx.compose.ui.graphics.lerp(darkerRed, brighterRed, pulse))
                .testTag("slide-to-stop-knob")
                .semantics { contentDescription = label }
        ) {
            Box(
                modifier = Modifier
                    .size(11.dp)
                    .clip(RoundedCornerShape(2.dp))
                    .background(Color.White)
            )
        }
        Box(
            modifier = Modifier
                .align(Alignment.CenterEnd)
                .size(1.dp)
                .testTag("slide-to-stop-end")
        )
    }
}

/** A tap anywhere outside the slider, with no ripple of its own. */
@Composable
fun SlideToStopDismiss(onDismiss: () -> Unit, modifier: Modifier = Modifier) {
    Box(
        modifier
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = onDismiss
            )
            .testTag("slide-to-stop-dismiss")
    )
}

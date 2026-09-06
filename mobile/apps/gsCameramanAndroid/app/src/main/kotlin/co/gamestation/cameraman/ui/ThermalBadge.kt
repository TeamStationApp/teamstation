package co.gamestation.cameraman.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import co.gamestation.cameraman.core.ThermalBadgeLevel
import co.gamestation.cameraman.ui.theme.CameramanTokens
import kotlin.math.cos

/**
 * The thermal pill, matching the iOS build's.
 *
 * Cool, fair and warm pulse their fill between two opacities; hot travels a three-quarter-height
 * gradient slab up through the pill, faster. The motion is the point — a pill that only changed
 * colour would be missed on a phone across a field, and the whole reason it is on the operating
 * screen rather than in settings is that a hot phone is about to start dropping frames.
 *
 * Untappable: a zoom drag has to reach the preview underneath.
 */
@Composable
fun ThermalBadge(level: ThermalBadgeLevel, animate: Boolean, modifier: Modifier = Modifier) {
    val colour = Color(
        red = level.hue.red.toFloat(),
        green = level.hue.green.toFloat(),
        blue = level.hue.blue.toFloat()
    )

    val phase = if (animate) {
        val transition = rememberInfiniteTransition(label = "thermal")
        val animated by transition.animateFloat(
            initialValue = 0f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(
                animation = tween(
                    durationMillis = (level.cycleSeconds * 1000).toInt(),
                    easing = LinearEasing
                ),
                repeatMode = RepeatMode.Restart
            ),
            label = "thermal-phase"
        )
        animated
    } else {
        // A still frame for a UI test: an animation that never settles makes Maestro wait out its
        // idling timeout on every single assertion.
        0.35f
    }

    Surface(
        shape = RoundedCornerShape(8.dp),
        color = Color.Transparent,
        modifier = modifier
            .drawBehind { drawShimmer(colour, level.shimmer, phase) }
            .semantics { contentDescription = "Thermal ${level.rawValue}" }
            .testTag("camera-thermal")
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
            // The height every chrome pill shares, so this lands on the same line as the camera name.
            modifier = Modifier
                .height(CameramanTokens.chromePillHeight)
                .padding(horizontal = 16.dp)
        ) {
            if (level.showsFlames) Text("🔥", fontSize = 13.sp)
            Text(
                text = level.label,
                color = Color.White,
                fontSize = 13.sp,
                fontWeight = FontWeight.Black,
                letterSpacing = 1.sp
            )
            if (level.showsFlames) Text("🔥", fontSize = 13.sp)
        }
    }
}

private const val fillOpacity = 0.18f
private const val bandOpacity = 0.38f
private const val bandFraction = 0.75f

/** Fade each end of the travelling slab over this fraction of the pill's height. */
private const val fadePillFraction = 0.20f

private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawShimmer(
    colour: Color,
    shimmer: ThermalBadgeLevel.Shimmer,
    phase: Float
) {
    val corner = androidx.compose.ui.geometry.CornerRadius(8.dp.toPx())

    when (shimmer) {
        ThermalBadgeLevel.Shimmer.PULSE -> {
            // A cosine rather than a triangle so the pill breathes instead of ticking.
            val t = 0.5f - 0.5f * cos(phase * 2f * Math.PI.toFloat())
            val opacity = fillOpacity + (bandOpacity - fillOpacity) * t
            drawRoundRect(color = colour.copy(alpha = opacity), cornerRadius = corner)
        }

        ThermalBadgeLevel.Shimmer.UP -> {
            drawRoundRect(color = colour.copy(alpha = fillOpacity), cornerRadius = corner)
            val bandHeight = size.height * bandFraction
            // The slab enters from below and the cycle ends once its bottom has left the top, so
            // there is no moment where it sits still.
            val travel = size.height + bandHeight
            val top = size.height - phase * travel
            val fade = if (bandHeight > 0) {
                minOf(0.49f, (fadePillFraction * size.height) / bandHeight)
            } else {
                0f
            }
            clipRect {
                drawRect(
                    brush = Brush.verticalGradient(
                        colorStops = arrayOf(
                            0f to colour.copy(alpha = 0f),
                            fade to colour.copy(alpha = bandOpacity),
                            (1f - fade) to colour.copy(alpha = bandOpacity),
                            1f to colour.copy(alpha = 0f)
                        ),
                        startY = top,
                        endY = top + bandHeight
                    ),
                    topLeft = Offset(0f, top),
                    size = Size(size.width, bandHeight)
                )
            }
        }
    }
}

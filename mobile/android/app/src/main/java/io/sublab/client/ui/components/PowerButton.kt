package io.sublab.client.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.PowerSettingsNew
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.sublab.client.ui.theme.Palette

enum class PowerState { OFF, CONNECTING, ON }

/**
 * Большая круглая кнопка подключения: мягкое свечение, вращающееся кольцо при
 * подключении и градиентная заливка во включённом состоянии.
 */
@Composable
fun PowerButton(state: PowerState, onClick: () -> Unit, modifier: Modifier = Modifier, size: Dp = 196.dp) {
    val transition = rememberInfiniteTransition(label = "power")
    val spin by transition.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(tween(1400, easing = LinearEasing)),
        label = "spin",
    )
    val breath by transition.animateFloat(
        initialValue = 0.85f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(2200), RepeatMode.Reverse),
        label = "breath",
    )
    val glowAlpha by animateFloatAsState(
        targetValue = when (state) {
            PowerState.OFF -> 0.18f
            PowerState.CONNECTING -> 0.35f
            PowerState.ON -> 0.55f
        },
        animationSpec = tween(600),
        label = "glow",
    )
    val glowColor by animateColorAsState(
        targetValue = if (state == PowerState.ON) Palette.Green else Palette.Violet,
        animationSpec = tween(600),
        label = "glowColor",
    )
    val iconTint by animateColorAsState(
        targetValue = if (state == PowerState.OFF) Palette.TextSecondary else Color.White,
        label = "icon",
    )

    Box(modifier = modifier.size(size * 1.45f), contentAlignment = Alignment.Center) {
        // Свечение.
        Canvas(
            Modifier
                .fillMaxSize()
                .scale(if (state == PowerState.OFF) 1f else breath),
        ) {
            drawCircle(
                brush = Brush.radialGradient(
                    colors = listOf(glowColor.copy(alpha = glowAlpha), Color.Transparent),
                    center = center,
                    radius = this.size.minDimension / 2,
                ),
            )
        }

        // Внешнее кольцо: статичное или бегущая дуга при подключении.
        Canvas(
            Modifier
                .size(size + 26.dp)
                .rotate(if (state == PowerState.CONNECTING) spin else 0f),
        ) {
            val stroke = 3.dp.toPx()
            drawCircle(color = Palette.Stroke, style = Stroke(stroke), radius = this.size.minDimension / 2 - stroke)
            val brush = if (state == PowerState.ON) {
                Brush.sweepGradient(listOf(Palette.Green, Palette.Cyan, Palette.Green))
            } else {
                Brush.sweepGradient(listOf(Palette.Violet.copy(alpha = 0f), Palette.VioletSoft, Palette.Cyan))
            }
            if (state != PowerState.OFF) {
                val inset = stroke
                drawArc(
                    brush = brush,
                    startAngle = 0f,
                    sweepAngle = if (state == PowerState.ON) 360f else 250f,
                    useCenter = false,
                    topLeft = Offset(inset, inset),
                    size = androidx.compose.ui.geometry.Size(this.size.width - inset * 2, this.size.height - inset * 2),
                    style = Stroke(stroke, cap = StrokeCap.Round),
                )
            }
        }

        val fill = when (state) {
            PowerState.ON -> Palette.Connected
            PowerState.CONNECTING -> Brush.linearGradient(listOf(Palette.SurfaceHighest, Palette.SurfaceHigh))
            PowerState.OFF -> Brush.linearGradient(listOf(Palette.SurfaceHighest, Palette.Surface))
        }
        Box(
            modifier = Modifier
                .size(size)
                .clip(CircleShape)
                .background(fill)
                .border(1.dp, Color.White.copy(alpha = 0.06f), CircleShape)
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                    onClick = onClick,
                ),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = Icons.Rounded.PowerSettingsNew,
                contentDescription = if (state == PowerState.OFF) "Подключить" else "Отключить",
                tint = iconTint,
                modifier = Modifier
                    .padding(8.dp)
                    .size(size * 0.36f),
            )
        }
    }
}

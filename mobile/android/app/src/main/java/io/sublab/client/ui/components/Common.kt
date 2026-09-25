package io.sublab.client.ui.components

import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.sublab.client.core.Engine
import io.sublab.client.ui.theme.Palette

/** Тёмная карточка с тонкой рамкой — основной контейнер интерфейса. */
@Composable
fun Panel(
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val shape = RoundedCornerShape(22.dp)
    Column(
        modifier = modifier
            .clip(shape)
            .background(Palette.Surface)
            .border(1.dp, Palette.Stroke, shape)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(16.dp),
        content = content,
    )
}

/**
 * Переключатель ядра Xray / Mihomo — сегмент с «таблеткой», которая переезжает
 * под выбранный вариант.
 */
@Composable
fun EngineSwitch(selected: Engine, onSelect: (Engine) -> Unit, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(16.dp)
    BoxWithConstraints(
        modifier = modifier
            .height(44.dp)
            .clip(shape)
            .background(Palette.Surface)
            .border(1.dp, Palette.Stroke, shape)
            .padding(4.dp),
    ) {
        val segment = maxWidth / Engine.entries.size
        val offset by animateDpAsState(
            targetValue = segment * Engine.entries.indexOf(selected),
            animationSpec = spring(dampingRatio = 0.8f, stiffness = 500f),
            label = "engine",
        )
        Box(
            Modifier
                .offset(x = offset)
                .width(segment)
                .fillMaxHeight()
                .clip(RoundedCornerShape(12.dp))
                .background(Palette.Accent),
        )
        Row(Modifier.fillMaxWidth().fillMaxHeight()) {
            Engine.entries.forEach { engine ->
                val active = engine == selected
                Box(
                    modifier = Modifier
                        .width(segment)
                        .fillMaxHeight()
                        .clip(RoundedCornerShape(12.dp))
                        .clickable { onSelect(engine) },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = engine.title,
                        color = if (active) Color.White else Palette.TextSecondary,
                        fontWeight = if (active) FontWeight.SemiBold else FontWeight.Medium,
                        fontSize = 14.sp,
                    )
                }
            }
        }
    }
}

/** Круглый значок страны: флаг из названия или глобус. */
@Composable
fun FlagBadge(flag: String?, modifier: Modifier = Modifier, size: Int = 40) {
    Box(
        modifier = modifier
            .size(size.dp)
            .clip(CircleShape)
            .background(Palette.SurfaceHighest),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = flag ?: "🌐",
            fontSize = (size * 0.5f).sp,
            textAlign = TextAlign.Center,
        )
    }
}

/** Маленькая плашка: протокол, «только Mihomo» и т.п. */
@Composable
fun Chip(text: String, color: Color = Palette.TextSecondary, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(8.dp))
            .background(color.copy(alpha = 0.12f))
            .padding(horizontal = 8.dp, vertical = 3.dp),
    ) {
        Text(text = text, color = color, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
    }
}

/** Точка-индикатор с подписью пинга. */
@Composable
fun PingText(ms: Int?, modifier: Modifier = Modifier) {
    Row(modifier = modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(
            Modifier
                .size(7.dp)
                .clip(CircleShape)
                .background(pingColor(ms)),
        )
        Text(text = pingLabel(ms), color = pingColor(ms), fontSize = 12.sp, fontWeight = FontWeight.Medium)
    }
}

@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text.uppercase(),
        color = Palette.TextMuted,
        fontSize = 11.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 1.2.sp,
        modifier = modifier.padding(start = 4.dp, top = 8.dp, bottom = 8.dp),
    )
}

package io.sublab.client.ui.screens

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material.icons.rounded.ArrowDownward
import androidx.compose.material.icons.rounded.ArrowUpward
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.sublab.client.core.Engine
import io.sublab.client.data.ServerNode
import io.sublab.client.data.Subscription
import io.sublab.client.ui.Traffic
import io.sublab.client.ui.components.EngineSwitch
import io.sublab.client.ui.components.FlagBadge
import io.sublab.client.ui.components.Panel
import io.sublab.client.ui.components.PingText
import io.sublab.client.ui.components.PowerButton
import io.sublab.client.ui.components.PowerState
import io.sublab.client.ui.components.expireLabel
import io.sublab.client.ui.components.formatBytes
import io.sublab.client.ui.components.formatDuration
import io.sublab.client.ui.components.formatSpeed
import io.sublab.client.ui.components.protocolLabel
import io.sublab.client.ui.theme.Palette
import io.sublab.client.vpn.VpnState
import kotlinx.coroutines.delay

@Composable
fun HomeScreen(
    state: VpnState,
    engine: Engine,
    node: ServerNode?,
    ping: Int?,
    subscription: Subscription?,
    traffic: Traffic,
    onToggle: () -> Unit,
    onEngine: (Engine) -> Unit,
    onOpenServers: () -> Unit,
    onAddSubscription: () -> Unit,
) {
    val power = when (state) {
        is VpnState.Connected -> PowerState.ON
        VpnState.Connecting, VpnState.Stopping -> PowerState.CONNECTING
        else -> PowerState.OFF
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Header(power)
        Spacer(Modifier.height(18.dp))
        EngineSwitch(selected = engine, onSelect = onEngine, modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(12.dp))

        PowerButton(state = power, onClick = onToggle)

        StatusBlock(state)
        Spacer(Modifier.height(18.dp))
        TrafficRow(traffic, active = power == PowerState.ON)
        Spacer(Modifier.height(22.dp))

        if (node != null) {
            ServerPanel(node, ping, engine, onOpenServers)
        } else {
            EmptyPanel(onAddSubscription)
        }
        if (subscription != null && (subscription.total > 0 || subscription.expire > 0)) {
            Spacer(Modifier.height(12.dp))
            SubscriptionPanel(subscription)
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun Header(power: PowerState) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(10.dp)
                .clip(CircleShape)
                .background(if (power == PowerState.ON) Palette.Connected else Palette.Accent),
        )
        Spacer(Modifier.width(10.dp))
        Text("sub·lab", fontSize = 22.sp, fontWeight = FontWeight.Bold, color = Palette.TextPrimary)
    }
}

@Composable
private fun StatusBlock(state: VpnState) {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    if (state is VpnState.Connected) {
        LaunchedEffect(state.since) {
            while (true) {
                now = System.currentTimeMillis()
                delay(1000)
            }
        }
    }
    val title = when (state) {
        is VpnState.Connected -> "Подключено"
        VpnState.Connecting -> "Подключение…"
        VpnState.Stopping -> "Отключение…"
        is VpnState.Failed -> "Ошибка подключения"
        VpnState.Idle -> "Не подключено"
    }
    val subtitle = when (state) {
        is VpnState.Connected -> formatDuration(now - state.since)
        is VpnState.Failed -> state.message
        VpnState.Idle -> "Нажмите, чтобы подключиться"
        else -> " "
    }
    AnimatedContent(targetState = title, transitionSpec = { fadeIn() togetherWith fadeOut() }, label = "status") {
        Text(
            text = it,
            fontSize = 24.sp,
            fontWeight = FontWeight.SemiBold,
            color = when (state) {
                is VpnState.Connected -> Palette.Green
                is VpnState.Failed -> Palette.Red
                else -> Palette.TextPrimary
            },
        )
    }
    Spacer(Modifier.height(6.dp))
    Text(
        text = subtitle,
        color = Palette.TextSecondary,
        fontSize = if (state is VpnState.Connected) 18.sp else 14.sp,
        fontFamily = if (state is VpnState.Connected) FontFamily.Monospace else FontFamily.Default,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
    )
}

@Composable
private fun TrafficRow(traffic: Traffic, active: Boolean) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        TrafficCell(
            icon = Icons.Rounded.ArrowDownward,
            label = "Загрузка",
            speed = if (active) formatSpeed(traffic.downSpeed) else "—",
            total = if (active) formatBytes(traffic.down) else "",
            modifier = Modifier.weight(1f),
        )
        TrafficCell(
            icon = Icons.Rounded.ArrowUpward,
            label = "Отдача",
            speed = if (active) formatSpeed(traffic.upSpeed) else "—",
            total = if (active) formatBytes(traffic.up) else "",
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun TrafficCell(icon: ImageVector, label: String, speed: String, total: String, modifier: Modifier) {
    Panel(modifier = modifier) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier
                    .size(28.dp)
                    .clip(RoundedCornerShape(9.dp))
                    .background(Palette.SurfaceHighest),
                contentAlignment = Alignment.Center,
            ) {
                Icon(icon, contentDescription = null, tint = Palette.Cyan, modifier = Modifier.size(16.dp))
            }
            Spacer(Modifier.width(10.dp))
            Column {
                Text(label, color = Palette.TextMuted, fontSize = 11.sp)
                Text(speed, color = Palette.TextPrimary, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
            }
        }
        if (total.isNotEmpty()) {
            Spacer(Modifier.height(6.dp))
            Text("всего $total", color = Palette.TextMuted, fontSize = 11.sp)
        }
    }
}

@Composable
private fun ServerPanel(node: ServerNode, ping: Int?, engine: Engine, onClick: () -> Unit) {
    Panel(modifier = Modifier.fillMaxWidth(), onClick = onClick) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            FlagBadge(node.flag, size = 44)
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text("Сервер", color = Palette.TextMuted, fontSize = 11.sp)
                Text(
                    node.title,
                    color = Palette.TextPrimary,
                    fontSize = 16.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.height(4.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(protocolLabel(node.type), color = Palette.TextSecondary, fontSize = 12.sp)
                    Spacer(Modifier.width(10.dp))
                    if (node.supports(engine)) {
                        PingText(ping)
                    } else {
                        Text("не для ${engine.title}", color = Palette.Amber, fontSize = 12.sp)
                    }
                }
            }
            Icon(Icons.AutoMirrored.Rounded.KeyboardArrowRight, contentDescription = null, tint = Palette.TextSecondary)
        }
    }
}

@Composable
private fun EmptyPanel(onAdd: () -> Unit) {
    Panel(modifier = Modifier.fillMaxWidth(), onClick = onAdd) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            FlagBadge(null, size = 44)
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text("Нет серверов", color = Palette.TextPrimary, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                Text("Добавьте ссылку на подписку", color = Palette.TextSecondary, fontSize = 13.sp)
            }
            Icon(Icons.AutoMirrored.Rounded.KeyboardArrowRight, contentDescription = null, tint = Palette.TextSecondary)
        }
    }
}

@Composable
private fun SubscriptionPanel(subscription: Subscription) {
    Panel(modifier = Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                subscription.name,
                color = Palette.TextPrimary,
                fontSize = 14.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            expireLabel(subscription.expire)?.let {
                Text(it, color = if (it == "истекла") Palette.Red else Palette.TextSecondary, fontSize = 12.sp)
            }
        }
        if (subscription.total > 0) {
            Spacer(Modifier.height(10.dp))
            val progress = (subscription.used.toDouble() / subscription.total).toFloat().coerceIn(0f, 1f)
            LinearProgressIndicator(
                progress = { progress },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(6.dp)
                    .clip(RoundedCornerShape(3.dp)),
                color = if (progress > 0.9f) Palette.Red else Palette.Violet,
                trackColor = Palette.SurfaceHighest,
                strokeCap = StrokeCap.Round,
                gapSize = 0.dp,
                drawStopIndicator = {},
            )
            Spacer(Modifier.height(8.dp))
            Text(
                "${formatBytes(subscription.used)} из ${formatBytes(subscription.total)}",
                color = Palette.TextSecondary,
                fontSize = 12.sp,
            )
        } else {
            Spacer(Modifier.height(4.dp))
            Text("Трафик без ограничений", color = Palette.TextSecondary, fontSize = 12.sp)
        }
    }
}

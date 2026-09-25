package io.sublab.client.vpn

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import io.sublab.client.core.Engine
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

sealed interface VpnState {
    data object Idle : VpnState
    data object Connecting : VpnState
    data class Connected(val since: Long, val engine: Engine, val nodeName: String) : VpnState
    data object Stopping : VpnState
    data class Failed(val message: String) : VpnState
}

/** Общая точка управления туннелем для экрана, плитки и уведомления. */
object VpnController {
    private val _state = MutableStateFlow<VpnState>(VpnState.Idle)
    val state: StateFlow<VpnState> = _state.asStateFlow()

    internal fun update(state: VpnState) {
        _state.value = state
    }

    val isActive: Boolean
        get() = when (_state.value) {
            is VpnState.Connected, VpnState.Connecting -> true
            else -> false
        }

    /** Запуск; разрешение VpnService.prepare() должно быть уже получено. */
    fun start(context: Context) = send(context, SubLabVpnService.ACTION_START)

    /** Перезапуск на текущих настройках: смена ядра или сервера без разрыва TUN. */
    fun restart(context: Context) = send(context, SubLabVpnService.ACTION_RESTART)

    fun stop(context: Context) = send(context, SubLabVpnService.ACTION_STOP)

    private fun send(context: Context, action: String) {
        val intent = Intent(context, SubLabVpnService::class.java).setAction(action)
        if (action == SubLabVpnService.ACTION_STOP) {
            context.startService(intent)
        } else {
            ContextCompat.startForegroundService(context, intent)
        }
    }
}

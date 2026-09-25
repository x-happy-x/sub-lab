package io.sublab.client

import android.app.Application
import io.sublab.client.core.CoreBridge
import io.sublab.client.data.Repository

class SubLabApp : Application() {
    lateinit var repository: Repository
        private set

    override fun onCreate() {
        super.onCreate()
        instance = this
        CoreBridge.init(filesDir.resolve("core").absolutePath)
        repository = Repository(this)
    }

    companion object {
        lateinit var instance: SubLabApp
            private set
    }
}

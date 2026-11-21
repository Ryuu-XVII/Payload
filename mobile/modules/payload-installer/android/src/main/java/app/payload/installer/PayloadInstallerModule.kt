package app.payload.installer

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.os.SystemClock
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean

class PayloadInstallerModule : Module() {
  private val context get() = requireNotNull(appContext.reactContext).applicationContext
  private val activity get() = requireNotNull(appContext.currentActivity)
  private var missingSessionId = -1
  private var missingSince = 0L

  override fun definition() = ModuleDefinition {
    Name("PayloadInstaller")
    Events("downloadProgress")

    Function("device") {
      val ownPackage = requireNotNull(installedPackage(context.packageName))
      mapOf("sdk" to Build.VERSION.SDK_INT, "packageId" to ownPackage.packageName,
        "versionCode" to versionCode(ownPackage).toDouble(), "versionName" to ownPackage.versionName)
    }

    AsyncFunction("lookup") { packages: List<String> ->
      packages.associateWith { id ->
        installedPackage(id)?.let { info ->
          mapOf("versionCode" to versionCode(info).toDouble(), "versionName" to info.versionName)
        }
      }
    }

    AsyncFunction("openApp") { id: String ->
      val intent = context.packageManager.getLaunchIntentForPackage(id)
        ?: throw failure("OPEN", "Android could not open this app.")
      activity.startActivity(intent)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("canInstall") { canInstall() }

    AsyncFunction("openInstallSettings") {
      activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")))
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("hasDownload") { id: String, version: Double, size: Double, sha256: String ->
      downloadedApk(id, version.toLong(), sha256).let { it.isFile && it.length() == size.toLong() }
    }

    AsyncFunction("downloadApk") { url: String, id: String, version: Double, size: Double, sha256: String ->
      withTransfer {
        saveDownload(url, id, version.toLong(), size.toLong(), sha256)
      }
    }

    AsyncFunction("startInstall") { id: String, version: Double, size: Double, sha256: String ->
      withTransfer {
        prepareInstall(id, version.toLong(), size.toLong(), sha256)
      }
    }

    AsyncFunction("installState") { state() }.runOnQueue(Queues.MAIN)

    AsyncFunction("launchConfirmation") {
      val current = InstallState.read(context) ?: throw failure("INTERRUPTED", "Installation was interrupted.")
      if (current.getString("stage") != "confirm") return@AsyncFunction null
      val intent = InstallState.confirmation()
        ?: throw failure("INTERRUPTED", "Installation was interrupted.")
      activity.startActivity(intent)
      InstallState.write(context, current.put("stage", "waiting"))
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("clearResult") { id: Int ->
      val current = InstallState.read(context)
      if (current?.optString("stage") == "finished") InstallState.forget(context, id)
    }.runOnQueue(Queues.MAIN)
  }

  private fun canInstall(): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.packageManager.canRequestPackageInstalls()

  @Suppress("DEPRECATION")
  private fun installedPackage(id: String): PackageInfo? = try {
    context.packageManager.getPackageInfo(id, 0)
  } catch (_: PackageManager.NameNotFoundException) {
    null
  }

  @Suppress("DEPRECATION")
  private fun versionCode(info: PackageInfo): Long =
    if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong() and 0xffffffffL

  private fun state(): Map<String, Any>? {
    val current = InstallState.read(context) ?: return null
    val sessionId = current.getInt("sessionId")
    val packageId = current.getString("packageId")
    var stage = current.getString("stage")
    // Replacing Payload can kill its process before it receives the final installer callback.
    if (packageId == context.packageName && stage in listOf("waiting", "confirm") &&
      installedPackage(packageId)?.let { versionCode(it) >= current.getLong("versionCode") } == true) {
      stage = "finished"
      InstallState.write(context, current.put("stage", stage).put("result", "success"))
    }
    val installer = context.packageManager.packageInstaller
    val session = if (stage == "finished") null else installer.getSessionInfo(sessionId)
    if (!busy.get() && stage != "finished") {
      if (session == null && missingSessionId != sessionId) {
        missingSessionId = sessionId
        missingSince = SystemClock.elapsedRealtime()
      }
      if (session != null) missingSessionId = -1
      val noResult = session == null && SystemClock.elapsedRealtime() - missingSince > 3000
      val lostConfirmation = stage == "confirm" && InstallState.confirmation() == null
      val lostCommit = stage == "preparing"
      if (noResult || lostConfirmation || lostCommit) {
        if (session != null) runCatching { installer.abandonSession(sessionId) }
        stage = "finished"
        val installed = noResult && !lostCommit &&
          installedPackage(packageId)?.let { versionCode(it) >= current.getLong("versionCode") } == true
        InstallState.write(context, current.put("stage", stage).put("result", if (installed) "success" else "interrupted"))
      }
    }
    val result = current.optString("result")
    return buildMap {
      put("sessionId", sessionId)
      put("packageId", packageId)
      put("stage", stage)
      if (stage != "finished" && session != null) put("progress", session.progress.toDouble())
      if (result.isNotEmpty()) put("result", result)
    }
  }

  private inline fun withTransfer(work: () -> Unit) {
    if (!busy.compareAndSet(false, true)) throw failure("BUSY", "An install is already in progress.")
    try {
      if (InstallState.read(context) != null) throw failure("BUSY", "Finish the current install first.")
      work()
    } finally {
      busy.set(false)
    }
  }

  private fun downloadedApk(id: String, version: Long, sha256: String): File {
    require(packagePattern.matches(id) && version > 0 && digestPattern.matches(sha256))
    return File(File(context.noBackupFilesDir, "payload-downloads/$id"), "$version-$sha256.apk")
  }

  private fun saveDownload(url: String, id: String, version: Long, size: Long, sha256: String) {
    val apk = downloadedApk(id, version, sha256)
    if (apk.isFile && apk.length() == size) return
    val directory = requireNotNull(apk.parentFile)
    val partial = File(directory, "download.part.apk")
    try {
      directory.mkdirs()
      download(url, partial, id, size, sha256)
      @Suppress("DEPRECATION")
      val archive = context.packageManager.getPackageArchiveInfo(partial.path, 0)
      if (archive == null || archive.packageName != id || versionCode(archive) != version ||
        (archive.applicationInfo?.minSdkVersion ?: Int.MAX_VALUE) > Build.VERSION.SDK_INT) {
        throw failure("INCOMPATIBLE", "This APK is incompatible or does not match the selected release.")
      }
      if (!partial.renameTo(apk)) throw IOException("Could not save the APK")
      directory.listFiles()?.filter { it != apk && it.extension == "apk" }?.forEach { it.delete() }
    } catch (error: IOException) {
      throw failure("DOWNLOAD", "Could not save the APK. Check available storage and retry.")
    } finally {
      partial.delete()
    }
  }

  private fun prepareInstall(id: String, version: Long, size: Long, sha256: String) {
    if (!canInstall()) throw failure("PERMISSION", "Allow installs from Payload in Android settings.")
    if (id == context.packageName && version <= versionCode(requireNotNull(installedPackage(id)))) {
      throw failure("CURRENT_VERSION", "Payload is already running this version or a newer one.")
    }
    val apk = downloadedApk(id, version, sha256)
    if (!apk.isFile || apk.length() != size) throw failure("MISSING_APK", "Download the APK before installing.")
    val installer = context.packageManager.packageInstaller
    var sessionId: Int? = null
    try {
      val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
        setAppPackageName(id)
        setSize(size)
        if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
      }
      val created = installer.createSession(params)
      sessionId = created
      InstallState.write(context, JSONObject().put("sessionId", created).put("packageId", id)
        .put("versionCode", version).put("stage", "preparing"))
      installer.openSession(created).use { session ->
        val digest = MessageDigest.getInstance("SHA-256")
        session.openWrite("base.apk", 0, size).use { output ->
          apk.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            var copied = 0L
            var lastProgress = -1
            while (true) {
              val count = input.read(buffer)
              if (count < 0) break
              output.write(buffer, 0, count)
              digest.update(buffer, 0, count)
              copied += count
              val progress = (copied * 100 / size).toInt().coerceAtMost(100)
              if (progress != lastProgress) {
                session.setStagingProgress(progress / 100f)
                lastProgress = progress
              }
            }
          }
          if (digest.hex() != sha256) {
            apk.delete()
            throw failure("INTEGRITY", "The saved APK did not pass its SHA-256 check. Download it again.")
          }
          session.fsync(output)
        }
        val callback = Intent(context, InstallResultReceiver::class.java)
          .setAction("app.payload.installer.INSTALL_RESULT")
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or
          (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
        val receiver = PendingIntent.getBroadcast(context, created, callback, flags)
        session.commit(receiver.intentSender)
        completeCommit(created)
      }
    } catch (error: Exception) {
      sessionId?.let {
        runCatching { installer.abandonSession(it) }
        InstallState.forget(context, it)
      }
      if (error is CodedException) throw error
      throw failure("STAGING", "Android could not prepare the APK. Check available storage and retry.")
    }
  }

  private fun completeCommit(id: Int) {
    // Persist the committed state without overwriting a callback that arrived first.
    synchronized(InstallState) {
      val current = InstallState.read(context) ?: return
      if (current.getInt("sessionId") == id && current.getString("stage") == "preparing") {
        InstallState.write(context, current.put("stage", "waiting"))
      }
    }
  }

  private fun download(address: String, file: File, id: String, size: Long, expected: String) {
    val digest = MessageDigest.getInstance("SHA-256")
    var total = 0L
    try {
      val uri = URI(address)
      val debug = context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
      val local = uri.host in listOf("127.0.0.1", "localhost", "10.0.2.2")
      if (uri.scheme != "https" && !(debug && local && uri.scheme == "http")) {
        throw IOException("Invalid download protocol")
      }
      val connection = uri.toURL().openConnection() as HttpURLConnection
      try {
        connection.connectTimeout = 20_000
        connection.readTimeout = 30_000
        connection.instanceFollowRedirects = false
        connection.useCaches = false
        connection.setRequestProperty("Accept-Encoding", "identity")
        if (connection.responseCode != 200) throw IOException("Download request failed")
        var lastUpdate = 0L
        connection.inputStream.use { input ->
          file.outputStream().buffered().use { output ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
              val count = input.read(buffer)
              if (count < 0) break
              total += count
              if (total > size) throw failure("INTEGRITY", "The APK did not match its expected size.")
              digest.update(buffer, 0, count)
              output.write(buffer, 0, count)
              val now = SystemClock.elapsedRealtime()
              if (total == size || now - lastUpdate >= 250) {
                sendEvent("downloadProgress", mapOf("packageId" to id, "received" to total.toDouble()))
                lastUpdate = now
              }
            }
          }
        }
      } finally {
        connection.disconnect()
      }
    } catch (error: Exception) {
      if (error is CodedException) throw error
      throw failure("DOWNLOAD", "The download failed. Check your connection and retry.")
    }
    if (total < size) throw failure("DOWNLOAD", "The download ended early. Retry to download the full APK.")
    val actual = digest.hex()
    if (actual != expected) throw failure("INTEGRITY", "The download did not pass its SHA-256 check. Retry.")
  }

  private fun MessageDigest.hex() = digest().joinToString("") { "%02x".format(it) }

  private fun failure(code: String, message: String) = CodedException("ERR_PAYLOAD_$code", message, null)

  companion object {
    private val packagePattern = Regex("[A-Za-z][\\w]*(\\.[A-Za-z][\\w]*)+")
    private val digestPattern = Regex("[a-f0-9]{64}")
    private val busy = AtomicBoolean(false)
  }
}

package com.roozhaye.manozari

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.util.Log
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsVitsModelConfig
import java.io.File
import java.io.FileOutputStream

object OfflinePersianTts {
    @JvmStatic
    fun speak(context: Context, text: String, rate: Float): Boolean {
        var engine: OfflineTts? = null
        var track: AudioTrack? = null
        return try {
            val root = File(context.filesDir, "hamseda_offline_tts/gyro")
            val model = File(root, "model.onnx")
            val tokens = File(root, "tokens.txt")
            val espeak = File(root, "espeak-ng-data")
            if (!model.isFile || !tokens.isFile || !espeak.isDirectory) {
                copyAsset(context, "offline_tts/gyro/model.onnx", model)
                copyAsset(context, "offline_tts/gyro/tokens.txt", tokens)
                copyAssetDir(context, "offline_tts/espeak-ng-data", espeak)
            }
            check(model.isFile && tokens.isFile && espeak.isDirectory) { "Offline TTS assets missing" }

            val vits = OfflineTtsVitsModelConfig(
                model = model.absolutePath,
                lexicon = "",
                tokens = tokens.absolutePath,
                dataDir = espeak.absolutePath,
                noiseScale = 0.667f,
                noiseScaleW = 0.8f,
                lengthScale = 1.0f
            )
            val modelConfig = OfflineTtsModelConfig(
                vits = vits,
                numThreads = (Runtime.getRuntime().availableProcessors() / 2).coerceIn(1, 4),
                debug = false,
                provider = "cpu"
            )
            engine = OfflineTts(OfflineTtsConfig(model = modelConfig))
            val generated = engine.generate(text, 0, rate.coerceIn(0.65f, 1.5f))
            val samples = generated.samples
            check(samples.isNotEmpty()) { "No speech samples generated" }
            val pcm = ShortArray(samples.size) { i ->
                (samples[i].coerceIn(-1f, 1f) * 32767f).toInt().toShort()
            }
            val sampleRate = generated.sampleRate
            val minBytes = AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
            track = AudioTrack.Builder()
                .setAudioAttributes(AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANT)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build())
                .setAudioFormat(AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(sampleRate)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build())
                .setBufferSizeInBytes(maxOf(minBytes, pcm.size * 2))
                .setTransferMode(AudioTrack.MODE_STATIC)
                .build()
            track.write(pcm, 0, pcm.size)
            track.play()
            val durationMs = pcm.size * 1000L / sampleRate
            val deadline = System.currentTimeMillis() + durationMs + 5000
            while (track.playbackHeadPosition < pcm.size && System.currentTimeMillis() < deadline) {
                Thread.sleep(40)
            }
            true
        } catch (t: Throwable) {
            Log.e("HamsedaOfflineTTS", "Offline Persian TTS failed", t)
            false
        } finally {
            try { track?.stop() } catch (_: Exception) {}
            track?.release()
            engine?.release()
        }
    }

    private fun copyAsset(context: Context, asset: String, target: File) {
        if (target.isFile && target.length() > 0) return
        target.parentFile?.mkdirs()
        val temp = File(target.absolutePath + ".tmp")
        context.assets.open(asset).use { input ->
            FileOutputStream(temp).use { output -> input.copyTo(output); output.fd.sync() }
        }
        if (target.exists()) target.delete()
        check(temp.renameTo(target)) { "Cannot install asset $asset" }
    }

    private fun copyAssetDir(context: Context, assetDir: String, targetDir: File) {
        val children = context.assets.list(assetDir) ?: return
        targetDir.mkdirs()
        for (child in children) {
            val assetPath = "$assetDir/$child"
            val nested = context.assets.list(assetPath)
            val target = File(targetDir, child)
            if (nested != null && nested.isNotEmpty()) copyAssetDir(context, assetPath, target)
            else if (!target.isFile || target.length() == 0L) copyAsset(context, assetPath, target)
        }
    }
}
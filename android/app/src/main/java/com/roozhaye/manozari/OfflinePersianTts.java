package com.roozhaye.manozari;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;

import com.k2fsa.sherpa.onnx.GeneratedAudio;
import com.k2fsa.sherpa.onnx.OfflineTts;
import com.k2fsa.sherpa.onnx.OfflineTtsConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsVitsModelConfig;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;

public final class OfflinePersianTts {
    private OfflinePersianTts() {}

    public static boolean speak(Context context, String text, float rate) {
        OfflineTts engine = null;
        AudioTrack track = null;
        try {
            File root = new File(context.getFilesDir(), "hamseda_offline_tts/gyro");
            File model = new File(root, "model.onnx");
            File tokens = new File(root, "tokens.txt");
            File espeak = new File(root, "espeak-ng-data");
            if (!model.exists() || !tokens.exists() || !espeak.isDirectory()) {
                copyAsset(context, "offline_tts/gyro/model.onnx", model);
                copyAsset(context, "offline_tts/gyro/tokens.txt", tokens);
                copyAssetDir(context, "offline_tts/espeak-ng-data", espeak);
            }
            if (!model.isFile() || !tokens.isFile() || !espeak.isDirectory()) return false;

            OfflineTtsVitsModelConfig vits = OfflineTtsVitsModelConfig.builder()
                    .setModel(model.getAbsolutePath())
                    .setTokens(tokens.getAbsolutePath())
                    .setDataDir(espeak.getAbsolutePath())
                    .setNoiseScale(0.667f)
                    .setNoiseScaleW(0.8f)
                    .setLengthScale(1.0f)
                    .build();
            OfflineTtsModelConfig modelConfig = OfflineTtsModelConfig.builder()
                    .setVits(vits)
                    .setNumThreads(Math.max(1, Math.min(4, Runtime.getRuntime().availableProcessors() / 2)))
                    .setDebug(false)
                    .setProvider("cpu")
                    .build();
            engine = new OfflineTts(OfflineTtsConfig.builder().setModel(modelConfig).build());
            GeneratedAudio generated = engine.generate(text, 0, Math.max(0.65f, Math.min(1.5f, rate)));
            float[] samples = generated.getSamples();
            if (samples == null || samples.length == 0) return false;

            short[] pcm = new short[samples.length];
            for (int i = 0; i < samples.length; i++) {
                float value = Math.max(-1f, Math.min(1f, samples[i]));
                pcm[i] = (short) (value * 32767f);
            }
            int sampleRate = generated.getSampleRate();
            int minBytes = AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
            int bufferBytes = Math.max(minBytes, pcm.length * 2);
            track = new AudioTrack.Builder()
                    .setAudioAttributes(new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_ASSISTANT)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                            .build())
                    .setAudioFormat(new AudioFormat.Builder()
                            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                            .setSampleRate(sampleRate)
                            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                            .build())
                    .setBufferSizeInBytes(bufferBytes)
                    .setTransferMode(AudioTrack.MODE_STATIC)
                    .build();
            track.write(pcm, 0, pcm.length);
            track.play();
            long durationMs = (long) (pcm.length * 1000.0 / sampleRate);
            long deadline = System.currentTimeMillis() + durationMs + 5000;
            while (track.getPlaybackHeadPosition() < pcm.length && System.currentTimeMillis() < deadline) {
                Thread.sleep(40);
            }
            return true;
        } catch (Throwable error) {
            android.util.Log.e("HamsedaOfflineTTS", "Offline Persian TTS failed", error);
            return false;
        } finally {
            if (track != null) {
                try { track.stop(); } catch (Exception ignored) {}
                track.release();
            }
            if (engine != null) engine.release();
        }
    }

    private static void copyAsset(Context context, String asset, File target) throws Exception {
        if (target.exists() && target.length() > 0) return;
        File parent = target.getParentFile();
        if (parent != null && !parent.exists()) parent.mkdirs();
        File temp = new File(target.getAbsolutePath() + ".tmp");
        try (InputStream in = context.getAssets().open(asset);
             FileOutputStream out = new FileOutputStream(temp)) {
            byte[] buffer = new byte[32768];
            int count;
            while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
            out.getFD().sync();
        }
        if (target.exists()) target.delete();
        if (!temp.renameTo(target)) throw new Exception("Could not install offline TTS asset: " + asset);
    }

    private static void copyAssetDir(Context context, String assetDir, File targetDir) throws Exception {
        String[] children = context.getAssets().list(assetDir);
        if (children == null) return;
        if (!targetDir.exists()) targetDir.mkdirs();
        for (String child : children) {
            String assetPath = assetDir + "/" + child;
            String[] nested = context.getAssets().list(assetPath);
            File target = new File(targetDir, child);
            if (nested != null && nested.length > 0) {
                copyAssetDir(context, assetPath, target);
            } else if (!target.exists() || target.length() == 0) {
                copyAsset(context, assetPath, target);
            }
        }
    }
}
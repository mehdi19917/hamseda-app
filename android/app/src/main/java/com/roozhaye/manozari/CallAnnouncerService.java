package com.roozhaye.manozari;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Base64;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.atomic.AtomicLong;

public class CallAnnouncerService extends Service {
    public static final String CHANNEL_ID = "rmz_call_announcer_channel";
    public static final int NOTIF_ID = 7002;
    public static final int ALERT_NOTIF_ID = 7003;
    public static final String EXTRA_TEXT = "spoken_text";
    public static final String EXTRA_TITLE = "notif_title";
    public static final String EXTRA_IS_MALE = "is_male";
    public static final String EXTRA_VOICE_NAME = "voice_name";
    public static final String EXTRA_REPEAT = "repeat_count";
    public static final String EXTRA_IS_CALL = "is_call";
    private static final String DEFAULT_API_BASE = "https://roozhaye-manozari-7.ai.studio";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private volatile boolean cancelled = false;
    private volatile int activeSessionId = 0;
    private MediaPlayer activePlayer = null;
    private PowerManager.WakeLock wakeLock = null;
    private AudioManager audioManager = null;
    private AudioFocusRequest focusRequest = null;

    public static void announce(Context context, String title, String text, boolean isMale, int repeatCount, boolean isCall) {
        SharedPreferences prefs = context.getSharedPreferences("rmz_native_prefs", Context.MODE_PRIVATE);
        String defaultVoice = prefs.getString("default_voice_name", isMale ? "Charon" : "Kore");
        String resolvedVoice = defaultVoice;
        if (isMale && !"Charon".equals(defaultVoice) && !"Fenrir".equals(defaultVoice)) {
            resolvedVoice = "Charon";
        } else if (!isMale && ("Charon".equals(defaultVoice) || "Fenrir".equals(defaultVoice))) {
            resolvedVoice = "Kore";
        }
        announce(context, title, text, resolvedVoice, isMale, repeatCount, isCall);
    }

    public static void announce(Context context, String title, String text, String voiceName, boolean isMale, int repeatCount, boolean isCall) {
        // All native announcements use Negin, including incoming calls and SMS.
        voiceName = "Kore";
        isMale = false;
        final Context appCtx = context.getApplicationContext();
        final int safeRepeat = Math.max(1, Math.min(2, repeatCount));
        Intent intent = new Intent(appCtx, CallAnnouncerService.class);
        intent.putExtra(EXTRA_TITLE, title);
        intent.putExtra(EXTRA_TEXT, text);
        intent.putExtra(EXTRA_IS_MALE, isMale);
        intent.putExtra(EXTRA_VOICE_NAME, voiceName);
        intent.putExtra(EXTRA_REPEAT, safeRepeat);
        intent.putExtra(EXTRA_IS_CALL, isCall);

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                appCtx.startForegroundService(intent);
                return;
            }
            appCtx.startService(intent);
        } catch (Exception e) {
            // Android 12–15 (HyperOS/MIUI) may throw ForegroundServiceStartNotAllowedException from background;
            // fall back immediately to direct worker-thread MediaPlayer + WakeLock inside app process.
            playDirectFromBackground(appCtx, title, text, voiceName, isMale, safeRepeat, isCall);
        }
    }

    private static volatile MediaPlayer activeDirectPlayer = null;
    private static final AtomicLong GLOBAL_PLAY_GEN = new AtomicLong(0);

    private static void stopDirectPlayerOnly() {
        if (activeDirectPlayer != null) {
            try {
                if (activeDirectPlayer.isPlaying()) activeDirectPlayer.stop();
            } catch (Exception ignored) {
            }
            try {
                activeDirectPlayer.release();
            } catch (Exception ignored) {
            }
            activeDirectPlayer = null;
        }
    }

    public static void stopActive(Context context) {
        GLOBAL_PLAY_GEN.incrementAndGet();
        stopDirectPlayerOnly();
        BilingualSpeechHelper.stopActiveTts();
        try {
            context.stopService(new Intent(context, CallAnnouncerService.class));
        } catch (Exception ignored) {
        }
    }

    private static boolean isRiffWav(byte[] data) {
        return data != null
                && data.length > 44
                && data[0] == 'R'
                && data[1] == 'I'
                && data[2] == 'F'
                && data[3] == 'F';
    }

    public static boolean saveWavToCache(Context context, String text, String voiceName, byte[] audioBytes) {
        if (text == null || text.trim().isEmpty() || !isRiffWav(audioBytes)) {
            return false;
        }
        try {
            File cacheDir = new File(context.getCacheDir(), "rmz_tts_wav");
            if (!cacheDir.exists()) {
                cacheDir.mkdirs();
            }
            String key = "v3_" + sha256Hex(voiceName + "::" + text.trim());
            File cachedFile = new File(cacheDir, key + ".wav");
            try (FileOutputStream fos = new FileOutputStream(cachedFile)) {
                fos.write(audioBytes);
            }
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    private static void playDirectFromBackground(
            Context appCtx,
            String title,
            String rawText,
            String voiceName,
            boolean isMale,
            int repeatCount,
            boolean isCall
    ) {
        final String text = rawText != null ? rawText.trim() : "";
        if (text.isEmpty()) return;

        final long myGen = GLOBAL_PLAY_GEN.incrementAndGet();
        stopDirectPlayerOnly();
        BilingualSpeechHelper.stopActiveTts();

        new Thread(() -> {
            PowerManager.WakeLock localLock = null;
            try {
                PowerManager pm = (PowerManager) appCtx.getSystemService(Context.POWER_SERVICE);
                if (pm != null) {
                    localLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "RoozhayeManOZari::DirectBgLock");
                    localLock.setReferenceCounted(false);
                    localLock.acquire(25000L);
                }
                Thread.sleep(isCall ? 220L : 100L);
                if (myGen != GLOBAL_PLAY_GEN.get()) return;
                File audioFile = fetchOrGetCachedAudioStatic(appCtx, text, voiceName);
                if (myGen != GLOBAL_PLAY_GEN.get()) return;
                if (audioFile != null && audioFile.exists() && audioFile.length() > 44) {
                    final MediaPlayer mp = new MediaPlayer();
                    AudioAttributes attrs = new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                            .build();
                    mp.setAudioAttributes(attrs);
                    mp.setDataSource(audioFile.getAbsolutePath());
                    mp.prepare();
                    if (myGen != GLOBAL_PLAY_GEN.get()) {
                        try {
                            mp.release();
                        } catch (Exception ignored) {
                        }
                        return;
                    }
                    stopDirectPlayerOnly();
                    BilingualSpeechHelper.stopActiveTts();
                    activeDirectPlayer = mp;
                    final PowerManager.WakeLock lockToRelease = localLock;
                    final int[] remaining = {Math.max(1, Math.min(2, repeatCount))};
                    mp.setOnCompletionListener(player -> {
                        remaining[0]--;
                        if (remaining[0] > 0 && myGen == GLOBAL_PLAY_GEN.get()) {
                            try {
                                player.seekTo(0);
                                player.start();
                                return;
                            } catch (Exception ignored) {
                            }
                        }
                        if (activeDirectPlayer == player) activeDirectPlayer = null;
                        try {
                            player.release();
                        } catch (Exception ignored) {
                        }
                        try {
                            if (lockToRelease != null && lockToRelease.isHeld()) lockToRelease.release();
                        } catch (Exception ignored) {
                        }
                    });
                    mp.setOnErrorListener((player, what, extra) -> {
                        if (activeDirectPlayer == player) activeDirectPlayer = null;
                        try {
                            player.release();
                        } catch (Exception ignored) {
                        }
                        try {
                            if (lockToRelease != null && lockToRelease.isHeld()) lockToRelease.release();
                        } catch (Exception ignored) {
                        }
                        postDirectFallbackNotification(appCtx, title, text);
                        return true;
                    });
                    mp.start();
                    localLock = null; // released on completion
                    return;
                }
            } catch (Exception ignored) {
            } finally {
                try {
                    if (localLock != null && localLock.isHeld()) localLock.release();
                } catch (Exception ignored) {
                }
            }
            if (myGen != GLOBAL_PLAY_GEN.get()) return;
            new Handler(Looper.getMainLooper()).post(() -> {
                if (myGen != GLOBAL_PLAY_GEN.get()) return;
                String spoken = repeatCount == 2 ? (text + " . " + text) : text;
                BilingualSpeechHelper.speak(appCtx, spoken, isMale, 1.0f, false, success -> {
                    if (!success && myGen == GLOBAL_PLAY_GEN.get()) {
                        postDirectFallbackNotification(appCtx, title, text);
                    }
                });
            });
        }).start();
    }

    @Override
    public void onCreate() {
        super.onCreate();
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "اعلام صوتی تماس و پیام‌ها",
                    NotificationManager.IMPORTANCE_LOW
            );
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(channel);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        final int sessionId = ++activeSessionId;
        final long myGen = GLOBAL_PLAY_GEN.incrementAndGet();
        cancelled = false;
        stopActivePlayer();
        stopDirectPlayerOnly();
        BilingualSpeechHelper.stopActiveTts();
        abandonAudioFocus();
        handler.removeCallbacksAndMessages(null);

        String title = intent != null ? intent.getStringExtra(EXTRA_TITLE) : "اعلام صوتی";
        String rawText = intent != null ? intent.getStringExtra(EXTRA_TEXT) : "";
        String text = rawText != null ? rawText.trim() : "";
        boolean isMale = false;
        String extraVoice = "Kore";
        int repeat = intent != null ? Math.max(1, Math.min(2, intent.getIntExtra(EXTRA_REPEAT, 1))) : 1;
        boolean isCall = intent != null && intent.getBooleanExtra(EXTRA_IS_CALL, false);

        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle(title != null ? title : "هم‌صدا")
                .setContentText(text)
                .setSmallIcon(R.drawable.ic_stat_rmz)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(NOTIF_ID, notification);
            }
        } catch (Exception ignored) {
            // Continue safely even if OS prevents FGS elevation in restricted background state
        }

        if (text.isEmpty()) {
            stopSelfSafely();
            return START_NOT_STICKY;
        }

        acquireWakeLock();

        final String voiceName = (extraVoice != null && !extraVoice.trim().isEmpty())
                ? extraVoice.trim()
                : (isMale ? "Charon" : "Kore");

        handler.postDelayed(() -> {
            if (cancelled || sessionId != activeSessionId || myGen != GLOBAL_PLAY_GEN.get()) return;
            new Thread(() -> playOnlineOrFallback(sessionId, myGen, title, text, voiceName, isMale, repeat, isCall)).start();
        }, isCall ? 250 : 120);

        // Safety stop after 55s
        handler.postDelayed(() -> {
            if (sessionId == activeSessionId) {
                stopSelfSafely();
            }
        }, 55000);
        return START_NOT_STICKY;
    }

    private void playOnlineOrFallback(int sessionId, long myGen, String title, String singleText, String voiceName, boolean isMale, int repeat, boolean isCall) {
        if (cancelled || sessionId != activeSessionId || myGen != GLOBAL_PLAY_GEN.get()) return;

        File wavFile = fetchOrGetCachedWav(singleText, voiceName);
        if (cancelled || sessionId != activeSessionId || myGen != GLOBAL_PLAY_GEN.get()) return;

        if (wavFile != null && wavFile.exists() && wavFile.length() > 44) {
            handler.post(() -> {
                if (cancelled || sessionId != activeSessionId || myGen != GLOBAL_PLAY_GEN.get()) return;
                if (!playWavFile(sessionId, wavFile, repeat)) {
                    if (myGen == GLOBAL_PLAY_GEN.get()) {
                        fallbackOfflineSpeak(sessionId, title, singleText, isMale, repeat, isCall);
                    }
                }
            });
            return;
        }

        handler.post(() -> {
            if (!cancelled && sessionId == activeSessionId && myGen == GLOBAL_PLAY_GEN.get()) {
                fallbackOfflineSpeak(sessionId, title, singleText, isMale, repeat, isCall);
            }
        });
    }

    private void fallbackOfflineSpeak(int sessionId, String title, String singleText, boolean isMale, int repeat, boolean isCall) {
        String spoken = repeat == 2 ? (singleText + " . " + singleText) : singleText;
        BilingualSpeechHelper.speak(this, spoken, isMale, 1.0f, false, success -> {
            if (!success && sessionId == activeSessionId) {
                postDirectFallbackNotification(this, title != null ? title : "هم‌صدا", singleText);
            }
            if (sessionId == activeSessionId) {
                stopSelfSafely();
            }
        });
    }

    private boolean playWavFile(int sessionId, File wavFile, int remainingPlays) {
        try {
            stopActivePlayer();
            requestTransientAudioFocus();

            MediaPlayer mp = new MediaPlayer();
            AudioAttributes attrs = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build();
            mp.setAudioAttributes(attrs);
            mp.setDataSource(wavFile.getAbsolutePath());
            mp.setOnCompletionListener(player -> {
                stopActivePlayer();
                if (cancelled || sessionId != activeSessionId) {
                    abandonAudioFocus();
                    return;
                }
                if (remainingPlays > 1) {
                    handler.postDelayed(() -> {
                        if (!cancelled && sessionId == activeSessionId) {
                            if (!playWavFile(sessionId, wavFile, remainingPlays - 1)) {
                                abandonAudioFocus();
                                stopSelfSafely();
                            }
                        }
                    }, 350);
                } else {
                    abandonAudioFocus();
                    stopSelfSafely();
                }
            });
            mp.setOnErrorListener((player, what, extra) -> {
                stopActivePlayer();
                abandonAudioFocus();
                if (sessionId == activeSessionId) {
                    stopSelfSafely();
                }
                return true;
            });
            mp.prepare();
            if (cancelled || sessionId != activeSessionId) {
                mp.release();
                abandonAudioFocus();
                return false;
            }
            activePlayer = mp;
            mp.start();
            return true;
        } catch (Exception ignored) {
            stopActivePlayer();
            abandonAudioFocus();
            return false;
        }
    }

    private File fetchOrGetCachedWav(String text, String voiceName) {
        return fetchOrGetCachedAudioStatic(this, text, voiceName);
    }

    private static File fetchOrGetCachedAudioStatic(Context context, String text, String voiceName) {
        try {
            File cacheDir = new File(context.getCacheDir(), "rmz_tts_wav");
            if (!cacheDir.exists()) {
                cacheDir.mkdirs();
            }
            String key = "v3_" + sha256Hex(voiceName + "::" + text.trim());
            File wavFile = new File(cacheDir, key + ".wav");
            if (wavFile.exists() && wavFile.length() > 44) {
                return wavFile;
            }

            SharedPreferences prefs = context.getSharedPreferences("rmz_native_prefs", MODE_PRIVATE);
            String baseUrl = prefs.getString("server_base_url", DEFAULT_API_BASE);
            if (baseUrl == null || baseUrl.trim().isEmpty()) {
                baseUrl = DEFAULT_API_BASE;
            }
            baseUrl = baseUrl.replaceAll("/+$", "");

            URL url = new URL(baseUrl + "/api/tts");
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(7000);
            conn.setReadTimeout(16000);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");

            JSONObject body = new JSONObject();
            String safeText = text.length() > 1200 ? text.substring(0, 1200) : text;
            body.put("text", safeText);
            body.put("voiceName", voiceName);
            body.put("style", "Clear fluent Tehran Persian and crisp English pronunciation announcer.");

            try (OutputStream os = conn.getOutputStream()) {
                os.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }

            if (conn.getResponseCode() != 200) {
                conn.disconnect();
                return null;
            }

            StringBuilder sb = new StringBuilder();
            try (BufferedReader br = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = br.readLine()) != null) {
                    sb.append(line);
                }
            }
            conn.disconnect();

            JSONObject resp = new JSONObject(sb.toString());
            if (resp.optBoolean("fallbackOffline", false)) {
                return null;
            }
            String audioB64 = resp.optString("audioBase64", "");
            if (audioB64.isEmpty()) {
                return null;
            }

            byte[] audioBytes = Base64.decode(audioB64, Base64.DEFAULT);
            if (audioBytes.length <= 44) {
                return null;
            }
            String provider = resp.optString("provider", "");
            boolean isStudioWav = "gemini".equals(provider) && isRiffWav(audioBytes);
            File targetFile = isStudioWav
                    ? wavFile
                    : new File(cacheDir, "tmp_" + key + ".mp3");
            try (FileOutputStream fos = new FileOutputStream(targetFile)) {
                fos.write(audioBytes);
            }
            return targetFile;
        } catch (Exception ignored) {
            return null;
        }
    }

    private void requestTransientAudioFocus() {
        if (audioManager == null) return;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                AudioAttributes attrs = new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build();
                focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                        .setAudioAttributes(attrs)
                        .setAcceptsDelayedFocusGain(false)
                        .build();
                audioManager.requestAudioFocus(focusRequest);
            } else {
                audioManager.requestAudioFocus(
                        null,
                        AudioManager.STREAM_MUSIC,
                        AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK
                );
            }
        } catch (Exception ignored) {
        }
    }

    private void abandonAudioFocus() {
        if (audioManager == null) return;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && focusRequest != null) {
                audioManager.abandonAudioFocusRequest(focusRequest);
                focusRequest = null;
            }
        } catch (Exception ignored) {
        }
    }

    private void acquireWakeLock() {
        try {
            if (wakeLock == null) {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm != null) {
                    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "RoozhayeManOZari::AnnouncerWakeLock");
                    wakeLock.setReferenceCounted(false);
                }
            }
            if (wakeLock != null && !wakeLock.isHeld()) {
                wakeLock.acquire(30000L);
            }
        } catch (Exception ignored) {
        }
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
            }
        } catch (Exception ignored) {
        }
    }

    private void stopSelfSafely() {
        abandonAudioFocus();
        releaseWakeLock();
        stopSelf();
    }

    private static void postDirectFallbackNotification(Context context, String title, String body) {
        try {
            NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                NotificationChannel ch = new NotificationChannel(
                        CHANNEL_ID,
                        "اعلام صوتی تماس و پیام‌ها",
                        NotificationManager.IMPORTANCE_HIGH
                );
                nm.createNotificationChannel(ch);
            }
            Intent openIntent = new Intent(context, MainActivity.class);
            openIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            PendingIntent pi = PendingIntent.getActivity(
                    context,
                    7003,
                    openIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );
            Notification notif = new NotificationCompat.Builder(context, CHANNEL_ID)
                    .setSmallIcon(R.drawable.ic_stat_rmz)
                    .setContentTitle(title != null ? title : "هم‌صدا")
                    .setContentText(body + " (برای صدای روان، اینترنت/فیلترشکن را بررسی کنید)")
                    .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setAutoCancel(true)
                    .setContentIntent(pi)
                    .build();
            nm.notify(ALERT_NOTIF_ID, notif);
        } catch (Exception ignored) {
        }
    }

    private static String sha256Hex(String input) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        byte[] digest = md.digest(input.getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder();
        for (int i = 0; i < Math.min(16, digest.length); i++) {
            hex.append(String.format("%02x", digest[i]));
        }
        return hex.toString();
    }

    private void stopActivePlayer() {
        if (activePlayer != null) {
            try {
                if (activePlayer.isPlaying()) activePlayer.stop();
            } catch (Exception ignored) {
            }
            try {
                activePlayer.release();
            } catch (Exception ignored) {
            }
            activePlayer = null;
        }
    }

    @Override
    public void onDestroy() {
        cancelled = true;
        activeSessionId++;
        handler.removeCallbacksAndMessages(null);
        stopActivePlayer();
        abandonAudioFocus();
        releaseWakeLock();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}

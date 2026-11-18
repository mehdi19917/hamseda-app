package com.roozhaye.manozari;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.os.Bundle;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Locale;

public class WakeWordForegroundService extends Service {
    private static final String CHANNEL_ID = "hamseda_wake_word";
    private static final int NOTIFICATION_ID = 7012;
    private static final String PREFS = "rmz_native_prefs";
    private static final String ACTION_START = "com.roozhaye.manozari.WAKE_START";
    private static final String ACTION_STOP = "com.roozhaye.manozari.WAKE_STOP";
    private final Handler handler = new Handler(Looper.getMainLooper());
    private SpeechRecognizer recognizer;
    private boolean stopping = false;
    private boolean recognitionPending = false;
    private String assistantName = "هم‌صدا";
    private long lastWakeAt = 0L;

    public static boolean start(Context context, String name) {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) return false;
        Intent intent = new Intent(context, WakeWordForegroundService.class);
        intent.setAction(ACTION_START);
        intent.putExtra("assistant_name", name == null ? "هم‌صدا" : name);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent);
            else context.startService(intent);
            return true;
        } catch (RuntimeException e) {
            return false;
        }
    }

    public static void stop(Context context) {
        Intent intent = new Intent(context, WakeWordForegroundService.class);
        intent.setAction(ACTION_STOP);
        try { context.startService(intent); } catch (RuntimeException ignored) {}
        context.stopService(new Intent(context, WakeWordForegroundService.class));
        context.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("wake_word_enabled", false).apply();
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (intent != null) {
            String requestedName = intent.getStringExtra("assistant_name");
            if (requestedName != null && !requestedName.trim().isEmpty()) assistantName = requestedName.trim();
        }
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .putBoolean("wake_word_enabled", true)
                .putString("assistant_name", assistantName)
                .apply();

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            stopSelf();
            return START_NOT_STICKY;
        }

        Notification notification = buildNotification(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        stopping = false;
        restartRecognition(250);
        return START_STICKY;
    }

    private Notification buildNotification(boolean heardWakeWord) {
        Intent open = new Intent(this, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pending = PendingIntent.getActivity(this, 712, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_rmz)
                .setContentTitle(heardWakeWord ? "هم‌صدا صدایت را شنید" : "هم‌صدا · گوش‌به‌زنگ")
                .setContentText(heardWakeWord
                        ? "برای گفتن فرمان، لمس کن و وارد دستیار شو."
                        : "با گفتن «" + assistantName + "» دستیار را بیدار کن.")
                .setContentIntent(pending)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID,
                    "گوش‌به‌زنگ هم‌صدا", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("اعلان آشکار هنگام فعال بودن شنود واژه بیدارباش");
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) manager.createNotificationChannel(channel);
        }
    }

    private void restartRecognition(long delayMs) {
        if (stopping || recognitionPending) return;
        recognitionPending = true;
        handler.postDelayed(() -> {
            recognitionPending = false;
            beginRecognition();
        }, delayMs);
    }

    private void beginRecognition() {
        if (stopping || !SpeechRecognizer.isRecognitionAvailable(this)) {
            restartRecognition(2500);
            return;
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            stopSelf();
            return;
        }
        destroyRecognizer();
        try {
            recognizer = SpeechRecognizer.createSpeechRecognizer(getApplicationContext());
            recognizer.setRecognitionListener(new RecognitionListener() {
                @Override public void onReadyForSpeech(Bundle params) {}
                @Override public void onBeginningOfSpeech() {}
                @Override public void onRmsChanged(float rmsdB) {}
                @Override public void onBufferReceived(byte[] buffer) {}
                @Override public void onEndOfSpeech() {}
                @Override public void onPartialResults(Bundle partialResults) {}
                @Override public void onEvent(int eventType, Bundle params) {}

                @Override public void onError(int error) {
                    destroyRecognizer();
                    restartRecognition(error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY ? 1800 : 700);
                }

                @Override public void onResults(Bundle results) {
                    ArrayList<String> matches = results == null ? null
                            : results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    String spoken = matches == null || matches.isEmpty() ? "" : matches.get(0);
                    if (containsWakeWord(spoken)) onWakeWordHeard();
                    destroyRecognizer();
                    restartRecognition(900);
                }
            });
            Intent speech = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            speech.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            speech.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "fa-IR");
            speech.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "fa-IR");
            speech.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3);
            speech.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false);
            speech.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1800L);
            speech.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1200L);
            speech.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getPackageName());
            recognizer.startListening(speech);
        } catch (Exception e) {
            destroyRecognizer();
            restartRecognition(1800);
        }
    }

    private boolean containsWakeWord(String spoken) {
        String heard = normalize(spoken);
        String expected = normalize(assistantName);
        if (heard.isEmpty() || expected.isEmpty()) return false;
        if (heard.contains(expected)) return true;
        return ("همصدا".equals(expected) || "هَمْصَدا".equals(expected))
                && (heard.contains("همصدا") || heard.contains("همصدا"));
    }

    private String normalize(String value) {
        if (value == null) return "";
        String normalized = Normalizer.normalize(value, Normalizer.Form.NFKC)
                .replace('ي', 'ی').replace('ك', 'ک')
                .replace("‌", "").replaceAll("[\\s\\p{Punct}]+", "")
                .toLowerCase(Locale.ROOT);
        return normalized;
    }

    private void onWakeWordHeard() {
        long now = System.currentTimeMillis();
        if (now - lastWakeAt < 12000L) return;
        lastWakeAt = now;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(NOTIFICATION_ID, buildNotification(true));
    }

    private void destroyRecognizer() {
        SpeechRecognizer old = recognizer;
        recognizer = null;
        if (old != null) {
            try { old.cancel(); } catch (Exception ignored) {}
            try { old.destroy(); } catch (Exception ignored) {}
        }
    }

    @Override public void onDestroy() {
        stopping = true;
        handler.removeCallbacksAndMessages(null);
        destroyRecognizer();
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("wake_word_enabled", false).apply();
        super.onDestroy();
    }

    @Nullable @Override public IBinder onBind(Intent intent) { return null; }
}
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
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

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
    private TextToSpeech textToSpeech;
    private boolean ttsReady = false;
    private boolean stopping = false;
    private boolean recognitionPending = false;
    private boolean awaitingCommand = false;
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
        context.stopService(new Intent(context, WakeWordForegroundService.class));
        context.getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .putBoolean("wake_word_enabled", false)
                .remove("pending_wake_command")
                .apply();
    }

    @Override public void onCreate() {
        super.onCreate();
        createChannel();
        textToSpeech = new TextToSpeech(getApplicationContext(), status -> {
            if (status == TextToSpeech.SUCCESS && textToSpeech != null) {
                int languageResult = textToSpeech.setLanguage(new Locale("fa", "IR"));
                ttsReady = languageResult != TextToSpeech.LANG_MISSING_DATA
                        && languageResult != TextToSpeech.LANG_NOT_SUPPORTED;
            }
        });
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (intent != null) {
            String requestedName = intent.getStringExtra("assistant_name");
            if (requestedName != null && !requestedName.trim().isEmpty()) assistantName = requestedName.trim();
        } else {
            assistantName = getSharedPreferences(PREFS, MODE_PRIVATE)
                    .getString("assistant_name", "هم‌صدا");
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

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, buildNotification(false),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        } else {
            startForeground(NOTIFICATION_ID, buildNotification(false));
        }

        stopping = false;
        handler.removeCallbacksAndMessages(null);
        recognitionPending = false;
        destroyRecognizer();
        restartRecognition(300);
        return START_STICKY;
    }

    private Notification buildNotification(boolean commandReady) {
        Intent open = new Intent(this, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pending = PendingIntent.getActivity(this, 712, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String title = commandReady ? "هم‌صدا · فرمان دریافت شد" : "هم‌صدا · گوش‌به‌زنگ";
        String message = commandReady
                ? "برای اجرای فرمان وارد دستیار شو."
                : "صدایت را می‌شنوم؛ نام هم‌صدا را بگو.";
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_rmz)
                .setContentTitle(title)
                .setContentText(message)
                .setContentIntent(pending)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID,
                    "گوش‌به‌زنگ هم‌صدا", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("شنود آشکار واژه بیدارباش و دریافت فرمان صوتی");
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
        if (stopping) return;
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            restartRecognition(2500);
            return;
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            stopSelf();
            return;
        }

        try {
            // Keep one SpeechRecognizer instance alive for the whole wake-word session.
            // Android recognition is still session-based, but reusing the engine avoids
            // repeatedly tearing down and recreating the recognizer after every phrase.
            if (recognizer == null) {
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
                        // Restart only the recognition session, not the recognizer service object.
                        restartRecognition(error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY ? 1800 : 900);
                    }

                    @Override public void onResults(Bundle results) {
                        ArrayList<String> matches = results == null ? null
                                : results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                        String spoken = matches == null || matches.isEmpty() ? "" : matches.get(0).trim();

                        if (awaitingCommand) {
                            awaitingCommand = false;
                            if (!spoken.isEmpty()) savePendingCommand(spoken);
                            restartRecognition(900);
                            return;
                        }

                        if (containsWakeWord(spoken)) {
                            onWakeWordHeard();
                            String command = extractCommandAfterWakeWord(spoken);
                            if (!command.isEmpty()) {
                                savePendingCommand(command);
                            } else {
                                awaitingCommand = true;
                                speakWakePrompt();
                                return;
                            }
                        }
                        restartRecognition(350);
                    }
                });
            }

            Intent speech = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            speech.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            speech.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "fa-IR");
            speech.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "fa-IR");
            speech.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3);
            speech.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false);
            speech.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 5000L);
            speech.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 3500L);
            speech.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getPackageName());
            recognizer.startListening(speech);
        } catch (Exception e) {
            destroyRecognizer();
            restartRecognition(1800);
        }
    }

    private void speakWakePrompt() {
        if (!ttsReady || textToSpeech == null) {
            restartRecognition(700);
            return;
        }
        textToSpeech.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String utteranceId) {}
            @Override public void onDone(String utteranceId) {
                handler.post(() -> restartRecognition(900));
            }
            @Override public void onError(String utteranceId) {
                handler.post(() -> restartRecognition(1200));
            }
        });
        textToSpeech.speak("جانم، بفرمایید", TextToSpeech.QUEUE_FLUSH, null, "hamseda-wake-prompt");
    }

    private boolean containsWakeWord(String spoken) {
        String heard = normalize(spoken);
        String expected = normalize(assistantName);
        return !heard.isEmpty() && !expected.isEmpty() && heard.contains(expected);
    }

    private String extractCommandAfterWakeWord(String spoken) {
        String expected = normalize(assistantName);
        if (expected.isEmpty()) return "";
        for (int i = 0; i < spoken.length(); i++) {
            if (normalize(spoken.substring(0, i + 1)).contains(expected)) {
                return spoken.substring(i + 1).replaceFirst("^[\\s،,:;.!؟\\-]+", "").trim();
            }
        }
        return "";
    }

    private String normalize(String value) {
        if (value == null) return "";
        return Normalizer.normalize(value, Normalizer.Form.NFKC)
                .replace('ي', 'ی').replace('ك', 'ک')
                .replace("‌", "").replaceAll("[\\s\\p{Punct}]+", "")
                .toLowerCase(Locale.ROOT);
    }

    private void onWakeWordHeard() {
        long now = System.currentTimeMillis();
        if (now - lastWakeAt < 2500L) return;
        lastWakeAt = now;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(NOTIFICATION_ID, buildNotification(false));
    }

    private void savePendingCommand(String command) {
        if (command == null || command.trim().isEmpty()) return;
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .putString("pending_wake_command", command.trim())
                .putLong("pending_wake_command_at", System.currentTimeMillis())
                .apply();
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
        if (textToSpeech != null) {
            try { textToSpeech.stop(); } catch (Exception ignored) {}
            try { textToSpeech.shutdown(); } catch (Exception ignored) {}
            textToSpeech = null;
        }
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("wake_word_enabled", false).apply();
        super.onDestroy();
    }

    @Nullable @Override public IBinder onBind(Intent intent) { return null; }
}
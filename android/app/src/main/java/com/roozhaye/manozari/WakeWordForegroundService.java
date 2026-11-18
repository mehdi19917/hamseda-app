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

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONObject;
import org.vosk.Model;
import org.vosk.Recognizer;
import org.vosk.android.RecognitionListener;
import org.vosk.android.SpeechService;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

public class WakeWordForegroundService extends Service {
    private static final String CHANNEL_ID = "hamseda_wake_word";
    private static final int NOTIFICATION_ID = 7012;
    private static final String PREFS = "rmz_native_prefs";
    private static final String ACTION_START = "com.roozhaye.manozari.WAKE_START";
    private static final String MODEL_NAME = "vosk-model-small-fa-0.42";
    private static final String MODEL_URL = "https://alphacephei.com/vosk/models/vosk-model-small-fa-0.42.zip";
    private static final long MAX_MODEL_BYTES = 150L * 1024L * 1024L;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService modelExecutor = Executors.newSingleThreadExecutor();
    private volatile boolean stopping = false;
    private volatile boolean awaitingCommand = false;
    private volatile boolean modelLoading = false;
    private Model model;
    private Recognizer recognizer;
    private SpeechService speechService;
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
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && intent.hasExtra("assistant_name")) {
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
            startForeground(NOTIFICATION_ID, buildNotification("در حال آماده‌سازی موتور شنود فارسی…"),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        } else {
            startForeground(NOTIFICATION_ID, buildNotification("در حال آماده‌سازی موتور شنود فارسی…"));
        }

        stopping = false;
        if (speechService == null && !modelLoading) prepareModelAndStart();
        return START_STICKY;
    }

    private Notification buildNotification(String message) {
        return buildNotification(message, 0, false);
    }

    private Notification buildNotification(String message, int progress, boolean indeterminate) {
        Intent open = new Intent(this, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pending = PendingIntent.getActivity(this, 712, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_rmz)
                .setContentTitle("هم‌صدا · گوش‌به‌زنگ")
                .setContentText(message)
                .setContentIntent(pending)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setPriority(NotificationCompat.PRIORITY_LOW);
        if (indeterminate || progress > 0) {
            builder.setProgress(100, Math.max(0, Math.min(100, progress)), indeterminate);
        }
        return builder.build();
    }

    private void updateNotification(String message) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(NOTIFICATION_ID, buildNotification(message));
    }

    private void updateDownloadProgress(long downloaded, long total) {
        long safeDownloaded = Math.max(0L, downloaded);
        if (total > 0L) {
            int percent = (int) Math.min(100L, (safeDownloaded * 100L) / total);
            String message = "دانلود مدل فارسی: " + toPersianDigits(percent) + "٪  ·  "
                    + formatMegabytes(safeDownloaded) + " از " + formatMegabytes(total) + " مگابایت";
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) manager.notify(NOTIFICATION_ID, buildNotification(message, percent, false));
        } else {
            String message = "در حال دانلود مدل فارسی · دریافت‌شده: " + formatMegabytes(safeDownloaded) + " مگابایت";
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) manager.notify(NOTIFICATION_ID, buildNotification(message, 0, true));
        }
    }

    private String formatMegabytes(long bytes) {
        return String.format(Locale.US, "%.1f", bytes / (1024.0 * 1024.0));
    }

    private String toPersianDigits(int value) {
        return String.valueOf(value).replace('0', '۰').replace('1', '۱').replace('2', '۲')
                .replace('3', '۳').replace('4', '۴').replace('5', '۵')
                .replace('6', '۶').replace('7', '۷').replace('8', '۸').replace('9', '۹');
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

    private void prepareModelAndStart() {
        modelLoading = true;
        modelExecutor.execute(() -> {
            try {
                File modelDir = new File(getFilesDir(), "vosk-fa-0.42");
                File modelRoot = new File(modelDir, MODEL_NAME);
                if (!new File(modelRoot, "am").isDirectory() || !new File(modelRoot, "conf").isDirectory()) {
                    updateNotification("دانلود موتور فارسی (حدود ۵۳ مگابایت)…");
                    installModel(modelDir, modelRoot);
                }
                Model loaded = new Model(modelRoot.getAbsolutePath());
                handler.post(() -> {
                    modelLoading = false;
                    if (stopping) {
                        loaded.close();
                        return;
                    }
                    model = loaded;
                    startContinuousRecognition();
                });
            } catch (Exception e) {
                handler.post(() -> {
                    modelLoading = false;
                    if (!stopping) updateNotification("آماده‌سازی مدل ناموفق بود؛ اینترنت را بررسی و دوباره شنود را روشن کنید.");
                });
            }
        });
    }

    private void installModel(File modelDir, File expectedRoot) throws Exception {
        File zipFile = new File(getCacheDir(), MODEL_NAME + ".zip.part");
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(MODEL_URL).openConnection();
            connection.setConnectTimeout(20000);
            connection.setReadTimeout(60000);
            connection.setInstanceFollowRedirects(true);
            connection.connect();
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) throw new IllegalStateException("Model download HTTP " + status);
            long declared = connection.getContentLengthLong();
            if (declared > MAX_MODEL_BYTES) throw new IllegalStateException("Model archive too large");
            try (InputStream in = new BufferedInputStream(connection.getInputStream());
                 FileOutputStream out = new FileOutputStream(zipFile)) {
                byte[] buffer = new byte[32768];
                long total = 0;
                long lastProgressUpdate = 0L;
                int count;
                while ((count = in.read(buffer)) != -1) {
                    if (stopping || Thread.currentThread().isInterrupted()) throw new InterruptedException("stopped");
                    total += count;
                    if (total > MAX_MODEL_BYTES) throw new IllegalStateException("Model archive too large");
                    out.write(buffer, 0, count);
                    long now = System.currentTimeMillis();
                    if (now - lastProgressUpdate >= 300L) {
                        updateDownloadProgress(total, declared);
                        lastProgressUpdate = now;
                    }
                }
                out.getFD().sync();
                updateDownloadProgress(total, declared);
            }
        } finally {
            if (connection != null) connection.disconnect();
        }

        File staging = new File(getFilesDir(), "vosk-fa-staging");
        deleteRecursively(staging);
        if (!staging.mkdirs() && !staging.isDirectory()) throw new IllegalStateException("Cannot create model folder");
        String stagingCanonical = staging.getCanonicalPath() + File.separator;
        try (ZipInputStream zis = new ZipInputStream(new BufferedInputStream(new java.io.FileInputStream(zipFile)))) {
            ZipEntry entry;
            byte[] buffer = new byte[32768];
            while ((entry = zis.getNextEntry()) != null) {
                File target = new File(staging, entry.getName());
                String canonical = target.getCanonicalPath();
                if (!canonical.startsWith(stagingCanonical)) throw new SecurityException("Invalid model archive path");
                if (entry.isDirectory()) {
                    if (!target.mkdirs() && !target.isDirectory()) throw new IllegalStateException("Cannot create model directory");
                } else {
                    File parent = target.getParentFile();
                    if (parent != null && !parent.mkdirs() && !parent.isDirectory()) throw new IllegalStateException("Cannot create model folder");
                    try (FileOutputStream out = new FileOutputStream(target)) {
                        int n;
                        while ((n = zis.read(buffer)) != -1) out.write(buffer, 0, n);
                    }
                }
                zis.closeEntry();
            }
        }
        File extracted = new File(staging, MODEL_NAME);
        if (!new File(extracted, "am").isDirectory() || !new File(extracted, "conf").isDirectory()) {
            throw new IllegalStateException("Persian model archive structure is invalid");
        }
        deleteRecursively(modelDir);
        if (!modelDir.mkdirs() && !modelDir.isDirectory()) throw new IllegalStateException("Cannot create final model folder");
        File finalRoot = new File(modelDir, MODEL_NAME);
        if (!extracted.renameTo(finalRoot)) throw new IllegalStateException("Cannot install Persian model");
        deleteRecursively(staging);
        //noinspection ResultOfMethodCallIgnored
        zipFile.delete();
    }

    private void startContinuousRecognition() {
        if (stopping || model == null) return;
        try {
            recognizer = new Recognizer(model, 16000.0f);
            speechService = new SpeechService(recognizer, 16000.0f);
            boolean started = speechService.startListening(new RecognitionListener() {
                @Override public void onResult(String hypothesis) {
                    handleRecognizedText(readText(hypothesis));
                }
                @Override public void onFinalResult(String hypothesis) {
                    handleRecognizedText(readText(hypothesis));
                }
                @Override public void onPartialResult(String hypothesis) {}
                @Override public void onError(Exception e) {
                    handler.postDelayed(() -> recoverContinuousRecognition(), 1200);
                }
                @Override public void onTimeout() {}
            });
            if (!started) throw new IllegalStateException("Vosk listener did not start");
            updateNotification("گوش‌به‌زنگ پیوسته فارسی فعال است؛ نام هم‌صدا را بگو.");
        } catch (Exception e) {
            updateNotification("شروع شنود پیوسته ناموفق بود؛ دوباره تلاش می‌کنم.");
            handler.postDelayed(() -> recoverContinuousRecognition(), 2500);
        }
    }

    private String readText(String json) {
        try {
            return new JSONObject(json == null ? "{}" : json).optString("text", "").trim();
        } catch (Exception ignored) {
            return "";
        }
    }

    private void handleRecognizedText(String spoken) {
        if (stopping || spoken == null || spoken.trim().isEmpty()) return;
        if (awaitingCommand) {
            awaitingCommand = false;
            savePendingCommand(spoken);
            return;
        }
        if (!containsWakeWord(spoken)) return;

        onWakeWordHeard();
        String command = extractCommandAfterWakeWord(spoken);
        if (!command.isEmpty()) {
            savePendingCommand(command);
        } else {
            awaitingCommand = true;
            speakWakePrompt();
        }
    }

    private void speakWakePrompt() {
        SpeechService active = speechService;
        if (active != null) active.setPause(true);
        // Use the same native Persian female-voice selection/pitch path as the manual assistant.
        BilingualSpeechHelper.speak(getApplicationContext(), "جانم، بفرمایید", false, 1.0f, false,
                success -> handler.post(() -> {
                    if (stopping) return;
                    if (recognizer != null) recognizer.reset();
                    SpeechService current = speechService;
                    if (current != null) current.setPause(false);
                }));
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
        updateNotification("نام هم‌صدا شنیده شد؛ منتظر فرمان هستم.");
    }

    private void savePendingCommand(String command) {
        if (command == null || command.trim().isEmpty()) return;
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .putString("pending_wake_command", command.trim())
                .putLong("pending_wake_command_at", System.currentTimeMillis())
                .apply();
        updateNotification("هم‌صدا · فرمان دریافت شد؛ برای اجرا وارد دستیار شو.");
    }

    private void recoverContinuousRecognition() {
        if (stopping || model == null) return;
        try {
            if (speechService != null) {
                speechService.cancel();
                speechService.shutdown();
                speechService = null;
            }
            if (recognizer != null) {
                recognizer.close();
                recognizer = null;
            }
        } catch (Exception ignored) {}
        startContinuousRecognition();
    }

    private void deleteRecursively(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteRecursively(child);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    @Override public void onDestroy() {
        stopping = true;
        modelExecutor.shutdownNow();
        try {
            if (speechService != null) {
                speechService.cancel();
                speechService.shutdown();
                speechService = null;
            }
        } catch (Exception ignored) {}
        try {
            if (recognizer != null) {
                recognizer.close();
                recognizer = null;
            }
            if (model != null) {
                model.close();
                model = null;
            }
        } catch (Exception ignored) {}
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("wake_word_enabled", false).apply();
        super.onDestroy();
    }

    @Nullable @Override public IBinder onBind(Intent intent) { return null; }
}
package com.roozhaye.manozari;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class BilingualSpeechHelper {
    public static class Segment {
        public final String text;
        public final boolean isLatin;

        public Segment(String text, boolean isLatin) {
            this.text = text;
            this.isLatin = isLatin;
        }
    }

    private static final Pattern SEGMENT_PATTERN = Pattern.compile("([A-Za-z][A-Za-z0-9\\s.,'_-]*)|([^\\x00-\\x7F]+[\\d۰-۹\\s،.؟!]*)|([\\d۰-۹.,!?،؛:\\-\\s]+)");

    public static List<Segment> splitBilingual(String text) {
        List<Segment> segments = new ArrayList<>();
        if (text == null || text.trim().isEmpty()) return segments;

        Matcher matcher = SEGMENT_PATTERN.matcher(text);
        while (matcher.find()) {
            String chunk = matcher.group().trim();
            if (chunk.isEmpty()) continue;
            boolean hasLatin = chunk.matches("(?s).*[A-Za-z].*");
            boolean hasPersian = chunk.matches("(?s).*[\\u0600-\\u06FF].*");
            boolean isLatin = hasLatin && !hasPersian;

            if (!segments.isEmpty() && segments.get(segments.size() - 1).isLatin == isLatin) {
                Segment prev = segments.remove(segments.size() - 1);
                segments.add(new Segment(prev.text + " " + chunk, isLatin));
            } else {
                segments.add(new Segment(chunk, isLatin));
            }
        }
        if (segments.isEmpty()) {
            segments.add(new Segment(text, false));
        }
        return segments;
    }

    public interface CompletionCallback {
        void onComplete(boolean success);
    }

    private static final Object TTS_LOCK = new Object();
    private static TextToSpeech activeTts = null;

    public static void stopActiveTts() {
        synchronized (TTS_LOCK) {
            if (activeTts != null) {
                try {
                    activeTts.stop();
                } catch (Exception ignored) {
                }
                try {
                    activeTts.shutdown();
                } catch (Exception ignored) {
                }
                activeTts = null;
            }
        }
    }

    public static void speak(Context context, String text, boolean isMale, float rate, boolean ringtoneStream, CompletionCallback callback) {
        stopActiveTts();
        final TextToSpeech[] holder = new TextToSpeech[1];
        final AtomicBoolean settled = new AtomicBoolean(false);

        TextToSpeech created = new TextToSpeech(context.getApplicationContext(), status -> {
            TextToSpeech tts = holder[0];
            synchronized (TTS_LOCK) {
                if (activeTts != tts) {
                    if (tts != null) {
                        try {
                            tts.shutdown();
                        } catch (Exception ignored) {
                        }
                    }
                    if (settled.compareAndSet(false, true) && callback != null) {
                        callback.onComplete(false);
                    }
                    return;
                }
            }

            if (status != TextToSpeech.SUCCESS || tts == null) {
                stopActiveTts();
                if (settled.compareAndSet(false, true) && callback != null) {
                    callback.onComplete(false);
                }
                return;
            }

            try {
                Locale faLocale = new Locale("fa", "IR");
                Locale enLocale = Locale.US;
                Voice faVoice = pickVoice(tts, "fa", isMale);
                Voice enVoice = pickVoice(tts, "en", isMale);

                int faAvail = tts.isLanguageAvailable(faLocale);
                boolean hasPersianSupport = faVoice != null
                        || (faAvail != TextToSpeech.LANG_MISSING_DATA && faAvail != TextToSpeech.LANG_NOT_SUPPORTED);
                boolean hasPersianChars = text != null && text.matches("(?s).*[\\u0600-\\u06FF].*");

                // Prevent robotic English-only fragments (e.g., reading only "bahman mousaali" and skipping the Persian SMS body)
                if (hasPersianChars && !hasPersianSupport) {
                    stopActiveTts();
                    if (settled.compareAndSet(false, true) && callback != null) {
                        callback.onComplete(false);
                    }
                    return;
                }

                // Convert mixed Latin/Finglish names & words (e.g. Bahman Mousaali, salam) into clean Persian script
                // when speaking Persian sentences so Android TTS doesn't choke switching languages mid-utterance.
                String preparedText = hasPersianSupport
                        ? FinglishPhoneticHelper.transliterateToPersianPhonetic(text)
                        : text;

                AudioAttributes attrs = new AudioAttributes.Builder()
                        .setUsage(ringtoneStream ? AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE : AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build();
                tts.setAudioAttributes(attrs);
                tts.setPitch(isMale ? 0.78f : 1.08f);
                tts.setSpeechRate(Math.max(0.6f, Math.min(1.6f, rate)));

                List<Segment> segments = splitBilingual(preparedText);
                if (segments.isEmpty()) {
                    stopActiveTts();
                    if (settled.compareAndSet(false, true) && callback != null) {
                        callback.onComplete(false);
                    }
                    return;
                }

                String batchId = UUID.randomUUID().toString();
                String lastUtteranceId = batchId + "_" + (segments.size() - 1);

                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override
                    public void onStart(String utteranceId) {}

                    @Override
                    public void onDone(String utteranceId) {
                        if (lastUtteranceId.equals(utteranceId) && settled.compareAndSet(false, true)) {
                            synchronized (TTS_LOCK) {
                                if (activeTts == tts) activeTts = null;
                            }
                            try {
                                tts.shutdown();
                            } catch (Exception ignored) {
                            }
                            if (callback != null) callback.onComplete(true);
                        }
                    }

                    @Override
                    public void onError(String utteranceId) {
                        if (lastUtteranceId.equals(utteranceId) && settled.compareAndSet(false, true)) {
                            synchronized (TTS_LOCK) {
                                if (activeTts == tts) activeTts = null;
                            }
                            try {
                                tts.shutdown();
                            } catch (Exception ignored) {
                            }
                            if (callback != null) callback.onComplete(false);
                        }
                    }
                });

                for (int i = 0; i < segments.size(); i++) {
                    Segment seg = segments.get(i);
                    tts.setLanguage(seg.isLatin ? enLocale : faLocale);
                    if (seg.isLatin && enVoice != null) {
                        tts.setVoice(enVoice);
                    } else if (!seg.isLatin && faVoice != null) {
                        tts.setVoice(faVoice);
                    }
                    Bundle params = new Bundle();
                    params.putInt(TextToSpeech.Engine.KEY_PARAM_STREAM, AudioManager.STREAM_MUSIC);
                    int mode = (i == 0) ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD;
                    tts.speak(seg.text, mode, params, batchId + "_" + i);
                }
            } catch (Exception e) {
                stopActiveTts();
                if (settled.compareAndSet(false, true) && callback != null) {
                    callback.onComplete(false);
                }
            }
        });
        synchronized (TTS_LOCK) {
            holder[0] = created;
            activeTts = created;
        }
    }

    private static Voice pickVoice(TextToSpeech tts, String langPrefix, boolean isMale) {
        try {
            Set<Voice> voices = tts.getVoices();
            if (voices == null) return null;
            List<Voice> matching = new ArrayList<>();
            for (Voice v : voices) {
                if (v.getLocale() != null && v.getLocale().getLanguage().toLowerCase().startsWith(langPrefix)) {
                    matching.add(v);
                }
            }
            if (matching.isEmpty()) return null;
            String[] hints = isMale
                    ? new String[]{"male", "man", "ard", "m1", "m2", "network"}
                    : new String[]{"female", "woman", "f1", "f2", "zira", "sara", "daria", "samantha", "karen", "victoria"};
            for (Voice v : matching) {
                String n = v.getName().toLowerCase();
                for (String h : hints) {
                    if (n.contains(h)) return v;
                }
            }
            if (!isMale) {
                for (Voice v : matching) {
                    String n = v.getName().toLowerCase();
                    if (!n.contains("male") && !n.contains("man") && !n.contains("m1") && !n.contains("m2")) return v;
                }
            }
            return matching.get(isMale ? matching.size() - 1 : 0);
        } catch (Exception ignored) {
            return null;
        }
    }
}

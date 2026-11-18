import {VOICE_PERSONAS} from '../data/persianLibrary';
import type {AudioLibraryEntry, VoiceName} from '../types/app';
import {apiUrl, safeReadJsonResponse} from './apiConfig';
import {
  base64ToArrayBuffer,
  getAudioClipBuffer,
  getAudioClipRecord,
  hashTextKey,
  isRiffWavBuffer,
  saveAudioClip,
} from './audioLibraryDb';
import {isNativeAndroid, precacheNativeWav, speakNativeBilingual, stopNativeAudio} from './nativeAndroidBridge';

let sharedAudioCtx: AudioContext | null = null;
let activeSourceNode: AudioBufferSourceNode | null = null;
let activeAudioEl: HTMLAudioElement | null = null;
let activeUrl: string | null = null;
let playbackToken = 0;

export interface SpeakOptions {
  text: string;
  title: string;
  category: AudioLibraryEntry['category'];
  voiceName?: VoiceName;
  style?: string;
  rate?: number;
  clipId?: string;
  forceOnlineRefresh?: boolean;
  onLoading?: () => void;
  onStart?: (source: 'cache' | 'gemini' | 'neural-fallback' | 'offline-speech') => void;
  onEnd?: () => void;
  onError?: (message: string) => void;
}

function getPersonaInfo(voiceName: VoiceName) {
  return (
    VOICE_PERSONAS.find((v) => v.id === voiceName) ?? {
      id: voiceName,
      label: 'نگین · خانم',
      gender: 'female' as const,
      tone: 'Adult female speaker. Warm Tehran Persian voice',
    }
  );
}

function getOrCreateAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as {webkitAudioContext?: typeof AudioContext}).webkitAudioContext;
  if (!AudioCtx) return null;
  if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
    sharedAudioCtx = new AudioCtx();
  }
  return sharedAudioCtx;
}

export function unlockAudioPlayback(): void {
  const ctx = getOrCreateAudioContext();
  if (ctx) {
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    try {
      const silent = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = silent;
      src.connect(ctx.destination);
      src.start(0);
    } catch {
      // ignore silent unlock errors
    }
  }
}

export function stopAllSpeech(): void {
  playbackToken++;
  if (activeSourceNode) {
    try {
      activeSourceNode.onended = null;
      activeSourceNode.stop();
      activeSourceNode.disconnect();
    } catch {
      // already stopped
    }
    activeSourceNode = null;
  }
  if (activeAudioEl) {
    activeAudioEl.onended = null;
    activeAudioEl.onerror = null;
    activeAudioEl.pause();
    activeAudioEl.currentTime = 0;
    activeAudioEl = null;
  }
  if (activeUrl) {
    URL.revokeObjectURL(activeUrl);
    activeUrl = null;
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
  if (isNativeAndroid()) {
    stopNativeAudio().catch(() => {});
  }
}

export function playSoftChime(style: 'gentle' | 'classic' | 'chime' = 'chime'): Promise<void> {
  return new Promise((resolve) => {
    try {
      const ctx = getOrCreateAudioContext();
      if (!ctx) {
        resolve();
        return;
      }
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }

      const notes =
        style === 'chime'
          ? [523.25, 659.25, 783.99, 1046.5]
          : style === 'gentle'
            ? [440, 554.37, 659.25]
            : [587.33, 880, 587.33];

      const step = 0.15;
      const now = ctx.currentTime;
      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + idx * step);
        gain.gain.setValueAtTime(0.001, now + idx * step);
        gain.gain.exponentialRampToValueAtTime(0.14, now + idx * step + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * step + 0.34);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + idx * step);
        osc.stop(now + idx * step + 0.35);
      });

      setTimeout(resolve, notes.length * step * 1000 + 180);
    } catch {
      resolve();
    }
  });
}

async function playWavBuffer(buffer: ArrayBuffer, rate: number, token: number): Promise<void> {
  const ctx = getOrCreateAudioContext();

  if (ctx) {
    try {
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }
      const audioBuffer = await ctx.decodeAudioData(buffer.slice(0));
      if (token !== playbackToken) return;

      await new Promise<void>((resolve) => {
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.playbackRate.value = rate;
        source.connect(ctx.destination);
        activeSourceNode = source;
        source.onended = () => {
          if (activeSourceNode === source) {
            activeSourceNode = null;
          }
          resolve();
        };
        source.start(0);
      });
      return;
    } catch (err) {
      console.warn('AudioContext decode fallback to HTMLAudioElement:', err);
    }
  }

  if (token !== playbackToken) return;
  await new Promise<void>((resolve, reject) => {
    const bytes = new Uint8Array(buffer);
    const isWav =
      bytes.length >= 4 &&
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46;
    const blob = new Blob([buffer], {type: isWav ? 'audio/wav' : 'audio/mpeg'});
    const url = URL.createObjectURL(blob);
    activeUrl = url;
    const audio = new Audio(url);
    audio.playbackRate = rate;
    activeAudioEl = audio;

    audio.onended = () => {
      if (activeUrl === url) {
        URL.revokeObjectURL(url);
        activeUrl = null;
      }
      if (activeAudioEl === audio) {
        activeAudioEl = null;
      }
      resolve();
    };
    audio.onerror = () => {
      if (activeUrl === url) {
        URL.revokeObjectURL(url);
        activeUrl = null;
      }
      if (activeAudioEl === audio) {
        activeAudioEl = null;
      }
      reject(new Error('خطا در پخش فایل صوتی'));
    };

    audio.play().catch(reject);
  });
}

export function splitBilingualSegments(text: string): {text: string; lang: 'fa-IR' | 'en-US'}[] {
  const segments: {text: string; lang: 'fa-IR' | 'en-US'}[] = [];
  const tokenRegex = /([A-Za-z][A-Za-z0-9\s.,'_-]*)|([^\x00-\x7F]+[\d۰-۹\s،.؟!]*)|([\d۰-۹.,!?،؛:\-\s]+)/g;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(text)) !== null) {
    const chunk = match[0].trim();
    if (!chunk) continue;
    const hasLatin = /[A-Za-z]/.test(chunk);
    const hasPersian = /[\u0600-\u06FF]/.test(chunk);
    const lang: 'fa-IR' | 'en-US' = hasLatin && !hasPersian ? 'en-US' : 'fa-IR';

    const last = segments[segments.length - 1];
    if (last && last.lang === lang) {
      last.text = `${last.text} ${chunk}`;
    } else {
      segments.push({text: chunk, lang});
    }
  }
  return segments.length > 0 ? segments : [{text, lang: 'fa-IR'}];
}

function pickGenderedVoice(
  voices: SpeechSynthesisVoice[],
  langPrefix: 'fa' | 'en',
  gender: 'male' | 'female'
): SpeechSynthesisVoice | undefined {
  const matching = voices.filter((v) => v.lang.toLowerCase().startsWith(langPrefix));
  if (matching.length === 0) return undefined;
  const maleHints = ['male', 'man', 'david', 'mark', 'daniel', 'george', 'alex', 'farid', 'masoud', 'ardeshir', 'mard', 'm1', 'm2'];
  const femaleHints = ['female', 'woman', 'sara', 'daria', 'zira', 'samantha', 'karen', 'victoria', 'zan', 'f1', 'f2'];
  const hints = gender === 'male' ? maleHints : femaleHints;

  const hinted = matching.find((v) => hints.some((h) => v.name.toLowerCase().includes(h)));
  if (hinted) return hinted;
  if (matching.length > 1) {
    return gender === 'male' ? matching[matching.length - 1] : matching[0];
  }
  return matching[0];
}

export function speakOfflineBilingual(
  text: string,
  rate = 1,
  gender: 'male' | 'female' = 'female',
  tokenOverride?: number
): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      resolve(false);
      return;
    }

    const activeTok = tokenOverride ?? playbackToken;
    const synth = window.speechSynthesis;
    synth.cancel();

    const getVoicesReady = (): Promise<SpeechSynthesisVoice[]> => {
      const current = synth.getVoices();
      if (current.length > 0) return Promise.resolve(current);
      return new Promise((res) => {
        const timeout = setTimeout(() => res(synth.getVoices()), 450);
        synth.onvoiceschanged = () => {
          clearTimeout(timeout);
          res(synth.getVoices());
        };
      });
    };

    getVoicesReady().then((voices) => {
      if (activeTok !== playbackToken) {
        resolve(false);
        return;
      }

      const faVoice = pickGenderedVoice(voices, 'fa', gender);
      const enVoice = pickGenderedVoice(voices, 'en', gender);
      const hasPersianChars = /[\u0600-\u06FF]/.test(text);
      if (hasPersianChars && !faVoice) {
        resolve(false);
        return;
      }
      const segments = splitBilingualSegments(text);
      let idx = 0;
      let anyStarted = false;

      const speakNext = () => {
        if (activeTok !== playbackToken || idx >= segments.length) {
          resolve(anyStarted);
          return;
        }
        const seg = segments[idx++];
        const utter = new SpeechSynthesisUtterance(seg.text);
        utter.lang = seg.lang;
        utter.rate = rate;
        // Distinct pitch adjustment so male/female remain distinguishable even on single-voice Android TTS
        utter.pitch = gender === 'male' ? 0.76 : 1.08;
        if (seg.lang === 'fa-IR' && faVoice) utter.voice = faVoice;
        if (seg.lang === 'en-US' && enVoice) utter.voice = enVoice;

        let settled = false;
        const safetyTimer = window.setTimeout(() => {
          if (!settled) {
            settled = true;
            speakNext();
          }
        }, Math.max(4000, seg.text.length * 140));

        utter.onstart = () => {
          anyStarted = true;
        };
        utter.onend = () => {
          if (!settled) {
            settled = true;
            clearTimeout(safetyTimer);
            speakNext();
          }
        };
        utter.onerror = () => {
          if (!settled) {
            settled = true;
            clearTimeout(safetyTimer);
            speakNext();
          }
        };
        synth.speak(utter);
      };

      speakNext();
    });
  });
}

export async function generateAndCacheGeminiWav(params: {
  text: string;
  title: string;
  category: AudioLibraryEntry['category'];
  voiceName?: VoiceName;
  style?: string;
  clipId?: string;
  forceRefresh?: boolean;
}): Promise<{id: string; buffer: ArrayBuffer; isStudioWav: boolean} | {fallbackOffline: true; reason: string}> {
  const voiceName = params.voiceName ?? 'Kore';
  const id = params.clipId ?? hashTextKey(params.text, voiceName);
  const persona = getPersonaInfo(voiceName);
  const style = [persona.tone, params.style ?? 'Fluent natural Tehran Persian voice.'].filter(Boolean).join(' ');

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);
  let res: Response;
  try {
    res = await fetch(apiUrl('/api/tts'), {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    signal: controller.signal,
    body: JSON.stringify({
      text: params.text,
      voiceName,
      style,
      forceRefresh: Boolean(params.forceRefresh),
    }),
    });
  } finally {
    window.clearTimeout(timeout);
  }

  const parsed = await safeReadJsonResponse<{
    audioBase64?: string;
    mimeType?: string;
    provider?: 'gemini' | 'neural-fallback';
    fallbackOffline?: boolean;
    reason?: string;
    error?: string;
  }>(res);

  if (parsed.isHtml) {
    console.warn('TTS endpoint returned HTML instead of JSON; falling back safely.');
    return {fallbackOffline: true, reason: 'html-response'};
  }

  if (!res.ok) {
    throw new Error(parsed.data?.error || 'خطا در ارتباط با سرویس صوتی');
  }

  const data = parsed.data;
  if (!data || data.fallbackOffline || !data.audioBase64) {
    return {fallbackOffline: true, reason: data?.reason || 'unavailable'};
  }

  const buffer = base64ToArrayBuffer(data.audioBase64);
  const isStudioWav = data.provider === 'gemini' && isRiffWavBuffer(buffer);

  if (isStudioWav) {
    await saveAudioClip(
      {
        id,
        title: params.title,
        text: params.text,
        category: params.category,
        voiceName,
        style,
        source: 'gemini',
        studioVersion: 4,
      },
      buffer
    );

    if (isNativeAndroid()) {
      precacheNativeWav(params.text, voiceName, buffer).catch(() => {});
    }
  } else {
    // Only store non-studio fallback if there is no genuine studio WAV already saved for this ID
    const existing = await getAudioClipRecord(id);
    if (!existing || !isRiffWavBuffer(existing.wavData) || existing.entry.source !== 'gemini') {
      await saveAudioClip(
        {
          id,
          title: params.title,
          text: params.text,
          category: params.category,
          voiceName,
          style,
          source: 'fallback',
        },
        buffer
      );
    }
  }

  return {id, buffer, isStudioWav};
}

export async function speakFluentPersian(
  options: SpeakOptions
): Promise<'cache' | 'gemini' | 'neural-fallback' | 'offline-speech'> {
  stopAllSpeech();
  unlockAudioPlayback();
  const token = playbackToken;
  const voiceName = options.voiceName ?? 'Kore';
  const persona = getPersonaInfo(voiceName);
  const rate = options.rate ?? 1;
  const clipId = options.clipId ?? hashTextKey(options.text, voiceName);

  try {
    const cachedRecord = !options.forceOnlineRefresh ? await getAudioClipRecord(clipId) : null;
    if (token !== playbackToken) return 'cache';

    const cachedIsTrueStudioWav =
      Boolean(cachedRecord) &&
      isRiffWavBuffer(cachedRecord?.wavData) &&
      cachedRecord?.entry.source === 'gemini';
    const cachedIsStyledV4 = cachedIsTrueStudioWav && cachedRecord?.entry.studioVersion === 4;

    // 1. Play immediately from offline cache ONLY if it's latest styled studio WAV (or when offline)
    if (cachedRecord && (cachedIsStyledV4 || !navigator.onLine)) {
      options.onStart?.('cache');
      await playWavBuffer(cachedRecord.wavData, rate, token);
      if (token === playbackToken) options.onEnd?.();
      return 'cache';
    }

    // 2. If online (or existing cached clip is legacy/fallback), fetch styled Studio Gemini WAV
    {
      // Do not trust navigator.onLine inside Android WebView; attempt the cloud TTS
      // and fall back to the local engine only after a bounded network timeout.
      options.onLoading?.();
      try {
        const result = await generateAndCacheGeminiWav({
          text: options.text,
          title: options.title,
          category: options.category,
          voiceName,
          style: options.style,
          clipId,
          forceRefresh: Boolean(options.forceOnlineRefresh),
        });
        if (token !== playbackToken) return 'gemini';
        if ('buffer' in result) {
          // If server hit Free Tier quota (neural-fallback) but we already had an older Gemini WAV locally, keep playing the studio WAV
          if (!result.isStudioWav && cachedRecord && cachedIsTrueStudioWav) {
            options.onStart?.('cache');
            await playWavBuffer(cachedRecord.wavData, rate, token);
            if (token === playbackToken) options.onEnd?.();
            return 'cache';
          }
          const srcKind = result.isStudioWav ? 'gemini' : 'neural-fallback';
          options.onStart?.(srcKind);
          await playWavBuffer(result.buffer, rate, token);
          if (token === playbackToken) options.onEnd?.();
          return srcKind;
        }
      } catch (err) {
        console.warn('Online TTS fallback to cached/bilingual speech:', err);
      }

      // If network attempt failed but we had a fallback clip cached, play it rather than staying silent
      if (cachedRecord) {
        options.onStart?.(cachedIsTrueStudioWav ? 'cache' : 'neural-fallback');
        await playWavBuffer(cachedRecord.wavData, rate, token);
        if (token === playbackToken) options.onEnd?.();
        return cachedIsTrueStudioWav ? 'cache' : 'neural-fallback';
      }
    }

    if (token !== playbackToken) return 'offline-speech';

    // 3. Native Android TTS (if inside APK) or Web Speech bilingual fallback
    options.onStart?.('offline-speech');
    let ok = false;
    if (isNativeAndroid()) {
      ok = await speakNativeBilingual(options.text, persona.gender, rate);
      if (token !== playbackToken) return 'offline-speech';
    }
    if (!ok) {
      ok = await speakOfflineBilingual(options.text, rate, persona.gender, token);
      if (token === playbackToken) options.onEnd?.();
      return 'offline-speech';
    }
    options.onEnd?.();
    if (!ok) {
      options.onError?.(
        'برای پخش صوت، اتصال اینترنت (و در صورت نیاز فیلترشکن برای برنامه) را بررسی کنید تا فایل در حافظه آفلاین ذخیره شود.'
      );
    }
    return 'offline-speech';
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'خطا در پخش صوت';
    options.onError?.(msg);
    options.onEnd?.();
    return 'offline-speech';
  }
}

export async function playCachedClipById(id: string, rate = 1): Promise<boolean> {
  stopAllSpeech();
  unlockAudioPlayback();
  const token = playbackToken;
  const buf = await getAudioClipBuffer(id);
  if (!buf) return false;
  await playWavBuffer(buf, rate, token);
  return true;
}

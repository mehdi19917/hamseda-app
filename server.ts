import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {Readable} from 'stream';
import {GoogleGenAI, ThinkingLevel, Type} from '@google/genai';
import {MsEdgeTTS, OUTPUT_FORMAT} from 'msedge-tts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({limit: '2mb'}));
app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

function getAiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function getTtsAiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    apiVersion: 'v1beta',
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function getAlphaAiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    apiVersion: 'v1alpha',
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

app.get('/api/health', (_req, res) => {
  const hasKey = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY');
  res.json({ok: true, aiReady: hasKey});
});

app.post('/api/morning-message', async (req, res) => {
  const ai = getAiClient();
  if (!ai) {
    res.status(503).json({
      error: 'سرویس هوش مصنوعی در دسترس نیست. حالت آفلاین فعال است.',
      offlineFallback: true,
    });
    return;
  }

  try {
    const dayPart = typeof req.body?.dayPart === 'string' ? req.body.dayPart : 'morning';
    const mood = typeof req.body?.mood === 'string' ? req.body.mood : 'پرانرژی و امیدوار';
    const goalsSummary = typeof req.body?.goalsSummary === 'string' ? req.body.goalsSummary : '';
    const recipient = typeof req.body?.recipient === 'string' ? req.body.recipient : 'من و زری';

    const prompt = `یک پیام صمیمی، انگیزشی، ادبی و بسیار دلنشین به زبان فارسی روان و امروزی بنویس برای «${recipient}».
زمان روز: ${dayPart === 'morning' ? 'صبح دل‌انگیز' : dayPart === 'midday' ? 'میانه روز و تجدید انرژی' : 'شامگاه و آرامش شکرگذاری'}
حال و هوای فعلی: ${mood}
${goalsSummary ? `برخی اهداف امروز: ${goalsSummary}` : ''}
پیام باید گرم، واقعی، غیرکلیشه‌ای، پر از امید و عشق به زندگی مشترک و پیشرفت هدفمند باشد.`;

    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: prompt,
      config: {
        systemInstruction:
          'تو نویسنده و مربی زندگی فارسی‌زبان هستی. پاسخ را فقط با ساختار JSON خواسته‌شده برگردان و از جملات کوتاه، روان و قابل خواندن با صدای بلند استفاده کن.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: {type: Type.STRING, description: 'تیتر کوتاه و الهام‌بخش فارسی'},
            message: {type: Type.STRING, description: 'متن پیام صبحگاهی یا انرژی‌بخش در ۲ تا ۳ جمله روان'},
            affirmation: {type: Type.STRING, description: 'یک جمله تاکیدی مثبت و کوتاه برای تکرار امروز'},
            energyTip: {type: Type.STRING, description: 'یک اقدام عملی کوچک برای بالا بردن انرژی امروز'},
          },
          required: ['title', 'message', 'affirmation', 'energyTip'],
        },
      },
    });

    const parsed = JSON.parse((response.text ?? '{}').trim());
    res.json(parsed);
  } catch (err) {
    console.error('Morning message generation failed:', err);
    res.status(500).json({
      error: 'خطا در دریافت پیام هوشمند. از پیام‌های کتابخانه آفلاین استفاده می‌شود.',
    });
  }
});

interface CachedAudioEntry {
  base64: string;
  mimeType: 'audio/wav' | 'audio/mpeg';
}

const ttsServerCache = new Map<string, CachedAudioEntry>();
const MAX_SERVER_TTS_CACHE = 160;
const TTS_DISK_CACHE_DIR = '/tmp/rmz_tts_cache';
const ttsModelCooldownUntil = new Map<string, number>();

try {
  fs.mkdirSync(TTS_DISK_CACHE_DIR, {recursive: true});
} catch {
  // ignore if tmp dir unavailable
}

function getCacheFilePath(cacheKey: string, ext: 'wav' | 'mp3'): string {
  const hash = crypto.createHash('sha256').update(cacheKey).digest('hex').slice(0, 32);
  return path.join(TTS_DISK_CACHE_DIR, `${hash}.${ext}`);
}

function readCachedAudio(cacheKey: string): CachedAudioEntry | null {
  const mem = ttsServerCache.get(cacheKey);
  if (mem) return mem;
  try {
    const wavPath = getCacheFilePath(cacheKey, 'wav');
    if (fs.existsSync(wavPath)) {
      const buf = fs.readFileSync(wavPath);
      if (buf.length > 44) {
        const entry: CachedAudioEntry = {base64: buf.toString('base64'), mimeType: 'audio/wav'};
        ttsServerCache.set(cacheKey, entry);
        return entry;
      }
    }
    const mp3Path = getCacheFilePath(cacheKey, 'mp3');
    if (fs.existsSync(mp3Path)) {
      const buf = fs.readFileSync(mp3Path);
      if (buf.length > 100) {
        const entry: CachedAudioEntry = {base64: buf.toString('base64'), mimeType: 'audio/mpeg'};
        ttsServerCache.set(cacheKey, entry);
        return entry;
      }
    }
  } catch {
    // ignore disk read errors
  }
  return null;
}

function writeCachedAudio(cacheKey: string, entry: CachedAudioEntry): void {
  if (ttsServerCache.size >= MAX_SERVER_TTS_CACHE) {
    const oldestKey = ttsServerCache.keys().next().value;
    if (oldestKey) ttsServerCache.delete(oldestKey);
  }
  ttsServerCache.set(cacheKey, entry);
  try {
    const ext = entry.mimeType === 'audio/mpeg' ? 'mp3' : 'wav';
    fs.writeFileSync(getCacheFilePath(cacheKey, ext), Buffer.from(entry.base64, 'base64'));
  } catch {
    // ignore disk write errors
  }
}

function escapeXmlForSsml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const FINGLISH_WORD_MAP: Record<string, string> = {
  bahman: 'بَهمن',
  mousaali: 'موساعلی',
  musaali: 'موساعلی',
  mousa: 'موسی',
  musa: 'موسی',
  zari: 'زَری',
  zahra: 'زهرا',
  mehdi: 'مهدی',
  mohammad: 'محمد',
  muhammad: 'محمد',
  ali: 'علی',
  reza: 'رضا',
  hossein: 'حسین',
  hasan: 'حسن',
  sara: 'سارا',
  maryam: 'مریم',
  mina: 'مینا',
  neda: 'ندا',
  amir: 'امیر',
  saeed: 'سعید',
  omid: 'امید',
  navid: 'نوید',
  pouya: 'پویا',
  arash: 'آرش',
  radin: 'رادین',
  negin: 'نگین',
  nasim: 'نسیم',
  mom: 'مامان',
  maman: 'مامان',
  baba: 'بابا',
  dad: 'پدر',
  khanoom: 'خانوم',
  khanom: 'خانم',
  agha: 'آقا',
  jan: 'جان',
  joon: 'جون',
  jun: 'جون',
  salam: 'سَلام',
  slm: 'سَلام',
  salm: 'سَلام',
  khobi: 'خوبی',
  khoobi: 'خوبی',
  khubi: 'خوبی',
  chetori: 'چطوری',
  chetor: 'چطور',
  chetory: 'چطوری',
  merci: 'مِرسی',
  mersi: 'مِرسی',
  mersy: 'مِرسی',
  mamnoon: 'ممنون',
  mamnun: 'ممنون',
  mamnon: 'ممنون',
  fadat: 'فدات',
  fedat: 'فدات',
  azizam: 'عزیزم',
  aziz: 'عزیز',
  eshgham: 'عشقم',
  delam: 'دلم',
  ghorbonet: 'قربونت',
  ghorbunet: 'قربونت',
  khabar: 'خبر',
  chiz: 'چیز',
  chizi: 'چیزی',
  man: 'من',
  to: 'تو',
  shoma: 'شما',
  beman: 'به من',
  behem: 'بهم',
  bezang: 'بزنگ',
  zang: 'زنگ',
  bezan: 'بزن',
  omadam: 'اومدم',
  oomadam: 'اومدم',
  umadam: 'اومدم',
  miram: 'میرم',
  miam: 'میام',
  khone: 'خونه',
  khoone: 'خونه',
  khune: 'خونه',
  kar: 'کار',
  kare: 'کارِ',
  sob: 'صبح',
  sobh: 'صبح',
  shab: 'شب',
  bekheir: 'بخیر',
  bekheyr: 'بخیر',
  khosh: 'خوش',
  are: 'آره',
  bale: 'بله',
  na: 'نه',
  kheili: 'خیلی',
  kheyli: 'خیلی',
  babakhshid: 'ببخشید',
  bebakhshid: 'ببخشید',
  lotfan: 'لطفاً',
  mokhles: 'مخلص',
  dost: 'دوست',
  doost: 'دوست',
  daram: 'دارم',
  dooset: 'دوستت',
  doset: 'دوستت',
  ok: 'اوکِی',
  okay: 'اوکِی',
  hello: 'هلو',
  hi: 'های',
  hey: 'هِی',
  bye: 'بای',
  good: 'گود',
  morning: 'مورنینگ',
  night: 'نایت',
  please: 'پلیز',
  thanks: 'تَنکس',
  thank: 'تَنک',
  sorry: 'ساری',
  love: 'لاو',
  you: 'یو',
  call: 'کال',
  calling: 'کالینگ',
  incoming: 'اینکامینگ',
  from: 'فرام',
  design: 'دیزاین',
  tech: 'تک',
  support: 'ساپورت',
  manager: 'منیجر',
  office: 'آفیس',
  work: 'وُرک',
  home: 'هوم',
  team: 'تیم',
  project: 'پروژه',
  dr: 'دکتر',
  mr: 'آقای',
  mrs: 'خانم',
  ms: 'خانم',
  sms: 'اس‌ام‌اس',
  rcs: 'آر‌سی‌اس',
  vpn: 'وی‌پی‌ان',
  wifi: 'وای‌فای',
};

function transliterateSingleLatinWord(rawWord: string): string {
  const clean = rawWord.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
  if (!clean) return rawWord;
  const lower = clean.toLowerCase();
  if (FINGLISH_WORD_MAP[lower]) {
    return FINGLISH_WORD_MAP[lower];
  }

  let s = lower;
  s = s.replace(/tion\b/g, 'شِن');
  s = s.replace(/sion\b/g, 'ژِن');
  s = s.replace(/sh/g, 'ش');
  s = s.replace(/ch/g, 'چ');
  s = s.replace(/kh/g, 'خ');
  s = s.replace(/gh/g, 'ق');
  s = s.replace(/zh/g, 'ژ');
  s = s.replace(/ph/g, 'ف');
  s = s.replace(/th/g, 'ت');
  s = s.replace(/ck/g, 'ک');
  s = s.replace(/qu/g, 'کو');
  s = s.replace(/oo|ou/g, 'او');
  s = s.replace(/ee|ea/g, 'ای');
  s = s.replace(/ai|ay|ey|ei/g, 'اِی');
  s = s.replace(/au|aw/g, 'آ');

  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const isFirst = i === 0;
    const isLast = i === s.length - 1;
    if (/[\u0600-\u06FF]/.test(ch)) {
      out += ch;
      continue;
    }
    switch (ch) {
      case 'a':
        out += isFirst ? 'آ' : isLast ? 'ا' : 'اَ';
        break;
      case 'b':
        out += 'ب';
        break;
      case 'c':
        out += s[i + 1] === 'e' || s[i + 1] === 'i' || s[i + 1] === 'y' ? 'س' : 'ک';
        break;
      case 'd':
        out += 'د';
        break;
      case 'e':
        out += isFirst ? 'اِ' : isLast ? 'ه' : 'ِ';
        break;
      case 'f':
        out += 'ف';
        break;
      case 'g':
        out += 'گ';
        break;
      case 'h':
        out += 'ه';
        break;
      case 'i':
        out += isFirst ? 'ای' : 'ی';
        break;
      case 'j':
        out += 'ج';
        break;
      case 'k':
        out += 'ک';
        break;
      case 'l':
        out += 'ل';
        break;
      case 'm':
        out += 'م';
        break;
      case 'n':
        out += 'ن';
        break;
      case 'o':
        out += isFirst ? 'اُ' : 'و';
        break;
      case 'p':
        out += 'پ';
        break;
      case 'q':
        out += 'ق';
        break;
      case 'r':
        out += 'ر';
        break;
      case 's':
        out += 'س';
        break;
      case 't':
        out += 'ت';
        break;
      case 'u':
        out += isFirst ? 'او' : 'و';
        break;
      case 'v':
        out += 'و';
        break;
      case 'w':
        out += 'و';
        break;
      case 'x':
        out += 'کس';
        break;
      case 'y':
        out += isFirst ? 'ی' : 'ی';
        break;
      case 'z':
        out += 'ز';
        break;
      default:
        break;
    }
  }
  return out || rawWord;
}

function normalizeFinglishAndEnglishToPersian(input: string): string {
  if (!/[A-Za-z]/.test(input)) return input;
  return input.replace(/[A-Za-z]+(?:['’.-][A-Za-z]+)*/g, (token) => {
    const parts = token.split(/(['’.-])/);
    return parts
      .map((part) => (/^[A-Za-z]+$/.test(part) ? transliterateSingleLatinWord(part) : part === '.' ? ' ' : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  });
}

const latinPhoneticCache = new Map<string, string>();

async function transliterateLatinToPersianPhonetic(input: string, ai: GoogleGenAI | null): Promise<string> {
  if (!/[A-Za-z]{2,}/.test(input)) {
    return input;
  }
  const cached = latinPhoneticCache.get(input);
  if (cached) return cached;

  const heuristic = normalizeFinglishAndEnglishToPersian(input);
  if (!ai) {
    return heuristic;
  }

  try {
    const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 2800));
    const genPromise = ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: `متن زیر ترکیبی از فارسی و نام‌ها یا پیامک‌های فینگلیش/انگلیسی است.
فقط بخش‌های حروف انگلیسی/فینگلیش را به شکل خوانا و دقیق به خط فارسی آوایی (با اعراب کوتاه در صورت نیاز مثل بَهمن موساعلی، سَلام، زَری، دیزاین، کال) بازنویسی کن تا یک گوینده فارسی‌زبان بدون مکث و اشتباه بخواند.
کلمات فارسی موجود، علائم و معنی جمله را هیچ تغییری نده و هیچ توضیح اضافه‌ای ننویس؛ فقط متن آماده خواندن را برگردان:

${input}`,
      config: {
        thinkingConfig: {thinkingLevel: ThinkingLevel.LOW},
      },
    });

    const resp = await Promise.race([genPromise, timeoutPromise]);
    const rawOut = resp && typeof resp === 'object' && 'text' in resp ? (resp.text ?? '').trim() : '';
    const cleaned = rawOut
      .replace(/^["«']+|["»']+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (cleaned && !/[A-Za-z]{2,}/.test(cleaned) && cleaned.length <= input.length * 4 + 40) {
      if (latinPhoneticCache.size >= 300) {
        const first = latinPhoneticCache.keys().next().value;
        if (first) latinPhoneticCache.delete(first);
      }
      latinPhoneticCache.set(input, cleaned);
      return cleaned;
    }
  } catch {
    // Fall back silently to fast deterministic Finglish transliteration
  }

  return heuristic;
}

async function synthesizeEdgePersianMp3(text: string, voiceName: string): Promise<string | null> {
  const voiceProfiles: Record<string, {edgeVoice: string; rate: string; pitch: string}> = {
    Kore: {edgeVoice: 'fa-IR-DilaraNeural', rate: '+0%', pitch: '+2Hz'},
    Zephyr: {edgeVoice: 'fa-IR-DilaraNeural', rate: '-6%', pitch: '+0Hz'},
    Puck: {edgeVoice: 'fa-IR-FaridNeural', rate: '+6%', pitch: '+12Hz'},
    Charon: {edgeVoice: 'fa-IR-FaridNeural', rate: '-2%', pitch: '-6Hz'},
    Fenrir: {edgeVoice: 'fa-IR-FaridNeural', rate: '+3%', pitch: '+0Hz'},
  };
  const profile = voiceProfiles[voiceName] ?? voiceProfiles.Kore;
  const tts = new MsEdgeTTS({connectionTimeoutMs: 7000, synthesisTimeoutMs: 11000});

  try {
    await tts.setMetadata(profile.edgeVoice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const {audioStream} = tts.toStream(escapeXmlForSsml(text), {
      rate: profile.rate,
      pitch: profile.pitch,
    });

    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('edge-tts timeout')), 10000);
      audioStream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      audioStream.on('end', () => {
        clearTimeout(timer);
        resolve();
      });
      audioStream.on('error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    const buf = Buffer.concat(chunks);
    if (buf.length < 100) return null;
    return buf.toString('base64');
  } catch (err) {
    console.warn('Edge neural Persian TTS fallback error:', err instanceof Error ? err.message : err);
    return null;
  } finally {
    try {
      tts.close();
    } catch {
      // ignore close errors
    }
  }
}

function ensureWavBase64(base64Data: string, mimeType?: string): string {
  const raw = Buffer.from(base64Data, 'base64');
  if (raw.length >= 12 && raw.subarray(0, 4).toString('ascii') === 'RIFF') {
    return base64Data;
  }
  // Parse sample rate if provided (e.g., audio/L16;codec=pcm;rate=24000)
  let sampleRate = 24000;
  const rateMatch = mimeType?.match(/rate=(\d+)/i);
  if (rateMatch) {
    const parsed = Number(rateMatch[1]);
    if (Number.isFinite(parsed) && parsed >= 8000 && parsed <= 48000) {
      sampleRate = parsed;
    }
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + raw.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM format chunk size
  header.writeUInt16LE(1, 20); // PCM linear
  header.writeUInt16LE(1, 22); // Mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(raw.length, 40);
  return Buffer.concat([header, raw]).toString('base64');
}

let ttsQueueTail: Promise<void> = Promise.resolve();
let lastTtsCallAt = 0;

function runWithTtsPacing<T>(task: () => Promise<T>): Promise<T> {
  const scheduled = ttsQueueTail.then(async () => {
    const gap = Date.now() - lastTtsCallAt;
    if (gap < 650) {
      await new Promise((r) => setTimeout(r, 650 - gap));
    }
    lastTtsCallAt = Date.now();
    return task();
  });
  ttsQueueTail = scheduled.then(
    () => undefined,
    () => undefined
  );
  return scheduled;
}

app.post('/api/tts', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) {
    res.status(400).json({error: 'متن برای تبدیل به گفتار ارسال نشده است.'});
    return;
  }
  if (text.length > 1500) {
    res.status(400).json({error: 'طول متن نباید بیشتر از ۱۵۰۰ کاراکتر باشد.'});
    return;
  }

  const allowedVoices = ['Kore', 'Zephyr', 'Puck', 'Charon', 'Fenrir'];
  const voiceName = allowedVoices.includes(req.body?.voiceName) ? req.body.voiceName : 'Kore';
  const forceRefresh = Boolean(req.body?.forceRefresh);
  // v4_gemini cache strictly stores ONLY genuine styled Gemini WAV audio — NEVER robotic Edge MP3 fallbacks.
  const cacheKey = `v4_gemini::${voiceName}::${text}`;
  if (!forceRefresh) {
    const cached = readCachedAudio(cacheKey);
    if (cached && cached.mimeType === 'audio/wav') {
      res.json({
        audioBase64: cached.base64,
        mimeType: cached.mimeType,
        voiceName,
        cached: true,
        provider: 'gemini',
      });
      return;
    }
  }

  const baseAi = getAiClient();
  const betaAi = getTtsAiClient();
  const alphaAi = getAlphaAiClient();
  const speechText = /[A-Za-z]{2,}/.test(text)
    ? await transliterateLatinToPersianPhonetic(text, baseAi ?? betaAi)
    : text;

  const voiceGenderHint: Record<string, string> = {
    Kore: 'Adult female speaker. Warm, affectionate, deeply natural everyday Tehran Persian female voice with smooth fluent phrasing.',
    Zephyr: 'Adult female speaker. Soft, calm, expressive, soothing Tehran Persian female voice with natural human warmth.',
    Puck: 'Young adult male speaker. Warm, cheerful, energetic, crisp everyday Tehran Persian voice.',
    Charon: 'Adult male speaker. Deep baritone, warm, steady, articulate Tehran Persian male voice.',
    Fenrir: 'Adult male speaker. Resonant, confident, clear, natural Tehran Persian male voice.',
  };
  const customStyle = typeof req.body?.style === 'string' && req.body.style.trim() ? req.body.style.trim() : '';
  const style = `${voiceGenderHint[voiceName]} ${customStyle}`.trim();

  try {
    let wavBase64: string | undefined;
    let modelUsed: string | undefined;
    let sawQuotaError = false;

    if (baseAi || betaAi || alphaAi) {
      const attemptSynthesis = async (): Promise<{
        wavBase64?: string;
        modelUsed?: string;
        sawQuotaError: boolean;
      }> => {
        const fallbackClient = betaAi ?? baseAi!;
        const candidates: {client: GoogleGenAI; model: string; is25: boolean; withMetadata: boolean}[] = [];
        const now = Date.now();
        if (now >= (ttsModelCooldownUntil.get('gemini-2.5-flash-preview-tts') ?? 0)) {
          candidates.push({client: fallbackClient, model: 'gemini-2.5-flash-preview-tts', is25: true, withMetadata: false});
        }
        if (alphaAi) {
          if (now >= (ttsModelCooldownUntil.get('gemini-3.8-flash-tts') ?? 0)) {
            candidates.push({client: alphaAi, model: 'gemini-3.8-flash-tts', is25: false, withMetadata: true});
            candidates.push({client: alphaAi, model: 'gemini-3.8-flash-tts', is25: false, withMetadata: false});
          }
          if (now >= (ttsModelCooldownUntil.get('gemini-3.8-flash-lite-tts') ?? 0)) {
            candidates.push({client: alphaAi, model: 'gemini-3.8-flash-lite-tts', is25: false, withMetadata: true});
            candidates.push({client: alphaAi, model: 'gemini-3.8-flash-lite-tts', is25: false, withMetadata: false});
          }
        }

        let foundWav: string | undefined;
        let usedModel: string | undefined;
        let hitQuota = false;

        for (const cand of candidates) {
          if (Date.now() < (ttsModelCooldownUntil.get(cand.model) ?? 0)) {
            continue;
          }
          try {
            const contents = cand.is25
              ? [
                  {
                    role: 'user',
                    parts: [
                      {
                        text: `Read aloud ONLY this exact transcript in warm, fluent, natural Tehran Persian (${style}). Do not add extra words:\n\n${speechText}`,
                      },
                    ],
                  },
                ]
              : cand.withMetadata
                ? [{role: 'user', parts: [{text: speechText, speechMetadata: {style}}]}]
                : [{role: 'user', parts: [{text: speechText}]}];

            const response = await cand.client.models.generateContent({
              model: cand.model,
              contents,
              config: {
                responseModalities: ['AUDIO'],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: {voiceName},
                  },
                },
              },
            });
            const inline = response.candidates?.[0]?.content?.parts?.[0]?.inlineData;
            if (inline?.data) {
              foundWav = ensureWavBase64(inline.data, inline.mimeType);
              usedModel = cand.withMetadata ? `${cand.model}+meta` : cand.model;
              break;
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (cand.withMetadata && (msg.includes('speechMetadata') || msg.includes('Cannot find field'))) {
              // Quietly fall back to plain parts on next candidate without spamming warnings
              continue;
            }
            console.warn(`TTS on ${cand.model} (${voiceName}) failed:`, msg.slice(0, 180));
            if (
              cand.model.startsWith('gemini-3.8') &&
              !cand.withMetadata &&
              (msg.includes('Cannot find field') || msg.includes('INVALID_ARGUMENT') || msg.includes('NOT_FOUND'))
            ) {
              ttsModelCooldownUntil.set(cand.model, Date.now() + 30 * 60 * 1000);
            }
            if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota')) {
              hitQuota = true;
              const isDailyLimit = msg.includes('PerDay') || msg.includes('per day');
              ttsModelCooldownUntil.set(cand.model, Date.now() + (isDailyLimit ? 5 * 60 * 1000 : 25 * 1000));
            }
          }
        }
        return {wavBase64: foundWav, modelUsed: usedModel, sawQuotaError: hitQuota};
      };

      const firstRes = await runWithTtsPacing(attemptSynthesis);
      wavBase64 = firstRes.wavBase64;
      modelUsed = firstRes.modelUsed;
      sawQuotaError = firstRes.sawQuotaError;
    }

    if (wavBase64) {
      writeCachedAudio(cacheKey, {base64: wavBase64, mimeType: 'audio/wav'});
      res.json({
        audioBase64: wavBase64,
        mimeType: 'audio/wav',
        voiceName,
        spokenText: speechText,
        provider: 'gemini',
        modelUsed,
      });
      return;
    }

    // Emergency neural fallback (NEVER written to v3_gemini cache so studio voices recover automatically!)
    const edgeMp3 = await synthesizeEdgePersianMp3(speechText, voiceName);
    if (edgeMp3) {
      res.json({
        audioBase64: edgeMp3,
        mimeType: 'audio/mpeg',
        voiceName,
        spokenText: speechText,
        provider: 'neural-fallback',
      });
      return;
    }

    res.json({
      fallbackOffline: true,
      spokenText: speechText,
      reason: sawQuotaError ? 'quota' : 'unavailable',
    });
  } catch (err) {
    console.error('TTS route error:', err instanceof Error ? err.message : err);
    const edgeMp3 = await synthesizeEdgePersianMp3(speechText, voiceName);
    if (edgeMp3) {
      res.json({
        audioBase64: edgeMp3,
        mimeType: 'audio/mpeg',
        voiceName,
        spokenText: speechText,
        provider: 'neural-fallback',
      });
      return;
    }
    res.json({
      fallbackOffline: true,
      spokenText: speechText,
      reason: 'error',
    });
  }
});

app.post('/api/caller-pronounce', async (req, res) => {
  const ai = getAiClient();
  if (!ai) {
    res.status(503).json({error: 'سرویس آنلاین در دسترس نیست.'});
    return;
  }

  const rawName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const template = typeof req.body?.template === 'string' ? req.body.template.trim() : 'تماس ورودی از طرف {name}';
  if (!rawName) {
    res.status(400).json({error: 'نام مخاطب وارد نشده است.'});
    return;
  }

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: `نام مخاطب: "${rawName}"
الگوی اعلام تماس: "${template}"
لطفاً متن نهایی اعلام تماس را طوری بنویس که یک گوینده دوزبانه فارسی و انگلیسی آن را کاملاً روان و بدون مکث اشتباه بخواند. اگر نام فینگلیش است، تلفظ طبیعی آن را حفظ کن و یک راهنمای آوایی کوتاه هم بده.`,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            spokenScript: {type: Type.STRING, description: 'متن دقیق و روان برای خواندن توسط سیستم صوتی'},
            persianPhonetic: {type: Type.STRING, description: 'راهنمای تلفظ فارسی برای حالت آفلاین'},
            detectedLanguage: {type: Type.STRING, description: 'persian یا latin یا bilingual'},
          },
          required: ['spokenScript', 'persianPhonetic', 'detectedLanguage'],
        },
      },
    });

    const parsed = JSON.parse((response.text ?? '{}').trim());
    res.json(parsed);
  } catch (err) {
    console.error('Caller pronounce helper failed:', err);
    res.status(500).json({error: 'خطا در تحلیل تلفظ نام مخاطب.'});
  }
});

app.post('/api/special-message', async (req, res) => {
  const ai = getAiClient();
  if (!ai) {
    res.status(503).json({
      error: 'سرویس آنلاین پیام‌ساز در دسترس نیست؛ از قالب‌های آماده آفلاین استفاده کنید.',
      offlineFallback: true,
    });
    return;
  }

  const occasion = typeof req.body?.occasion === 'string' ? req.body.occasion.trim() : 'پیام مناسبتی';
  const recipient = typeof req.body?.recipient === 'string' ? req.body.recipient.trim() : 'عزیز دلم';
  const senderName = typeof req.body?.senderName === 'string' ? req.body.senderName.trim() : 'بهمن';
  const tone = typeof req.body?.tone === 'string' ? req.body.tone.trim() : 'صمیمی و گرم';
  const details = typeof req.body?.details === 'string' ? req.body.details.trim() : '';

  try {
    const prompt = `یک پیام فارسی بسیار خوش‌بیان، ادبی اما صمیمی و غیرکلیشه‌ای بنویس.
مناسبت یا موضوع: ${occasion}
مخاطب پیام (برای چه کسی): ${recipient}
فرستنده: ${senderName}
لحن دلخواه: ${tone}
${details ? `نکات یا خاطرات دلخواه برای اشاره در متن: ${details}` : ''}
پیام باید طوری باشد که هم برای ارسال در پیام‌رسان/پیامک عالی باشد و هم وقتی با صدای بلند خوانده می‌شود بسیار دلنشین و طبیعی به گوش برسد.`;

    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: prompt,
      config: {
        systemInstruction:
          'تو نویسنده چیره‌دست فارسی برای متن‌های صمیمی، تبریک تولد، سالگرد، آشتی، قدردانی و دلگرمی هستی. فقط JSON خواسته‌شده را برگردان.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: {type: Type.STRING, description: 'عنوان کوتاه و زیبا برای پیام'},
            text: {type: Type.STRING, description: 'متن کامل پیام در ۳ تا ۵ جمله روان و احساسی'},
            shortVersion: {type: Type.STRING, description: 'نسخه کوتاه ۱ یا ۲ جمله‌ای مناسب پیامک'},
            occasion: {type: Type.STRING, description: 'نام مناسبت'},
          },
          required: ['title', 'text', 'shortVersion', 'occasion'],
        },
      },
    });

    const parsed = JSON.parse((response.text ?? '{}').trim());
    res.json(parsed);
  } catch (err) {
    console.error('Special message generation failed:', err);
    res.status(500).json({error: 'خطا در ساخت پیام مناسبتی هوشمند.'});
  }
});

app.post('/api/batch-phonetic', async (req, res) => {
  const rawNames = Array.isArray(req.body?.names) ? (req.body.names as unknown[]) : [];
  const cleanNames = Array.from(
    new Set(
      rawNames
        .filter((n): n is string => typeof n === 'string')
        .map((n) => n.trim())
        .filter((n) => n.length > 0 && n.length <= 90)
    )
  ).slice(0, 160);

  if (cleanNames.length === 0) {
    res.json({phonetics: {}});
    return;
  }

  const phonetics: Record<string, string> = {};
  const latinNames: string[] = [];

  for (const name of cleanNames) {
    const lower = name.toLowerCase();
    if (!/[A-Za-z]/.test(name)) {
      phonetics[lower] = name;
    } else {
      phonetics[lower] = normalizeFinglishAndEnglishToPersian(name);
      latinNames.push(name);
    }
  }

  const ai = getAiClient();
  if (ai && latinNames.length > 0) {
    for (let i = 0; i < latinNames.length; i += 80) {
      const chunk = latinNames.slice(i, i + 80);
      try {
        const response = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: `این فهرست نام‌های مخاطبین دفترچه تلفن است که بخشی یا تمام آن‌ها به خط انگلیسی یا فینگلیش نوشته شده‌اند.
برای هر نام، تلفظ دقیق و بسیار روان آن را به خط فارسی آوایی (با اعراب کوتاه در صورت نیاز مثل بَهمن موساعلی، زَری جان، دکتر احمدی، سارا دِیزاین، بابا، مامان) برگردان تا موتور صوتی فارسی بدون خطا و بدون نیاز به انگلیسی بخواند:
${JSON.stringify(chunk)}`,
          config: {
            thinkingConfig: {thinkingLevel: ThinkingLevel.LOW},
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                entries: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      raw: {type: Type.STRING, description: 'Exact input name string'},
                      persianPhonetic: {type: Type.STRING, description: 'Fluent Persian phonetic spelling'},
                    },
                    required: ['raw', 'persianPhonetic'],
                  },
                },
              },
              required: ['entries'],
            },
          },
        });
        const parsed = JSON.parse((response.text ?? '{}').trim()) as {
          entries?: {raw?: string; persianPhonetic?: string}[];
        };
        for (const item of parsed.entries ?? []) {
          const raw = typeof item.raw === 'string' ? item.raw.trim().toLowerCase() : '';
          const ph = typeof item.persianPhonetic === 'string' ? item.persianPhonetic.trim() : '';
          if (raw && ph && !/[A-Za-z]{2,}/.test(ph)) {
            phonetics[raw] = ph;
          }
        }
      } catch (err) {
        console.warn('Batch phonetic AI chunk fallback:', err instanceof Error ? err.message : err);
      }
    }
  }

  res.json({phonetics});
});

interface ServerMusicTrack {
  id: string;
  title: string;
  artist: string;
  album?: string;
  artworkUrl?: string;
  streamUrl: string;
  durationSec?: number;
  isLiveStream?: boolean;
  country?: string;
  tags?: string;
  source: 'audius' | 'archive' | 'radio';
  externalUrl?: string;
}

function isSafePublicAudioUrl(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const host = parsed.hostname.toLowerCase();
    if (
      !host ||
      host === 'localhost' ||
      host === '::1' ||
      host === '[::1]' ||
      host === '[::]' ||
      host === '0.0.0.0' ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      host.startsWith('127.') ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      host.startsWith('169.254.') ||
      host.startsWith('[fe80:') ||
      host.startsWith('fe80:') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function wrapRadioStreamUrl(rawUrl: string): string {
  const cleaned = rawUrl.trim();
  if (cleaned.startsWith('http://')) {
    return `/api/audio-proxy?url=${encodeURIComponent(cleaned)}`;
  }
  return cleaned;
}

interface RadioBrowserStation {
  stationuuid?: string;
  name?: string;
  url?: string;
  url_resolved?: string;
  homepage?: string;
  favicon?: string;
  tags?: string;
  country?: string;
  countrycode?: string;
  codec?: string;
  bitrate?: number;
  votes?: number;
}

const CURATED_IRAN_STATIONS: ServerMusicTrack[] = [
  {
    id: 'curated_navahang',
    title: 'رادیو نواهنگ (موزیک پاپ و آرام ایرانی)',
    artist: 'Radio Navahang · پخش زنده شبانه‌روزی',
    streamUrl: 'https://nav.ritmo.ir:8443/navahang',
    isLiveStream: true,
    country: 'ایران / فارسی',
    tags: 'persian, pop, iranian music',
    source: 'radio',
    externalUrl: 'https://navahang.com',
  },
  {
    id: 'curated_hamrah',
    title: 'رادیو همراه (موسیقی و گفتار فارسی)',
    artist: 'Radio Hamrah · پخش زنده فارسی',
    streamUrl: 'https://stream.radiohamrah.com:8443/radiohamrah',
    isLiveStream: true,
    country: 'فارسی',
    tags: 'persian, talk, music',
    source: 'radio',
  },
  {
    id: 'curated_parsa',
    title: 'رادیو پارسا (موسیقی ایرانی)',
    artist: 'Radio Parsa · پخش زنده ایران',
    streamUrl: wrapRadioStreamUrl('http://parsa.icdndhcp.com:18000/stream'),
    isLiveStream: true,
    country: 'ایران',
    tags: 'persian, iranian',
    source: 'radio',
  },
  {
    id: 'curated_faaz',
    title: 'رادیو فاز (آهنگ‌های جدید ایرانی)',
    artist: 'Radio Faaz · موزیک فارسی',
    streamUrl: wrapRadioStreamUrl('http://www.radiofaaz.com:8000/radiofaaz'),
    isLiveStream: true,
    country: 'ایران / فارسی',
    tags: 'persian, pop',
    source: 'radio',
  },
];

const CURATED_WORLD_CHILL_STATIONS: ServerMusicTrack[] = [
  {
    id: 'curated_somafm_groove',
    title: 'SomaFM Groove Salad (امبینت و آرامش)',
    artist: 'آمریکا · پخش زنده بدون تبلیغ',
    streamUrl: 'https://ice2.somafm.com/groovesalad-128-mp3',
    isLiveStream: true,
    country: 'United States',
    tags: 'ambient, chillout, downtempo',
    source: 'radio',
    externalUrl: 'https://somafm.com/groovesalad/',
  },
  {
    id: 'curated_smooth_chill',
    title: 'Smooth Chill (موزیک آرامش‌بخش شبانه)',
    artist: 'بریتانیا · پخش زنده لایت',
    streamUrl: 'https://media-ssl.musicradio.com/SmoothChill',
    isLiveStream: true,
    country: 'United Kingdom',
    tags: 'chill, lounge, relaxing',
    source: 'radio',
  },
  {
    id: 'curated_somafm_drone',
    title: 'SomaFM Drone Zone (مدیتیشن و خواب آرام)',
    artist: 'آمریکا · صدای فضایی و آرام',
    streamUrl: 'https://ice1.somafm.com/dronezone-128-mp3',
    isLiveStream: true,
    country: 'United States',
    tags: 'ambient, sleep, meditation',
    source: 'radio',
  },
];

async function queryRadioBrowser(queryPathAndParams: string): Promise<RadioBrowserStation[]> {
  const hosts = ['https://de1.api.radio-browser.info', 'https://all.api.radio-browser.info'];
  for (const host of hosts) {
    try {
      const r = await fetch(`${host}/json/stations/search?${queryPathAndParams}`, {
        headers: {'User-Agent': 'RoozhayeManOZari/1.0'},
        signal: AbortSignal.timeout(6500),
      });
      if (!r.ok) continue;
      const data = await r.json();
      if (Array.isArray(data) && data.length > 0) {
        return data as RadioBrowserStation[];
      }
    } catch {
      // try next mirror
    }
  }
  return [];
}

function mapRadioStationsToTracks(stations: RadioBrowserStation[], maxItems = 24): ServerMusicTrack[] {
  const out: ServerMusicTrack[] = [];
  const seenStreams = new Set<string>();

  for (const st of stations) {
    const rawName = String(st?.name || '').replace(/\s+/g, ' ').trim();
    const rawStream = String(st?.url_resolved || st?.url || '').trim();
    if (!rawName || rawName.length > 90 || rawName.includes('?ref=')) continue;
    if (rawStream.includes('.m3u8') || rawStream.includes('.pls')) continue;
    const parsedUrl = isSafePublicAudioUrl(rawStream);
    if (!parsedUrl) continue;

    const dedupeKey = parsedUrl.href.toLowerCase();
    if (seenStreams.has(dedupeKey)) continue;
    seenStreams.add(dedupeKey);

    const country = String(st.country || '').trim();
    const bitrateInfo = st.bitrate && st.bitrate > 0 ? `${st.bitrate} kbps` : '';
    const artistParts = ['پخش زنده رادیویی', country, bitrateInfo].filter(Boolean);

    out.push({
      id: `radio_${st.stationuuid || crypto.createHash('md5').update(dedupeKey).digest('hex').slice(0, 12)}`,
      title: rawName,
      artist: artistParts.join(' · '),
      artworkUrl: st.favicon && String(st.favicon).startsWith('https://') ? String(st.favicon) : undefined,
      streamUrl: wrapRadioStreamUrl(parsedUrl.href),
      isLiveStream: true,
      country: country || undefined,
      tags: String(st.tags || '').slice(0, 120) || undefined,
      source: 'radio',
      externalUrl: st.homepage && String(st.homepage).startsWith('http') ? String(st.homepage) : undefined,
    });
    if (out.length >= maxItems) break;
  }
  return out;
}

function buildFallbackMusicQueries(persianMood: string): {
  audiusQuery: string;
  archiveQuery: string;
  radioTag: string;
} {
  const m = persianMood.toLowerCase();
  if (m.includes('شجریان') || m.includes('سنتی') || m.includes('همایون')) {
    return {audiusQuery: 'shajarian', archiveQuery: 'shajarian OR santoor', radioTag: 'persian'};
  }
  if (m.includes('پاپ') || m.includes('عاشقانه') || m.includes('ملایم')) {
    return {audiusQuery: 'persian', archiveQuery: 'persian music', radioTag: 'persian'};
  }
  if (m.includes('پیانو') || m.includes('باران') || m.includes('بی‌کلام') || m.includes('رمانتیک')) {
    return {audiusQuery: 'relaxing piano instrumental', archiveQuery: 'relaxing piano', radioTag: 'ambient'};
  }
  if (m.includes('رادیو')) {
    return {audiusQuery: 'night chill lounge', archiveQuery: 'persian classical', radioTag: 'chillout'};
  }
  return {audiusQuery: 'persian chill', archiveQuery: 'persian traditional', radioTag: 'ambient'};
}

async function fetchArchiveFullTracks(query: string): Promise<ServerMusicTrack[]> {
  try {
    const searchUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(`(${query}) AND mediatype:(audio)`)}&fl[]=identifier,title,creator&sort[]=downloads+desc&rows=7&output=json`;
    const searchRes = await fetch(searchUrl, {signal: AbortSignal.timeout(5500)});
    if (!searchRes.ok) return [];
    const searchJson = (await searchRes.json()) as {
      response?: {docs?: {identifier?: string; title?: string; creator?: string | string[]}[]};
    };
    const docs = searchJson?.response?.docs ?? [];
    if (docs.length === 0) return [];

    const metaResults = await Promise.allSettled(
      docs.slice(0, 5).map(async (doc) => {
        if (!doc.identifier) return [];
        const mRes = await fetch(`https://archive.org/metadata/${encodeURIComponent(doc.identifier)}/files`, {
          signal: AbortSignal.timeout(4500),
        });
        if (!mRes.ok) return [];
        const mJson = (await mRes.json()) as {
          result?: {name?: string; format?: string; title?: string; artist?: string; length?: string}[];
        };
        const files = (mJson.result ?? []).filter((f) => {
          const name = String(f.name || '').toLowerCase();
          const secs = parseFloat(String(f.length || '0'));
          return (name.endsWith('.mp3') || name.endsWith('.ogg')) && (!Number.isFinite(secs) || secs === 0 || secs >= 60);
        });
        const tracksForDoc: ServerMusicTrack[] = [];
        for (const f of files.slice(0, 2)) {
          if (!f.name) continue;
          const secsRaw = parseFloat(String(f.length || '0'));
          const durationSec = Number.isFinite(secsRaw) && secsRaw >= 60 ? Math.round(secsRaw) : undefined;
          const cleanName = f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
          const creator = Array.isArray(doc.creator) ? doc.creator[0] : doc.creator;
          tracksForDoc.push({
            id: `archive_${doc.identifier}_${tracksForDoc.length}`,
            title: String(f.title || doc.title || cleanName),
            artist: String(f.artist || creator || 'آرشیو موسیقی'),
            streamUrl: `https://archive.org/download/${encodeURIComponent(doc.identifier)}/${f.name.split('/').map(encodeURIComponent).join('/')}`,
            durationSec,
            source: 'archive',
            externalUrl: `https://archive.org/details/${encodeURIComponent(doc.identifier)}`,
          });
        }
        return tracksForDoc;
      })
    );

    const out: ServerMusicTrack[] = [];
    for (const r of metaResults) {
      if (r.status === 'fulfilled') out.push(...r.value);
    }
    return out;
  } catch {
    return [];
  }
}

async function fetchPlayableMusicPlaylist(moodOrGenre: string, ai: GoogleGenAI | null): Promise<ServerMusicTrack[]> {
  let {audiusQuery, archiveQuery} = buildFallbackMusicQueries(moodOrGenre);

  if (ai && moodOrGenre) {
    try {
      const qRes = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: `کاربر این نام خواننده، سبک یا حال‌وهوای موسیقی را جستجو کرده است: "${moodOrGenre}".
دو عبارت جستجوی دقیق (به خط انگلیسی برای سرویس‌های موسیقی رایگان کامل مثل Audius و Internet Archive) برگردان تا فقط قطعات موسیقی کامل (بالای ۲ دقیقه، نه ایستگاه رادیویی) پیدا شوند.`,
        config: {
          thinkingConfig: {thinkingLevel: ThinkingLevel.LOW},
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              audiusQuery: {type: Type.STRING, description: 'English keywords or artist name for Audius full tracks search'},
              archiveQuery: {type: Type.STRING, description: 'English query for Archive.org full audio tracks'},
            },
            required: ['audiusQuery', 'archiveQuery'],
          },
        },
      });
      const parsed = JSON.parse((qRes.text ?? '{}').trim()) as {
        audiusQuery?: string;
        archiveQuery?: string;
      };
      if (parsed.audiusQuery?.trim()) audiusQuery = parsed.audiusQuery.trim();
      if (parsed.archiveQuery?.trim()) archiveQuery = parsed.archiveQuery.trim();
    } catch {
      // Keep smart fallback keywords
    }
  }

  const tracks: ServerMusicTrack[] = [];
  const seenIds = new Set<string>();

  // Pure music tracks ONLY (Audius + Internet Archive) — NEVER mix live radio stations into the Music playlist!
  const [audiusRes, archiveTracks] = await Promise.allSettled([
    fetch(
      `https://api.audius.co/v1/tracks/search?query=${encodeURIComponent(audiusQuery)}&limit=14&app_name=roozhaye`,
      {signal: AbortSignal.timeout(6500)}
    ).then((r) => (r.ok ? r.json() : null)),
    fetchArchiveFullTracks(archiveQuery),
  ]);

  if (audiusRes.status === 'fulfilled' && Array.isArray(audiusRes.value?.data)) {
    for (const item of audiusRes.value.data) {
      if (!item?.id || !item?.title) continue;
      const dur = typeof item.duration === 'number' ? item.duration : 0;
      if (dur > 0 && dur < 60) continue;
      const id = `audius_${item.id}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      tracks.push({
        id,
        title: String(item.title),
        artist: String(item.user?.name || item.user?.handle || 'Audius Artist'),
        artworkUrl: item.artwork?.['150x150'] || item.artwork?.['480x480'] || undefined,
        streamUrl: `https://api.audius.co/v1/tracks/${encodeURIComponent(item.id)}/stream?app_name=roozhaye`,
        durationSec: dur >= 60 ? dur : undefined,
        source: 'audius',
        externalUrl: item.permalink ? `https://audius.co${item.permalink}` : undefined,
      });
    }
  }

  if (archiveTracks.status === 'fulfilled' && Array.isArray(archiveTracks.value)) {
    for (const t of archiveTracks.value) {
      if (seenIds.has(t.id)) continue;
      seenIds.add(t.id);
      tracks.push(t);
    }
  }

  // Fallback pure music search if initial query returned too few tracks
  if (tracks.length < 3) {
    try {
      const extraRes = await fetch(
        `https://api.audius.co/v1/tracks/search?query=${encodeURIComponent('persian instrumental chill')}&limit=8&app_name=roozhaye`,
        {signal: AbortSignal.timeout(5000)}
      );
      if (extraRes.ok) {
        const extraJson = await extraRes.json();
        if (Array.isArray(extraJson?.data)) {
          for (const item of extraJson.data) {
            if (!item?.id || !item?.title) continue;
            const dur = typeof item.duration === 'number' ? item.duration : 0;
            if (dur > 0 && dur < 60) continue;
            const id = `audius_${item.id}`;
            if (seenIds.has(id)) continue;
            seenIds.add(id);
            tracks.push({
              id,
              title: String(item.title),
              artist: String(item.user?.name || item.user?.handle || 'Audius Artist'),
              artworkUrl: item.artwork?.['150x150'] || item.artwork?.['480x480'] || undefined,
              streamUrl: `https://api.audius.co/v1/tracks/${encodeURIComponent(item.id)}/stream?app_name=roozhaye`,
              durationSec: dur >= 60 ? dur : undefined,
              source: 'audius',
              externalUrl: item.permalink ? `https://audius.co${item.permalink}` : undefined,
            });
          }
        }
      }
    } catch {
      // ignore fallback search errors
    }
  }

  return tracks.slice(0, 18);
}

app.post('/api/radio-stations', async (req, res) => {
  const category = typeof req.body?.category === 'string' ? req.body.category : 'iran';
  const rawQuery = typeof req.body?.query === 'string' ? req.body.query.trim() : '';

  try {
    let tracks: ServerMusicTrack[] = [];

    if (category === 'custom' && rawQuery) {
      let enQuery = rawQuery;
      const persianDict: Record<string, string> = {
        'ایران': 'iran',
        'تهران': 'tehran',
        'شیراز': 'shiraz',
        'اصفهان': 'isfahan',
        'مشهد': 'mashhad',
        'تبریز': 'tabriz',
        'فارسی': 'persian',
        'سنتی': 'persian',
        'پاپ': 'pop',
        'پیانو': 'piano',
        'آرام': 'chillout',
        'جاز': 'jazz',
        'کلاسیک': 'classical',
        'ترکیه': 'turkey',
        'فرانسه': 'france',
        'آلمان': 'germany',
        'آمریکا': 'usa',
        'انگلیس': 'uk',
      };
      for (const [fa, en] of Object.entries(persianDict)) {
        if (rawQuery.includes(fa)) {
          enQuery = en;
          break;
        }
      }
      const ai = getAiClient();
      if (ai && /[\u0600-\u06FF]/.test(rawQuery) && enQuery === rawQuery) {
        try {
          const r = await ai.models.generateContent({
            model: 'gemini-4-hydrogen',
            contents: `Translate this Persian radio station search query into 1 or 2 crisp English keywords or station name/country for Radio Browser search (no explanation): "${rawQuery}"`,
            config: {thinkingConfig: {thinkingLevel: ThinkingLevel.LOW}},
          });
          const cand = (r.text ?? '').replace(/["'\n]/g, '').trim();
          if (cand && cand.length <= 40) enQuery = cand;
        } catch {
          // keep fallback
        }
      }

      const [byName, byTag, byCountry] = await Promise.all([
        queryRadioBrowser(`name=${encodeURIComponent(enQuery)}&limit=15&hidebroken=true&order=votes&reverse=true`),
        queryRadioBrowser(`tag=${encodeURIComponent(enQuery.toLowerCase())}&limit=15&hidebroken=true&order=votes&reverse=true`),
        queryRadioBrowser(`country=${encodeURIComponent(enQuery)}&limit=12&hidebroken=true&order=votes&reverse=true`),
      ]);
      tracks = mapRadioStationsToTracks([...byName, ...byTag, ...byCountry], 24);
    } else if (category === 'iran' || category === 'persian_music') {
      const [irStations, persianTag, persianLang] = await Promise.all([
        queryRadioBrowser('countrycode=IR&limit=25&hidebroken=true&order=votes&reverse=true'),
        queryRadioBrowser('tag=persian&limit=20&hidebroken=true&order=votes&reverse=true'),
        queryRadioBrowser('language=persian&limit=15&hidebroken=true&order=votes&reverse=true'),
      ]);
      const combined = [...irStations, ...persianTag, ...persianLang];
      const mapped = mapRadioStationsToTracks(combined, 24);
      // Merge curated Persian stations without duplicating streamUrl
      const seen = new Set(mapped.map((m) => m.streamUrl));
      const curatedToAdd = CURATED_IRAN_STATIONS.filter((c) => !seen.has(c.streamUrl));
      tracks = [...curatedToAdd, ...mapped].slice(0, 26);
    } else if (category === 'chill') {
      const [ambient, lounge, piano] = await Promise.all([
        queryRadioBrowser('tag=chillout&limit=14&hidebroken=true&order=votes&reverse=true'),
        queryRadioBrowser('tag=ambient&limit=12&hidebroken=true&order=votes&reverse=true'),
        queryRadioBrowser('tag=piano&limit=10&hidebroken=true&order=votes&reverse=true'),
      ]);
      const mapped = mapRadioStationsToTracks([...ambient, ...lounge, ...piano], 24);
      const seen = new Set(mapped.map((m) => m.streamUrl));
      tracks = [...CURATED_WORLD_CHILL_STATIONS.filter((c) => !seen.has(c.streamUrl)), ...mapped].slice(0, 26);
    } else {
      // 'world'
      const [topGlobal, classicJazz] = await Promise.all([
        queryRadioBrowser('limit=24&hidebroken=true&order=votes&reverse=true'),
        queryRadioBrowser('tag=pop&limit=12&hidebroken=true&order=clickcount&reverse=true'),
      ]);
      tracks = mapRadioStationsToTracks([...topGlobal, ...classicJazz], 26);
    }

    res.json({
      category,
      stations: tracks,
    });
  } catch (err) {
    console.error('Radio stations lookup error:', err);
    res.json({
      category,
      stations: category === 'iran' || category === 'persian_music' ? CURATED_IRAN_STATIONS : CURATED_WORLD_CHILL_STATIONS,
    });
  }
});

app.get('/api/audio-proxy', async (req, res) => {
  const target = typeof req.query?.url === 'string' ? req.query.url : '';
  const parsedUrl = isSafePublicAudioUrl(target);
  if (!parsedUrl) {
    res.status(400).json({error: 'نشانی صوتی نامعتبر است.'});
    return;
  }

  const controller = new AbortController();
  const connectTimer = setTimeout(() => controller.abort(), 12000);
  req.on('close', () => {
    clearTimeout(connectTimer);
    controller.abort();
  });

  try {
    const reqHeaders: Record<string, string> = {'User-Agent': 'RoozhayeManOZari/1.0'};
    if (typeof req.headers.range === 'string') {
      reqHeaders.Range = req.headers.range;
    }
    const upstream = await fetch(parsedUrl.href, {
      headers: reqHeaders,
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(connectTimer);

    if ((!upstream.ok && upstream.status !== 206) || !upstream.body) {
      res.status(502).json({error: 'پخش جریان صوتی در دسترس نیست.'});
      return;
    }
    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type') || 'audio/mpeg';
    res.setHeader('Content-Type', contentType);
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) res.setHeader('Content-Range', contentRange);
    res.setHeader('Accept-Ranges', upstream.headers.get('accept-ranges') || 'bytes');
    res.setHeader('Cache-Control', contentLength ? 'public, max-age=300' : 'no-store');

    const nodeStream = Readable.fromWeb(upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
    nodeStream.on('error', () => {
      if (!res.writableEnded) res.end();
    });
    nodeStream.pipe(res);
  } catch (err) {
    clearTimeout(connectTimer);
    if ((err as {name?: string})?.name !== 'AbortError') {
      console.warn('Audio proxy error:', err instanceof Error ? err.message : err);
    }
    if (!res.headersSent) {
      res.status(502).json({error: 'خطا در دریافت جریان صوتی.'});
    }
  }
});

app.post('/api/night-discover', async (req, res) => {
  const ai = getAiClient();
  const betaAi = getTtsAiClient();
  const mode = req.body?.mode === 'music' ? 'music' : 'movies';
  const moodOrGenre = typeof req.body?.moodOrGenre === 'string' ? req.body.moodOrGenre.trim() : '';
  const mediaType = typeof req.body?.mediaType === 'string' ? req.body.mediaType : 'both';

  if (mode === 'music') {
    try {
      const tracks = await fetchPlayableMusicPlaylist(moodOrGenre || 'پیانو و موسیقی آرامش‌بخش ایرانی', ai ?? betaAi);
      const links = tracks
        .filter((t) => t.externalUrl)
        .slice(0, 6)
        .map((t) => ({title: `${t.title} — ${t.artist}`, url: t.externalUrl!}));

      const summaryList = tracks
        .slice(0, 5)
        .map((t, i) => `${i + 1}. ${t.title} اثر ${t.artist}`)
        .join('، ');

      res.json({
        mode: 'music',
        title: `پلی‌لیست آماده پخش: ${moodOrGenre || 'آرامش شبانه'}`,
        markdownText:
          tracks.length > 0
            ? `${tracks.length} قطعه و ایستگاه آماده پخش پیدا شد. روی هر آهنگ بزنید تا مستقیماً پخش شود.`
            : 'قطعه‌ای برای این عبارت پیدا نشد؛ عبارت دیگری (مثل شجریان، پیانو، یا آرامش) را امتحان کنید.',
        spokenSummary: summaryList
          ? `پلی‌لیست امشب شامل ${summaryList}`
          : 'پلی‌لیست موسیقی آماده است.',
        tracks,
        links,
        fetchedAt: Date.now(),
      });
      return;
    } catch (err) {
      console.error('Music playlist discovery failed:', err);
      res.status(500).json({error: 'خطا در جستجوی پلی‌لیست موسیقی.'});
      return;
    }
  }

  if (!ai && !betaAi) {
    res.status(503).json({
      error: 'برای جستجوی آنلاین شبانه به اتصال اینترنت نیاز است.',
      offlineFallback: true,
    });
    return;
  }

  try {
    const prompt = `۴ ${mediaType === 'series' ? 'سریال' : mediaType === 'movie' ? 'فیلم سینمایی' : 'فیلم سینمایی و سریال'} مطرح یا جدید با امتیاز IMDb بالا (ترجیحاً بالای ۷.۵) که **دوبله فارسی** رسمی یا حرفه‌ای آن در پلتفرم‌های معتبر یا سایت‌های فیلم موجود است را پیدا و معرفی کن${moodOrGenre ? ` در ژانر یا حال‌وهوای: ${moodOrGenre}` : ' (مناسب تماشای شبانه دو نفره، جذاب و خوش‌ساخت)'}.
برای هر مورد دقیقاً ذکر کن:
- نام فارسی و نام انگلیسی + سال انتشار
- امتیاز IMDb و وضعیت دوبله فارسی
- خلاصه داستان کوتاه و جذاب (بدون لو دادن پایان) و دلیل پیشنهاد امشب.`;

    let response;
    const groundedClient = betaAi ?? ai!;
    try {
      response = await groundedClient.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: prompt,
        config: {
          systemInstruction:
            'پاسخ را کاملاً به فارسی روان، منظم و خوانا بنویس. با جستجوی وب فقط موارد واقعی و معتبر را معرفی کن.',
          tools: [{googleSearch: {}}],
        },
      });
    } catch (groundingErr) {
      console.warn(
        'Night discover googleSearch failed, falling back to direct model response:',
        groundingErr instanceof Error ? groundingErr.message : groundingErr,
      );
      const fallbackClient = ai ?? betaAi!;
      response = await fallbackClient.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: prompt,
        config: {
          systemInstruction:
            'پاسخ را کاملاً به فارسی روان، منظم و خوانا بنویس. فقط آثار واقعی و شناخته‌شده با امتیاز واقعی IMDb و دوبله فارسی معروف را معرفی کن.',
        },
      });
    }

    const markdownText = (response.text ?? '').trim();
    const rawChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    const seen = new Set<string>();
    const links: {title: string; url: string}[] = [];
    for (const chunk of rawChunks) {
      const uri = chunk?.web?.uri;
      if (uri && !seen.has(uri)) {
        seen.add(uri);
        links.push({
          title: chunk?.web?.title || uri,
          url: uri,
        });
      }
    }

    const plainLines = markdownText
      .replace(/[#*_`>[\]()]/g, ' ')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const spokenSummary =
      plainLines.length > 520 ? `${plainLines.slice(0, 520)}...` : plainLines;

    res.json({
      mode,
      title: 'پیشنهاد فیلم و سریال دوبله امتیاز بالا برای امشب',
      markdownText,
      spokenSummary,
      links: links.slice(0, 8),
      fetchedAt: Date.now(),
    });
  } catch (err) {
    console.error('Night discover failed:', err);
    res.status(500).json({error: 'خطا در جستجوی آنلاین شبانه.'});
  }
});


app.post('/api/assistant-chat', async (req, res) => {
  const ai = getAiClient();
  if (!ai) {
    res.status(503).json({error: 'موتور گفت‌وگوی آنلاین در دسترس نیست.'});
    return;
  }

  const assistantName = typeof req.body?.assistantName === 'string' ? req.body.assistantName.slice(0, 40) : 'هم‌صدا';
  const selfName = typeof req.body?.selfName === 'string' ? req.body.selfName.slice(0, 60) : 'دوست من';
  const partnerName = typeof req.body?.partnerName === 'string' ? req.body.partnerName.slice(0, 60) : '';
  const userMessage = typeof req.body?.userMessage === 'string' ? req.body.userMessage.trim().slice(0, 4000) : '';
  const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];
  const history = rawHistory
    .filter((item: {role?: string; text?: string}) =>
      (item?.role === 'user' || item?.role === 'assistant') &&
      typeof item?.text === 'string' && item.text.trim()
    )
    .slice(-12)
    .map((item: {role: 'user' | 'assistant'; text: string}) => ({
      role: item.role === 'assistant' ? 'model' : 'user',
      parts: [{text: item.text.slice(0, 2000)}],
    }));

  if (!userMessage) {
    res.status(400).json({error: 'پیام خالی است.'});
    return;
  }

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: [
        ...history,
        {role: 'user', parts: [{text: userMessage}]},
      ],
      config: {
        systemInstruction: `تو مغز گفت‌وگوی «${assistantName}» هستی؛ یک همراه فارسی‌زبان صمیمی، باهوش، دقیق و طبیعی برای ${selfName}${partnerName ? ` و خانواده‌اش، از جمله ${partnerName}` : ''}.
قواعد:
- فارسی محاوره‌ای روان و طبیعی بنویس؛ نه لحن اداری، نه جمله‌های رباتی و کلیشه‌ای.
- سابقه همین مکالمه را واقعاً دنبال کن؛ اگر کاربر به «این»، «اون»، «همون» یا حرف قبلی اشاره کرد، از تاریخچه برای فهم منظور استفاده کن.
- پاسخ را متناسب با سؤال بده؛ برای سؤال ساده کوتاه و برای موضوع پیچیده با توضیح کافی.
- اگر چیزی را نمی‌دانی، صادقانه بگو و اطلاعات یا خاطره‌ای جعل نکن.
- تو فقط موتور گفت‌وگویی هستی و به‌تنهایی هیچ تماس، پیام، خرید یا تغییر تنظیمات گوشی را اجرا نمی‌کنی. هر درخواست اجرایی باید به مسیریاب فرمان برنامه سپرده شود؛ هرگز ادعا نکن کاری انجام شده است.
- پاسخ را بدون عنوان و قالب JSON، فقط به صورت متن فارسی برگردان.`,
        thinkingConfig: {thinkingLevel: ThinkingLevel.LOW},
      },
    });

    const replyText = (response.text || '').trim();
    if (!replyText) {
      res.status(502).json({error: 'پاسخ خالی از موتور گفت‌وگو دریافت شد.'});
      return;
    }
    res.json({replyText});
  } catch (err) {
    console.error('Assistant conversation engine failed:', err);
    res.status(500).json({error: 'موتور گفت‌وگو نتوانست پاسخ بسازد.'});
  }
});

app.post('/api/assistant-command', async (req, res) => {
  const utterance = typeof req.body?.utterance === 'string' ? req.body.utterance.trim() : '';
  if (!utterance) {
    res.status(400).json({error: 'دستور یا سوالی دریافت نشد.'});
    return;
  }

  const assistantName =
    typeof req.body?.assistantName === 'string' && req.body.assistantName.trim()
      ? req.body.assistantName.trim()
      : 'آوا';
  const deviceOwner = req.body?.deviceOwner === 'zari' ? 'zari' : 'man';
  const myName = typeof req.body?.myName === 'string' && req.body.myName.trim() ? req.body.myName.trim() : 'بهمن';
  const partnerName =
    typeof req.body?.partnerName === 'string' && req.body.partnerName.trim() ? req.body.partnerName.trim() : 'زری';
  const ownerSelf = deviceOwner === 'zari' ? partnerName : myName;
  const partnerOther = deviceOwner === 'zari' ? myName : partnerName;

  const localTimeText = typeof req.body?.localTimeText === 'string' ? req.body.localTimeText.trim() : '';
  const jalaliDate = typeof req.body?.jalaliDate === 'string' ? req.body.jalaliDate.trim() : '';
  const rawContacts = Array.isArray(req.body?.contacts) ? (req.body.contacts as {name?: string; phone?: string; persianPhonetic?: string}[]) : [];
  const compactContacts = rawContacts
    .filter((c) => c && typeof c.name === 'string' && c.name.trim())
    .slice(0, 80)
    .map((c) => ({
      name: String(c.name).trim(),
      phone: String(c.phone || '').trim(),
      phonetic: String(c.persianPhonetic || '').trim(),
    }));

  const ai = getAiClient();
  if (!ai) {
    res.status(503).json({
      error: 'سرویس هوشمند آنلاین موقتاً در دسترس نیست؛ دستورات آفلاین همچنان فعالند.',
      offlineFallback: true,
    });
    return;
  }

  try {
    const prompt = `تو «${assistantName}» دستیار صوتی شخصی و همه‌کاره روی گوشی «${ownerSelf}» هستی (همراه زندگی او: «${partnerOther}»).
زمان فعلی گوشی: ${localTimeText || 'نامشخص'} — تاریخ امروز: ${jalaliDate || 'امروز'}.
مخاطبین دفترچه تلفن برای تطبیق نام و شماره:
${JSON.stringify(compactContacts)}

درخواست ${ownerSelf}:
"${utterance}"

وظیفه:
۱. تشخیص بده کدام action دقیقاً اجرا شود:
- web_search: جستجوی زنده در اینترنت، اخبار روز، قیمت ارز/طلا/خودرو، آب‌وهوا، دستور پخت، آموزش، پیدا کردن سایت یا منبع دانلود و هر اطلاعات جدید اینترنتی (query را بنویس).
- download_url: وقتی کاربر لینک مستقیم دانلود می‌خواهد یا آدرس دانلود داده (اگر آدرس https:// مشخص نیست، query را بنویس تا با جستجوی اینترنتی لینک پیدا شود؛ اگر آدرس مشخص است در downloadUrl بگذار).
- open_url: باز کردن مستقیم یک سایت یا آدرس اینترنتی در مرورگر گوشی (آدرس کامل در downloadUrl یا query).
- open_app: باز کردن هر برنامه نصب‌شده روی گوشی مثل تلگرام، واتساپ، اینستاگرام، نشان، بلد، گوگل مپ، روبیکا، ایتا، اسنپ، ماشین حساب، تنظیمات، کروم، یوتیوب، گالری و... (نام برنامه در targetName).
- open_navigation: مسیریابی و باز کردن نقشه تا یک مکان یا آدرس (نام مقصد در query).
- flashlight_on / flashlight_off: روشن یا خاموش کردن چراغ قوه گوشی.
- open_wifi_settings / open_bluetooth_settings / open_mobile_data_settings / open_location_settings: باز کردن پنل سریع وای‌فای، اینترنت همراه، بلوتوث یا GPS.
- set_alarm / set_timer: تنظیم ساعت بیدارباش (alarmHour, alarmMinute با فرمت ۲۴ ساعته، عنوان در goalTitle) یا تایمر (timerMinutes به دقیقه).
- brightness_up / brightness_down / brightness_max / brightness_min: کم و زیاد کردن نور صفحه نمایش.
- tell_time: پرسیدن ساعت یا تاریخ امروز.
- ask_sms_body: درخواست ارسال پیامک به یک شخص وقتی متن پیامک هنوز گفته نشده.
- send_sms: ارسال پیامک وقتی هم مخاطب و هم متن پیام هر دو مشخص هستند (smsBody پر شود).
- make_call / end_call: برقراری تماس یا قطع تماس تلفنی.
- volume_up / volume_down / volume_max / volume_mute: تنظیم بلندی صدا.
- ringer_silent / ringer_vibrate / ringer_normal: گذاشتن گوشی روی سایلنت، ویبره یا حالت عادی.
- take_photo / record_video: باز کردن دوربین عکس یا فیلم‌برداری.
- record_audio_start / record_audio_stop: شروع یا توقف ضبط صدا.
- play_radio / play_music / stop_audio: پخش رادیو زنده، موزیک شبانه یا توقف پخش.
- open_tab: باز کردن یکی از بخش‌های برنامه (tab: today | assistant | gratitude | night | voice | caller | sync).
- add_goal: افزودن یک هدف/یادآور جدید به لیست امروز (goalTitle پر شود).
- answer: گفت‌وگو، مشورت یا پرسش عمومی. اگر پاسخ به اطلاعات به‌روز اینترنتی نیاز دارد needsLiveWeb را true کن.

۲. اگر در مخاطبین اسم مشابه یا هم‌آوا پیدا شد، دقیق‌ترین targetName و targetPhone را پر کن؛ اگر تطبیق مبهم است، مخاطب را حدس نزن و سؤال روشن‌کننده بپرس.
۳. اگر کاربر نام برنامه «تلگرام» را گفت و درخواست پیام دادن داشت، هرگز آن را به پیامک تبدیل نکن؛ action را open_app با targetName «تلگرام» قرار بده و توضیح بده ارسال پیام تلگرام باید داخل خود برنامه انجام شود.
۴. هرگز ادعا نکن پیام ارسال شده است؛ ارسال پیامک نیازمند تأیید صریح کاربر در مرحله بعدی است.
۵. replyText را به فارسی محاوره‌ای بسیار گرم و کوتاه (۱ تا ۲ جمله برای خواندن با صدای بلند) بنویس.`;

    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: prompt,
      config: {
        thinkingConfig: {thinkingLevel: ThinkingLevel.LOW},
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            action: {
              type: Type.STRING,
              enum: [
                'answer',
                'web_search',
                'download_url',
                'open_url',
                'open_app',
                'open_navigation',
                'flashlight_on',
                'flashlight_off',
                'open_wifi_settings',
                'open_bluetooth_settings',
                'open_mobile_data_settings',
                'open_location_settings',
                'set_alarm',
                'set_timer',
                'brightness_up',
                'brightness_down',
                'brightness_max',
                'brightness_min',
                'tell_time',
                'ask_sms_body',
                'send_sms',
                'make_call',
                'end_call',
                'volume_up',
                'volume_down',
                'volume_max',
                'volume_mute',
                'ringer_silent',
                'ringer_vibrate',
                'ringer_normal',
                'take_photo',
                'record_video',
                'record_audio_start',
                'record_audio_stop',
                'open_tab',
                'play_radio',
                'play_music',
                'stop_audio',
                'add_goal',
                'add_gratitude',
              ],
            },
            replyText: {type: Type.STRING, description: 'Short warm spoken Persian reply for TTS'},
            needsLiveWeb: {type: Type.BOOLEAN, description: 'True if real-time web lookup improves the answer'},
            targetName: {type: Type.STRING, description: 'Matched contact name or app name'},
            targetPhone: {type: Type.STRING, description: 'Matched phone number if call/SMS'},
            smsBody: {type: Type.STRING, description: 'SMS body text if already spoken'},
            tab: {type: Type.STRING, description: 'Target app tab id if open_tab'},
            query: {type: Type.STRING, description: 'Search, music, radio, or navigation query'},
            goalTitle: {type: Type.STRING, description: 'Goal text or alarm label'},
            downloadUrl: {type: Type.STRING, description: 'Explicit https URL if user gave one or website domain'},
            downloadTitle: {type: Type.STRING, description: 'Short file/page title'},
            alarmHour: {type: Type.INTEGER, description: 'Alarm hour 0-23 if set_alarm'},
            alarmMinute: {type: Type.INTEGER, description: 'Alarm minute 0-59 if set_alarm'},
            timerMinutes: {type: Type.INTEGER, description: 'Timer duration in minutes if set_timer'},
          },
          required: ['action', 'replyText'],
        },
      },
    });

    const parsed = JSON.parse((response.text ?? '{}').trim()) as {
      action?: string;
      replyText?: string;
      needsLiveWeb?: boolean;
      targetName?: string;
      targetPhone?: string;
      smsBody?: string;
      tab?: string;
      query?: string;
      goalTitle?: string;
      downloadUrl?: string;
      downloadTitle?: string;
      alarmHour?: number;
      alarmMinute?: number;
      timerMinutes?: number;
      links?: {title: string; url: string}[];
    };

    const action = parsed.action || 'answer';
    const shouldSearchWeb =
      action === 'web_search' ||
      (action === 'download_url' && !parsed.downloadUrl) ||
      (action === 'answer' && Boolean(parsed.needsLiveWeb));

    if (shouldSearchWeb) {
      const searchClient = getTtsAiClient() ?? ai;
      try {
        const searchPrompt =
          action === 'download_url'
            ? `کاربر (${ownerSelf}) این مورد را برای پیدا کردن صفحه معتبر دانلود در اینترنت خواسته است: "${parsed.query || utterance}".
به فارسی کوتاه و شفاف نتیجه را بگو و منابع/صفحات معتبر وب را پیدا کن تا لینک آن‌ها به کاربر نمایش داده شود.`
            : `به درخواست «${ownerSelf}» با استفاده از جستجوی زنده گوگل به فارسی بسیار روان، دقیق و خلاصه (در ۲ تا ۴ جمله مناسب خواندن صوتی) پاسخ بده:
"${parsed.query || utterance}"`;

        const webRes = await searchClient.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: searchPrompt,
          config: {
            systemInstruction:
              'پاسخ را کوتاه، دقیق و به فارسی روان بنویس تا هم خواندنی باشد و هم با صدای بلند دلنشین پخش شود. اطلاعات به‌روز اینترنتی را از جستجوی گوگل بگیر.',
            tools: [{googleSearch: {}}],
          },
        });

        const webText = (webRes.text ?? '').replace(/[#*_`]/g, '').trim();
        const rawChunks = webRes.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
        const links: {title: string; url: string}[] = [];
        const seenUrls = new Set<string>();

        for (const ch of rawChunks) {
          const uri = ch?.web?.uri;
          if (uri && (uri.startsWith('https://') || uri.startsWith('http://')) && !seenUrls.has(uri)) {
            seenUrls.add(uri);
            links.push({
              title: (ch?.web?.title || uri).slice(0, 70),
              url: uri,
            });
          }
          if (links.length >= 6) break;
        }

        if (webText) {
          parsed.replyText = webText;
        }
        if (links.length > 0) {
          parsed.links = links;
          if (action === 'download_url' && !parsed.downloadUrl) {
            parsed.downloadUrl = links[0].url;
            parsed.downloadTitle = links[0].title;
          }
        }
      } catch (searchErr) {
        console.warn('Live web search grounding fallback:', searchErr instanceof Error ? searchErr.message : searchErr);
      }
    }

    if (action === 'open_url' && !parsed.downloadUrl && parsed.query) {
      const q = parsed.query.trim();
      parsed.downloadUrl = q.startsWith('http') ? q : `https://www.google.com/search?q=${encodeURIComponent(q)}`;
    }

    res.json(parsed);
  } catch (err) {
    console.error('Assistant command AI error:', err);
    res.status(500).json({error: 'خطا در پردازش دستور صوتی.'});
  }
});

app.all('/api/*', (_req, res) => {
  res.status(404).json({error: 'مسیر API یافت نشد.'});
});

async function startServer() {
  const PORT = Number(process.env.PORT) || 3000;
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const {createServer: createViteServer} = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        ws: false,
      },
      appType: 'spa',
    });
    app.get('/@vite/client', async (_req, res, next) => {
      try {
        const result = await vite.transformRequest('/@vite/client');
        if (!result) return next();
        const patched = result.code.replace(
          /const transport = normalizeModuleRunnerTransport\(\(\(\) => \{[\s\S]*?\}\)\(\)\);/,
          'const transport = normalizeModuleRunnerTransport({ connect() {}, disconnect() {}, send() {} });'
        );
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(patched);
      } catch (e) {
        next(e);
      }
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      const indexFile = path.join(distPath, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build not found');
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Roozhaye Man o Zari server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();

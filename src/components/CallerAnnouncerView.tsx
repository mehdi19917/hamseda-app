import React, {useMemo, useRef, useState} from 'react';
import {
  BookUser,
  CheckCircle2,
  Download,
  Loader2,
  MessageSquare,
  Phone,
  PhoneIncoming,
  PhoneOff,
  Plus,
  RefreshCw,
  Search,
  Smartphone,
  Sparkles,
  Trash2,
  Upload,
  UserPlus,
  Volume2,
} from 'lucide-react';
import {toPersianDigits, VOICE_PERSONAS} from '../data/persianLibrary';
import {apiUrl, safeReadJsonResponse} from '../services/apiConfig';
import {
  buildCallerRingtoneWav,
  getAudioClipBuffer,
  hashTextKey,
} from '../services/audioLibraryDb';
import {
  getVoiceGender,
  isNativeAndroid,
  precacheNativeWav,
  readDeviceContactsNative,
  saveLearnedPhoneticsNative,
  testNativeCallAnnouncement,
  testNativeSmsAnnouncement,
} from '../services/nativeAndroidBridge';
import {
  generateAndCacheGeminiWav,
  playSoftChime,
  speakFluentPersian,
  stopAllSpeech,
  unlockAudioPlayback,
} from '../services/speechEngine';
import type {AppSettings, CallerContact, DeviceOwner, SyncedPhoneContact, VoiceName} from '../types/app';
import {getPartnerNameForDevice} from '../utils/deviceIdentity';

interface CallerAnnouncerViewProps {
  callers: CallerContact[];
  syncedContacts: SyncedPhoneContact[];
  isOnline: boolean;
  defaultVoice: VoiceName;
  speechRate: number;
  announceCalls: boolean;
  announceSms: boolean;
  settings: AppSettings;
  deviceOwner: DeviceOwner;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  onAddCaller: (caller: Omit<CallerContact, 'id'>) => void;
  onDeleteCaller: (id: string) => void;
  onSaveSyncedContacts: (contacts: SyncedPhoneContact[]) => void;
  onRefreshClips: () => Promise<void>;
  onStatusToast: (msg: string) => void;
}

const LOCAL_FINGLISH_WORDS: Record<string, string> = {
  bahman: 'بَهمن',
  mousaali: 'موساعلی',
  musaali: 'موساعلی',
  zari: 'زَری',
  zahra: 'زهرا',
  mehdi: 'مهدی',
  mohammad: 'محمد',
  ali: 'علی',
  reza: 'رضا',
  hossein: 'حسین',
  sara: 'سارا',
  maryam: 'مریم',
  mina: 'مینا',
  amir: 'امیر',
  saeed: 'سعید',
  omid: 'امید',
  mom: 'مامان',
  maman: 'مامان',
  baba: 'بابا',
  dad: 'پدر',
  khanoom: 'خانم',
  agha: 'آقا',
  jan: 'جان',
  joon: 'جون',
  dr: 'دکتر',
  mr: 'آقای',
  mrs: 'خانم',
  ms: 'خانم',
};

function localFinglishToPersian(input: string): string {
  if (!/[A-Za-z]/.test(input)) return input;
  return input
    .replace(/[A-Za-z]+/g, (word) => {
      const lower = word.toLowerCase();
      if (LOCAL_FINGLISH_WORDS[lower]) return LOCAL_FINGLISH_WORDS[lower];
      let s = lower
        .replace(/sh/g, 'ش')
        .replace(/ch/g, 'چ')
        .replace(/kh/g, 'خ')
        .replace(/gh/g, 'ق')
        .replace(/zh/g, 'ژ')
        .replace(/ph/g, 'ف')
        .replace(/oo|ou/g, 'او')
        .replace(/ee|ea/g, 'ای')
        .replace(/ai|ay|ei|ey/g, 'اِی');
      const map: Record<string, string> = {
        a: 'آ', b: 'ب', c: 'ک', d: 'د', e: 'ِ', f: 'ف', g: 'گ', h: 'ه',
        i: 'ی', j: 'ج', k: 'ک', l: 'ل', m: 'م', n: 'ن', o: 'و', p: 'پ',
        q: 'ق', r: 'ر', s: 'س', t: 'ت', u: 'و', v: 'و', w: 'و', x: 'کس',
        y: 'ی', z: 'ز',
      };
      let out = '';
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        out += map[ch] ?? ch;
      }
      return out || word;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeQuotedPrintableUtf8(str: string): string {
  try {
    const cleaned = str.replace(/=\r?\n/g, '');
    const bytes: number[] = [];
    for (let i = 0; i < cleaned.length; i++) {
      if (cleaned[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(cleaned.slice(i + 1, i + 3))) {
        bytes.push(parseInt(cleaned.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        bytes.push(cleaned.charCodeAt(i));
      }
    }
    return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
  } catch {
    return str;
  }
}

function parseVcfContacts(vcfText: string): SyncedPhoneContact[] {
  const unfolded = vcfText.replace(/\r?\n[ \t]/g, '');
  const cards = unfolded.split(/BEGIN:VCARD/i);
  const out: SyncedPhoneContact[] = [];
  const seenPhones = new Set<string>();

  for (const card of cards) {
    if (!/END:VCARD/i.test(card)) continue;
    const lines = card.split(/\r?\n/);
    let rawName = '';
    let fallbackN = '';
    let firstPhone = '';

    for (const line of lines) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const keyPart = line.slice(0, colonIdx).toUpperCase();
      let valPart = line.slice(colonIdx + 1).trim();
      if (!valPart) continue;
      if (keyPart.includes('ENCODING=QUOTED-PRINTABLE')) {
        valPart = decodeQuotedPrintableUtf8(valPart);
      }

      if (keyPart === 'FN' || keyPart.startsWith('FN;')) {
        rawName = valPart;
      } else if ((keyPart === 'N' || keyPart.startsWith('N;')) && !fallbackN) {
        const parts = valPart.split(';').map((p) => p.trim()).filter(Boolean);
        fallbackN = parts.reverse().join(' ').trim();
      } else if ((keyPart === 'TEL' || keyPart.startsWith('TEL;')) && !firstPhone) {
        firstPhone = valPart;
      }
    }

    const displayName = (rawName || fallbackN).trim();
    if (!displayName) continue;
    const digits = firstPhone.replace(/[^\d+]/g, '');
    const key = digits ? digits.slice(-10) : displayName.toLowerCase();
    if (seenPhones.has(key)) continue;
    seenPhones.add(key);

    out.push({
      name: displayName,
      phone: firstPhone,
      persianPhonetic: localFinglishToPersian(displayName),
    });
  }
  return out;
}

const TEMPLATES = [
  'تماس ورودی از طرف {name}',
  '{name} زنگ می‌زند، لطفاً پاسخ دهید',
  'توجه: تماس مهم از طرف {name}',
  'Incoming call from {name}',
  'تماس از طرف {name}. Incoming call from {name}.',
];

export const CallerAnnouncerView: React.FC<CallerAnnouncerViewProps> = ({
  callers,
  syncedContacts,
  isOnline,
  defaultVoice,
  speechRate,
  announceCalls,
  announceSms,
  settings,
  deviceOwner,
  onUpdateSettings,
  onAddCaller,
  onDeleteCaller,
  onSaveSyncedContacts,
  onRefreshClips,
  onStatusToast,
}) => {
  const partnerOther = getPartnerNameForDevice(settings, deviceOwner);
  // Quick Bilingual Tester
  const [testName, setTestName] = useState(
    deviceOwner === 'zari' ? 'Bahman جان · همسر' : 'Zari جان · مدیر پروژه'
  );
  const [testTemplate, setTestTemplate] = useState(TEMPLATES[0]);
  const [testVoice, setTestVoice] = useState<VoiceName>(defaultVoice);
  const [phoneticPreview, setPhoneticPreview] = useState<string>('');
  const [isTesting, setIsTesting] = useState(false);

  // SMS Announcer Simulator
  const [smsSender, setSmsSender] = useState(`${partnerOther} جان`);
  const [smsBody, setSmsBody] = useState('سلام عزیزم، سر راهم نون و میوه گرفتم.');
  const [smsTesting, setSmsTesting] = useState(false);

  // Add Contact Form
  const [name, setName] = useState('');
  const [relation, setRelation] = useState('');
  const [persianPhonetic, setPersianPhonetic] = useState('');
  const [template, setTemplate] = useState(TEMPLATES[0]);
  const [repeatCount, setRepeatCount] = useState<1 | 2>(2);
  const [chimeStyle, setChimeStyle] = useState<'gentle' | 'classic' | 'chime'>('chime');
  const [voiceName, setVoiceName] = useState<VoiceName>(defaultVoice);

  // Active Incoming Call Simulator Modal & Busy States
  const [simulatingCaller, setSimulatingCaller] = useState<CallerContact | null>(null);
  const [busyCallerId, setBusyCallerId] = useState<string | null>(null);
  const [precacheBusy, setPrecacheBusy] = useState(false);

  // Phonebook Sync State
  const [syncingPhonebook, setSyncingPhonebook] = useState(false);
  const [precachePhonebookBusy, setPrecachePhonebookBusy] = useState(false);
  const [contactSearch, setContactSearch] = useState('');
  const vcfInputRef = useRef<HTMLInputElement | null>(null);

  const filteredSyncedContacts = useMemo(() => {
    const q = contactSearch.trim().toLowerCase();
    if (!q) return syncedContacts;
    return syncedContacts.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.persianPhonetic.toLowerCase().includes(q) ||
        c.phone.toLowerCase().includes(q)
    );
  }, [syncedContacts, contactSearch]);

  const enrichAndPersistPhonebook = async (incomingList: SyncedPhoneContact[]) => {
    if (incomingList.length === 0) {
      onStatusToast('مخاطبی در دفترچه پیدا نشد.');
      return;
    }

    // Preserve manual phonetic refinements already customized for matching names
    const existingMap = new Map<string, string>();
    for (const prev of syncedContacts) {
      if (prev.name.trim() && prev.persianPhonetic.trim()) {
        existingMap.set(prev.name.trim().toLowerCase(), prev.persianPhonetic.trim());
      }
    }

    let learnedMap: Record<string, string> = {};
    const uniqueNames = Array.from(new Set(incomingList.map((c) => c.name.trim()).filter(Boolean)));
    const latinNames = uniqueNames.filter((n) => /[A-Za-z]/.test(n));

    if (isOnline && latinNames.length > 0) {
      for (let i = 0; i < latinNames.length; i += 80) {
        const chunk = latinNames.slice(i, i + 80);
        try {
          const res = await fetch(apiUrl('/api/batch-phonetic'), {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({names: chunk}),
          });
          if (res.ok) {
            const parsed = await safeReadJsonResponse<{phonetics?: Record<string, string>}>(res);
            if (!parsed.isHtml && parsed.data?.phonetics) {
              learnedMap = {...learnedMap, ...parsed.data.phonetics};
            }
          }
        } catch {
          // fallback to deterministic transliteration
        }
      }
    }

    const enriched: SyncedPhoneContact[] = incomingList.map((c) => {
      const lower = c.name.trim().toLowerCase();
      const chosenPhonetic =
        learnedMap[lower] ||
        existingMap.get(lower) ||
        c.persianPhonetic ||
        localFinglishToPersian(c.name);
      return {
        name: c.name.trim(),
        phone: c.phone.trim(),
        persianPhonetic: chosenPhonetic,
      };
    });

    onSaveSyncedContacts(enriched);

    const pushMap: Record<string, string> = {};
    for (const c of enriched) {
      pushMap[c.name.toLowerCase()] = c.persianPhonetic;
    }
    await saveLearnedPhoneticsNative(pushMap);

    const latinLearnedCount = enriched.filter((c) => /[A-Za-z]/.test(c.name)).length;
    onStatusToast(
      `${toPersianDigits(enriched.length)} مخاطب همگام‌سازی و تلفظ فارسی ${toPersianDigits(latinLearnedCount)} نام لاتین برای اعلام آفلاین بدون فیلترشکن یادگیری شد.`
    );
  };

  const handleSyncPhonebook = async () => {
    setSyncingPhonebook(true);
    try {
      if (isNativeAndroid()) {
        const res = await readDeviceContactsNative();
        if (!res.ok) {
          if (res.permissionRequired) {
            onStatusToast('لطفاً مجوز دسترسی به مخاطبین (Contacts) را تایید کنید و دوباره دکمه همگام‌سازی را بزنید.');
          } else {
            onStatusToast(res.error || 'خطا در خواندن دفترچه تلفن گوشی.');
          }
          return;
        }
        await enrichAndPersistPhonebook(res.contacts);
        return;
      }

      // Browser fallback: Web Contact Picker API if supported, otherwise open .vcf picker
      const navWithContacts = navigator as Navigator & {
        contacts?: {
          select: (props: string[], opts?: {multiple?: boolean}) => Promise<{name?: string[]; tel?: string[]}[]>;
        };
      };
      if (navWithContacts.contacts?.select) {
        const picked = await navWithContacts.contacts.select(['name', 'tel'], {multiple: true});
        const mapped: SyncedPhoneContact[] = picked
          .filter((p) => p.name?.[0])
          .map((p) => ({
            name: String(p.name![0]).trim(),
            phone: String(p.tel?.[0] || '').trim(),
            persianPhonetic: localFinglishToPersian(String(p.name![0])),
          }));
        if (mapped.length > 0) {
          await enrichAndPersistPhonebook(mapped);
          return;
        }
      }

      vcfInputRef.current?.click();
    } finally {
      setSyncingPhonebook(false);
    }
  };

  const handleVcfFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setSyncingPhonebook(true);
    try {
      const text = await file.text();
      const parsed = parseVcfContacts(text);
      if (parsed.length === 0) {
        onStatusToast('مخاطب معتبری در فایل .vcf انتخاب‌شده پیدا نشد.');
        return;
      }
      await enrichAndPersistPhonebook(parsed);
    } catch {
      onStatusToast('خطا در خواندن فایل مخاطبین.');
    } finally {
      setSyncingPhonebook(false);
    }
  };

  const handleUpdateSyncedPhonetic = (indexInFullList: number, newPhonetic: string) => {
    const updated = syncedContacts.map((item, i) =>
      i === indexInFullList ? {...item, persianPhonetic: newPhonetic} : item
    );
    onSaveSyncedContacts(updated);
  };

  const handlePromoteToVip = (c: SyncedPhoneContact) => {
    const alreadyExists = callers.some((x) => x.name.toLowerCase() === c.name.toLowerCase());
    if (alreadyExists) {
      onStatusToast(`«${c.name}» از قبل در لیست VIP وجود دارد.`);
      return;
    }
    onAddCaller({
      name: c.name,
      latinAlias: /[A-Za-z]/.test(c.name) ? c.name : undefined,
      persianPhonetic: c.persianPhonetic || c.name,
      relation: 'دفترچه تلفن',
      template: TEMPLATES[0],
      repeatCount: 2,
      chimeStyle: 'chime',
      voiceName: defaultVoice,
      favorite: true,
    });
    onStatusToast(`«${c.name}» با تلفظ «${c.persianPhonetic}» به مخاطبین VIP اضافه شد.`);
  };

  const handlePrecacheSyncedContacts = async () => {
    if (syncedContacts.length === 0) return;
    if (!isOnline) {
      onStatusToast('برای ساخت فایل صوتی آفلاین گوینده، یک‌بار اتصال اینترنت و فیلترشکن لازم است.');
      return;
    }
    setPrecachePhonebookBusy(true);
    const slice = syncedContacts.slice(0, 50);
    let readyCount = 0;
    try {
      for (const c of slice) {
        const spokenName = c.persianPhonetic.trim() || c.name;
        const script = `تماس ورودی از طرف ${spokenName}`;
        const clipId = hashTextKey(script, defaultVoice);
        let buffer = await getAudioClipBuffer(clipId);
        if (!buffer) {
          const res = await generateAndCacheGeminiWav({
            clipId,
            text: script,
            title: `تماس: ${c.name}`,
            category: 'caller',
            voiceName: defaultVoice,
            style: 'Clear fluent Tehran Persian caller announcer.',
          });
          if ('buffer' in res) buffer = res.buffer;
          await new Promise((r) => setTimeout(r, 450));
        }
        if (buffer && isNativeAndroid()) {
          await precacheNativeWav(script, defaultVoice, buffer);
          // Also cache variant keyed by original Latin name so incoming call hits offline WAV immediately
          await precacheNativeWav(`تماس ورودی از طرف ${c.name}`, defaultVoice, buffer);
        }
        if (buffer) readyCount++;
      }
      await onRefreshClips();
      onStatusToast(
        `صدای استودیویی ${toPersianDigits(readyCount)} مخاطب اول برای پخش بدون اینترنت و فیلترشکن ذخیره شد.`
      );
    } finally {
      setPrecachePhonebookBusy(false);
    }
  };

  const handleTestSms = async () => {
    const sender = smsSender.trim() || 'مخاطب';
    const body = smsBody.trim() || 'پیام جدید دارید.';
    unlockAudioPlayback();
    setSmsTesting(true);
    try {
      const script = `پیامک جدید از طرف ${sender}. متن پیام: ${body}`;
      await playSoftChime('gentle');
      let hadError = false;
      const src = await speakFluentPersian({
        text: script,
        title: `پیامک از ${sender}`,
        category: 'caller',
        voiceName: testVoice,
        rate: speechRate,
        style:
          'Clear, natural bilingual Persian and English SMS reader. Pronounce Persian text smoothly and Latin sender names clearly.',
        onError: (msg) => {
          hadError = true;
          onStatusToast(msg);
        },
      });
      if (hadError && isNativeAndroid()) {
        await testNativeSmsAnnouncement(sender, body, getVoiceGender(testVoice), testVoice);
      } else if (!hadError && src === 'gemini') {
        onStatusToast('پیامک با صدای روان استودیویی خوانده شد و در حافظه ذخیره گردید.');
      } else if (!hadError && src === 'neural-fallback') {
        onStatusToast('سهمیه رایگان صدای استودیویی امروز پر شده؛ فعلاً با صدای کمکی خوانده شد.');
      }
      await onRefreshClips();
    } finally {
      setSmsTesting(false);
    }
  };

  const handlePrecacheAllCallers = async () => {
    if (callers.length === 0) return;
    if (!isOnline) {
      onStatusToast('برای پیش‌ذخیره صدای مخاطبین، اتصال اینترنت لازم است.');
      return;
    }
    setPrecacheBusy(true);
    let readyCount = 0;
    try {
      for (const caller of callers) {
        const displayVariants = caller.persianPhonetic?.trim()
          ? Array.from(new Set([caller.name, caller.persianPhonetic.trim()]))
          : [caller.name];
        for (const variantName of displayVariants) {
          const singleScript = buildSpokenScript(variantName, caller.template);
          const clipId = hashTextKey(singleScript, caller.voiceName);
          let buffer = await getAudioClipBuffer(clipId);
          if (!buffer) {
            const res = await generateAndCacheGeminiWav({
              clipId,
              text: singleScript,
              title: `تماس: ${caller.name}`,
              category: 'caller',
              voiceName: caller.voiceName,
              style: 'Clear fluent Tehran Persian announcer.',
            });
            if ('buffer' in res) {
              buffer = res.buffer;
            }
            await new Promise((r) => setTimeout(r, 700));
          }
          if (buffer && isNativeAndroid()) {
            await precacheNativeWav(singleScript, caller.voiceName, buffer);
          }
        }
        readyCount++;
      }
      await onRefreshClips();
      onStatusToast(
        `${toPersianDigits(readyCount)} مخاطب برای اعلام فوری و آفلاین تماس ورودی آماده شدند.`
      );
    } finally {
      setPrecacheBusy(false);
    }
  };

  const buildSpokenScript = (callerName: string, tmpl: string) => {
    return tmpl.replace('{name}', callerName);
  };

  const handleQuickTest = async () => {
    if (!testName.trim()) return;
    unlockAudioPlayback();
    setIsTesting(true);
    try {
      const script = buildSpokenScript(testName.trim(), testTemplate);
      await playSoftChime('chime');
      const src = await speakFluentPersian({
        text: script,
        title: `تست تماس: ${testName.trim()}`,
        category: 'caller',
        voiceName: testVoice,
        rate: speechRate,
        style:
          'Clear, articulate bilingual Persian and English caller ID announcer. Pronounce Persian words in natural Tehran Persian and Latin names in crisp standard English.',
        onError: (msg) => onStatusToast(msg),
      });
      if (src === 'neural-fallback') {
        onStatusToast('سهمیه رایگان صدای استودیویی امروز تکمیل شده؛ فعلاً با صدای کمکی پخش شد.');
      }
      await onRefreshClips();
    } finally {
      setIsTesting(false);
    }
  };

  const handleSmartAnalyze = async () => {
    if (!testName.trim() || !isOnline) {
      onStatusToast('تحلیل هوشمند تلفظ نیازمند اتصال اینترنت است.');
      return;
    }
    setIsTesting(true);
    try {
      const res = await fetch(apiUrl('/api/caller-pronounce'), {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name: testName.trim(), template: testTemplate}),
      });
      const parsed = await safeReadJsonResponse<{spokenScript?: string; persianPhonetic?: string; error?: string}>(res);
      if (parsed.isHtml || !parsed.data) {
        throw new Error('سرور تحلیل نام در حال حاضر در دسترس نیست.');
      }
      const data = parsed.data;
      if (!res.ok) throw new Error(data.error || 'خطا در تحلیل نام');
      setPhoneticPreview(
        `اسکریپت پیشنهادی: «${data.spokenScript}» · تلفظ آوایی آفلاین: «${data.persianPhonetic}»`
      );
    } catch (err) {
      onStatusToast(err instanceof Error ? err.message : 'خطا در تحلیل نام');
    } finally {
      setIsTesting(false);
    }
  };

  const handleAddSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onAddCaller({
      name: name.trim(),
      persianPhonetic: persianPhonetic.trim() || undefined,
      relation: relation.trim() || 'مخاطب',
      template,
      repeatCount,
      chimeStyle,
      voiceName,
      favorite: false,
    });
    setName('');
    setRelation('');
    setPersianPhonetic('');
    onStatusToast('مخاطب به دفترچه اعلام تماس اضافه شد.');
  };

  const handleSimulateCall = async (caller: CallerContact) => {
    unlockAudioPlayback();
    setSimulatingCaller(caller);
    const script = buildSpokenScript(caller.name, caller.template);
    const fullText = caller.repeatCount === 2 ? `${script}. ${script}` : script;
    const clipId = hashTextKey(fullText, caller.voiceName);

    await playSoftChime(caller.chimeStyle);
    await speakFluentPersian({
      clipId,
      text: fullText,
      title: `تماس: ${caller.name}`,
      category: 'caller',
      voiceName: caller.voiceName,
      rate: speechRate,
      style:
        'Clear, pleasant bilingual Persian and English caller ID announcer. Pronounce Persian naturally and English/Latin names clearly.',
      onError: (msg) => onStatusToast(msg),
    });
    await onRefreshClips();
  };

  const handleEndSimulation = () => {
    stopAllSpeech();
    setSimulatingCaller(null);
  };

  const handleDownloadRingtone = async (caller: CallerContact) => {
    setBusyCallerId(caller.id);
    try {
      const singleScript = buildSpokenScript(caller.name, caller.template);
      const clipId = hashTextKey(singleScript, caller.voiceName);
      let buffer = await getAudioClipBuffer(clipId);

      if (!buffer && isOnline) {
        const res = await generateAndCacheGeminiWav({
          clipId,
          text: singleScript,
          title: `نام تماس‌گیرنده: ${caller.name}`,
          category: 'caller',
          voiceName: caller.voiceName,
          style:
            'Clear, pleasant bilingual Persian and English caller ID announcer. Pronounce Persian naturally and Latin words crisply.',
        });
        if ('buffer' in res) {
          buffer = res.buffer;
          await onRefreshClips();
        }
      }

      if (!buffer) {
        onStatusToast(
          isOnline
            ? 'سهمیه موقت ساخت فایل صوتی WAV تکمیل شده است؛ پخش زنده نام مخاطب همچنان بدون مشکل فعال است.'
            : 'برای ساخت فایل WAV زنگ اختصاصی این مخاطب، یک‌بار در حالت آنلاین دکمه دانلود را بزنید تا صدای فارسی/لاتین در فایل زنگ ترکیب شود.'
        );
        return;
      }

      const ringtoneBlob = await buildCallerRingtoneWav(buffer, caller.chimeStyle, caller.repeatCount);
      const url = URL.createObjectURL(ringtoneBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Ringtone_${caller.name.replace(/[^\u0600-\u06FF\w-]+/g, '_')}.wav`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      onStatusToast(`فایل زنگ اختصاصی «${caller.name}» آماده شد. در مخاطبین Mi 10T Pro به‌عنوان آهنگ زنگ تنظیم کنید.`);
    } catch (err) {
      onStatusToast(err instanceof Error ? err.message : 'خطا در ساخت فایل زنگ تماس');
    } finally {
      setBusyCallerId(null);
    }
  };

  return (
    <div className="space-y-8">
      {/* Automatic Call & SMS Toggles + SMS Simulator */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-5 rounded-2xl bg-white dark:bg-[#121E1C] border border-slate-200/80 dark:border-emerald-950/70 p-6 space-y-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            تنظیمات سرویس بومی در فایل APK اندروید
          </div>
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">
            کنترل خودکار اعلام تماس و پیامک (SMS)
          </h2>
          <p className="text-xs leading-6 text-slate-600 dark:text-slate-300">
            وقتی نسخه APK روی گوشی نصب باشد، با رسیدن تماس یا پیامک، نام مخاطب (حتی اگر لاتین باشد) و متن پیامک به‌صورت خودکار با صدای فارسی/دوزبانه خوانده می‌شود.
          </p>

          <div className="space-y-2.5 pt-1">
            <button
              type="button"
              onClick={() => onUpdateSettings({announceCalls: !announceCalls})}
              className={`w-full min-h-[48px] px-4 rounded-xl border text-right flex items-center justify-between gap-3 cursor-pointer transition-colors ${
                announceCalls
                  ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-900 dark:text-emerald-200'
                  : 'bg-slate-50 dark:bg-[#0B1312] border-slate-200 dark:border-emerald-950 text-slate-600 dark:text-slate-400'
              }`}
            >
              <span className="text-xs sm:text-sm font-semibold">اعلام خودکار نام تماس‌گیرنده</span>
              <span className="text-xs font-bold">{announceCalls ? 'روشن' : 'خاموش'}</span>
            </button>

            <button
              type="button"
              onClick={() => onUpdateSettings({announceSms: !announceSms})}
              className={`w-full min-h-[48px] px-4 rounded-xl border text-right flex items-center justify-between gap-3 cursor-pointer transition-colors ${
                announceSms
                  ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-900 dark:text-emerald-200'
                  : 'bg-slate-50 dark:bg-[#0B1312] border-slate-200 dark:border-emerald-950 text-slate-600 dark:text-slate-400'
              }`}
            >
              <span className="text-xs sm:text-sm font-semibold">خواندن فرستنده و متن پیامک ورودی (SMS)</span>
              <span className="text-xs font-bold">{announceSms ? 'روشن' : 'خاموش'}</span>
            </button>
          </div>
        </div>

        <div className="lg:col-span-7 rounded-2xl bg-white dark:bg-[#121E1C] border border-slate-200/80 dark:border-emerald-950/70 p-6 space-y-4">
          <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <MessageSquare className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
            <span>پیش‌نمایش خواندن پیامک ورودی (نام فارسی یا Latin + متن پیام)</span>
          </div>
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">
            تست سخنگوی پیامک ورودی
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                نام فرستنده یا شماره (فارسی / Latin)
              </label>
              <input
                type="text"
                value={smsSender}
                onChange={(e) => setSmsSender(e.target.value)}
                placeholder="مثلاً: نام مخاطب یا Ali Tech"
                className="w-full min-h-[44px] px-3.5 rounded-xl border border-slate-200 dark:border-emerald-900 bg-slate-50/70 dark:bg-[#0B1312] text-sm text-slate-900 dark:text-white"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                متن پیامک نمونه
              </label>
              <input
                type="text"
                value={smsBody}
                onChange={(e) => setSmsBody(e.target.value)}
                placeholder="متن پیامک ورودی..."
                className="w-full min-h-[44px] px-3.5 rounded-xl border border-slate-200 dark:border-emerald-900 bg-slate-50/70 dark:bg-[#0B1312] text-sm text-slate-900 dark:text-white"
              />
            </div>
          </div>

          <button
            type="button"
            disabled={smsTesting}
            onClick={handleTestSms}
            className="min-h-[44px] px-5 rounded-xl bg-slate-900 dark:bg-emerald-600 hover:bg-slate-800 text-white text-xs sm:text-sm font-semibold inline-flex items-center gap-2 cursor-pointer disabled:opacity-60"
          >
            {smsTesting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Volume2 className="w-4 h-4" />}
            <span>خواندن فرستنده و متن پیامک الان</span>
          </button>
        </div>
      </section>

      {/* Phonebook Sync & Offline Pronunciation Learning */}
      <section className="rounded-2xl bg-white dark:bg-[#121E1C] border border-slate-200/80 dark:border-emerald-950/70 p-6 sm:p-7 space-y-5">
        <input
          ref={vcfInputRef}
          type="file"
          accept=".vcf,text/vcard,text/x-vcard,*/*"
          onChange={handleVcfFileSelected}
          className="hidden"
        />

        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-400 font-semibold">
              <BookUser className="w-4 h-4" />
              <span>همگام‌سازی دفترچه تلفن با برنامه · بدون نیاز به فیلترشکن در تماس و پیامک</span>
            </div>
            <h2 className="text-lg sm:text-xl font-extrabold text-slate-900 dark:text-white">
              یادگیری خودکار تلفظ فارسی تمام مخاطبین گوشی
            </h2>
            <p className="text-xs sm:text-sm leading-6 text-slate-600 dark:text-slate-300 max-w-3xl">
              مخاطبین گوشی (به‌ویژه نام‌های انگلیسی و فینگلیش) را یک‌بار همگام‌سازی کنید تا تلفظ روان فارسی آن‌ها در حافظه داخلی گوشی ذخیره شود و موقع تماس یا پیامک، حتی بدون اینترنت و فیلترشکن، نام فرستنده کاملاً واضح خوانده شود.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <button
              type="button"
              disabled={syncingPhonebook}
              onClick={handleSyncPhonebook}
              className="min-h-[44px] px-4 rounded-xl bg-emerald-700 hover:bg-emerald-800 dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white text-xs sm:text-sm font-semibold inline-flex items-center gap-2 cursor-pointer disabled:opacity-60"
            >
              {syncingPhonebook ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              <span>{syncingPhonebook ? 'در حال یادگیری...' : 'همگام‌سازی دفترچه تلفن'}</span>
            </button>

            <button
              type="button"
              disabled={syncingPhonebook}
              onClick={() => vcfInputRef.current?.click()}
              className="min-h-[44px] px-3.5 rounded-xl border border-slate-200 dark:border-emerald-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-emerald-950/40 text-xs sm:text-sm font-medium inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Upload className="w-4 h-4" />
              <span>وارد کردن فایل .vcf</span>
            </button>

            {syncedContacts.length > 0 && (
              <button
                type="button"
                disabled={precachePhonebookBusy}
                onClick={handlePrecacheSyncedContacts}
                className="min-h-[44px] px-3.5 rounded-xl bg-slate-900 dark:bg-emerald-900/70 hover:bg-slate-800 text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-60"
              >
                {precachePhonebookBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                <span>{precachePhonebookBusy ? 'در حال ذخیره...' : 'ذخیره صدای آفلاین ۵۰ مخاطب اول'}</span>
              </button>
            )}
          </div>
        </div>

        {syncedContacts.length > 0 ? (
          <div className="space-y-3 pt-1">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
              <div className="text-xs font-semibold text-slate-600 dark:text-slate-300 tabular-nums">
                {toPersianDigits(syncedContacts.length)} مخاطب همگام‌سازی شده (تلفظ را می‌توانید مستقیماً ویرایش کنید)
              </div>
              <div className="relative w-full sm:w-72">
                <Search className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={contactSearch}
                  onChange={(e) => setContactSearch(e.target.value)}
                  placeholder="جستجوی نام، شماره یا تلفظ..."
                  className="w-full min-h-[40px] pr-9 pl-3 rounded-xl border border-slate-200 dark:border-emerald-900 bg-slate-50/70 dark:bg-[#0B1312] text-xs text-slate-900 dark:text-white"
                />
              </div>
            </div>

            <div className="max-h-[340px] overflow-y-auto divide-y divide-slate-100 dark:divide-emerald-950/60 border border-slate-200/70 dark:border-emerald-900/60 rounded-xl px-3">
              {filteredSyncedContacts.slice(0, 120).map((c) => {
                const realIdx = syncedContacts.findIndex(
                  (item) => item.name === c.name && item.phone === c.phone
                );
                return (
                  <div
                    key={`${c.name}_${c.phone}`}
                    className="py-3 flex flex-col md:flex-row md:items-center justify-between gap-2.5"
                  >
                    <div className="min-w-0 md:w-5/12">
                      <div className="text-sm font-bold text-slate-900 dark:text-white truncate font-latin">
                        {c.name}
                      </div>
                      {c.phone && (
                        <div className="text-[11px] font-mono-num text-slate-500 dark:text-slate-400">
                          {c.phone}
                        </div>
                      )}
                    </div>

                    <div className="flex-1 flex items-center gap-2">
                      <input
                        type="text"
                        value={c.persianPhonetic}
                        onChange={(e) => {
                          if (realIdx >= 0) handleUpdateSyncedPhonetic(realIdx, e.target.value);
                        }}
                        aria-label={`تلفظ فارسی ${c.name}`}
                        placeholder="تلفظ فارسی روان..."
                        className="flex-1 min-h-[38px] px-3 rounded-lg border border-slate-200 dark:border-emerald-900 bg-slate-50 dark:bg-[#0B1312] text-xs text-slate-900 dark:text-white"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          unlockAudioPlayback();
                          const spoken = c.persianPhonetic.trim() || c.name;
                          speakFluentPersian({
                            text: `تماس ورودی از طرف ${spoken}`,
                            title: `تلفظ: ${c.name}`,
                            category: 'caller',
                            voiceName: defaultVoice,
                            rate: speechRate,
                          });
                        }}
                        aria-label={`تست تلفظ ${c.name}`}
                        className="min-h-[38px] px-2.5 rounded-lg bg-slate-100 dark:bg-emerald-950/60 hover:bg-emerald-100 text-emerald-700 dark:text-emerald-300 text-xs font-medium inline-flex items-center gap-1 cursor-pointer shrink-0"
                      >
                        <Volume2 className="w-3.5 h-3.5" />
                        <span>شنیدن</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handlePromoteToVip(c)}
                        aria-label={`افزودن ${c.name} به VIP`}
                        className="min-h-[38px] px-2.5 rounded-lg border border-slate-200 dark:border-emerald-900 hover:bg-emerald-50 dark:hover:bg-emerald-950/50 text-slate-700 dark:text-slate-200 text-xs font-medium inline-flex items-center gap-1 cursor-pointer shrink-0"
                      >
                        <UserPlus className="w-3.5 h-3.5" />
                        <span>VIP</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-slate-200 dark:border-emerald-900/70 py-6 px-4 text-center text-xs sm:text-sm text-slate-500 dark:text-slate-400">
            هنوز دفترچه تلفنی همگام‌سازی نشده است. روی «همگام‌سازی دفترچه تلفن» بزنید تا اسامی لاتین و فارسی گوشی شما به‌طور خودکار یاد گرفته شوند.
          </div>
        )}
      </section>

      {/* Quick Bilingual Tester + MIUI 14 Device Bridge */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7 rounded-2xl bg-white dark:bg-[#121E1C] border border-slate-200/80 dark:border-emerald-950/70 p-6 sm:p-8">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            پشتیبانی هم‌زمان خط فارسی، انگلیسی و فینگلیش · قابل ذخیره آفلاین
          </div>
          <h1 className="mt-2 text-xl sm:text-2xl font-extrabold text-slate-900 dark:text-white text-balance">
            اعلام صوتی نام تماس‌گیرنده (فارسی و لاتین)
          </h1>
          <p className="mt-2 text-sm leading-7 text-slate-600 dark:text-slate-300">
            نام تماس‌گیرنده را به فارسی، لاتین یا ترکیبی وارد کنید تا برنامه با تلفظ صحیح و روان بخواند و زنگ اختصاصی قابل نصب روی گوشی برای آن بسازد.
          </p>

          <div className="mt-5 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                  نام تماس‌گیرنده (فارسی / Latin)
                </label>
                <input
                  type="text"
                  value={testName}
                  onChange={(e) => setTestName(e.target.value)}
                  placeholder="مثلاً: نام مخاطب یا Sara Design"
                  className="w-full min-h-[44px] px-4 rounded-xl border border-slate-200 dark:border-emerald-900 bg-slate-50/70 dark:bg-[#0B1312] text-sm text-slate-900 dark:text-white"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                  صدای گوینده
                </label>
                <select
                  value={testVoice}
                  onChange={(e) => setTestVoice(e.target.value as VoiceName)}
                  className="w-full min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-emerald-900 bg-white dark:bg-[#0B1312] text-xs text-slate-800 dark:text-slate-100"
                >
                  {VOICE_PERSONAS.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                الگوی خواندن نام
              </label>
              <select
                value={testTemplate}
                onChange={(e) => setTestTemplate(e.target.value)}
                className="w-full min-h-[44px] px-3.5 rounded-xl border border-slate-200 dark:border-emerald-900 bg-white dark:bg-[#0B1312] text-sm text-slate-800 dark:text-slate-100"
              >
                {TEMPLATES.map((t) => (
                  <option key={t} value={t}>
                    {t.replace('{name}', testName || 'نام مخاطب')}
                  </option>
                ))}
              </select>
            </div>

            {phoneticPreview && (
              <div className="p-3.5 rounded-xl bg-emerald-50/70 dark:bg-emerald-950/40 border border-emerald-200/70 dark:border-emerald-900 text-xs leading-6 text-emerald-900 dark:text-emerald-200">
                {phoneticPreview}
              </div>
            )}

            <div className="pt-2 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleQuickTest}
                disabled={isTesting}
                className="min-h-[44px] px-5 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white text-sm font-semibold flex items-center gap-2 cursor-pointer"
              >
                {isTesting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Volume2 className="w-4 h-4" />}
                <span>تست زنگ و خواندن نام</span>
              </button>

              <button
                type="button"
                onClick={handleSmartAnalyze}
                disabled={isTesting || !isOnline}
                className="min-h-[44px] px-4 py-2.5 rounded-xl border border-slate-200 dark:border-emerald-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-emerald-950/40 disabled:opacity-50 text-sm font-medium flex items-center gap-2 cursor-pointer"
              >
                <Sparkles className="w-4 h-4" />
                <span>بهینه‌سازی تلفظ دوزبانه</span>
              </button>
            </div>
          </div>
        </div>

        {/* Xiaomi Mi 10T Pro / MIUI 14 Practical Guide */}
        <div className="lg:col-span-5 rounded-2xl bg-white dark:bg-[#121E1C] border border-slate-200/80 dark:border-emerald-950/70 p-6 flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
              <Smartphone className="w-5 h-5" />
              <h2 className="text-base font-bold text-slate-900 dark:text-white">
                راه‌اندازی روی Xiaomi Mi 10T Pro (MIUI 14)
              </h2>
            </div>
            <p className="mt-2.5 text-xs leading-6 text-slate-600 dark:text-slate-300">
              مرورگر وب به‌طور مستقیم اجازه شنود تماس‌های مخابراتی گوشی را ندارد؛ اما با دو روش کاربردی زیر می‌توانید روی گوشی <strong>Mi 10T Pro (Android 12 / MIUI 14)</strong> دقیقاً همین صدای روان فارسی و لاتین را هنگام زنگ خوردن بشنوید:
            </p>

            <ol className="mt-4 space-y-3 text-xs leading-6 text-slate-700 dark:text-slate-300">
              <li className="flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-700 dark:text-emerald-400 shrink-0 mt-0.5" />
                <span>
                  <strong>روش ۱ (۱۰۰٪ آفلاین با زنگ اختصاصی):</strong> دکمه <em>«دانلود زنگ WAV»</em> کنار هر مخاطب را بزنید. فایل ترکیبی زنگ + صدای روان فارسی/لاتین ذخیره می‌شود. سپس در برنامه <strong>Contacts (مخاطبین)</strong> شیائومی روی مخاطب بزنید و آن فایل را به عنوان <strong>آهنگ زنگ اختصاصی</strong> انتخاب کنید.
                </span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-700 dark:text-emerald-400 shrink-0 mt-0.5" />
                <span>
                  <strong>روش ۲ (اعلام خودکار همه شماره‌ها در MIUI 14):</strong> در گوشی به مسیر{' '}
                  <span className="font-medium text-slate-900 dark:text-white">
                    تنظیمات ← تنظیمات بیشتر ← زبان و ورودی ← خروجی تبدیل متن به گفتار
                  </span>{' '}
                  بروید، <em>Speech Services by Google</em> را انتخاب و زبان فارسی را دانلود کنید؛ سپس در برنامه تلفن (Phone) گزینه <em>اعلام شناسه تماس‌گیرنده</em> را روشن کنید.
                </span>
              </li>
            </ol>
          </div>
        </div>
      </section>

      {/* Add Caller + Directory */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-5 rounded-2xl bg-white dark:bg-[#121E1C] border border-slate-200/80 dark:border-emerald-950/70 p-6">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">افزودن مخاطب صوتی جدید</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            مخاطبین فارسی، انگلیسی یا فینگلیش خود را برای ساخت زنگ و تست آماده کنید
          </p>

          <form onSubmit={handleAddSubmit} className="mt-5 space-y-3.5">
            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                نام مخاطب (فارسی یا لاتین)
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="مثلاً: نام مخاطب یا David Manager"
                className="w-full min-h-[44px] px-3.5 rounded-xl border border-slate-200 dark:border-emerald-900 bg-slate-50/70 dark:bg-[#0B1312] text-sm text-slate-900 dark:text-white"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                  نسبت / عنوان
                </label>
                <input
                  type="text"
                  value={relation}
                  onChange={(e) => setRelation(e.target.value)}
                  placeholder="مثلاً: خانواده، همکار"
                  className="w-full min-h-[44px] px-3.5 rounded-xl border border-slate-200 dark:border-emerald-900 bg-slate-50/70 dark:bg-[#0B1312] text-sm text-slate-900 dark:text-white"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                  تلفظ کمکی (اختیاری)
                </label>
                <input
                  type="text"
                  value={persianPhonetic}
                  onChange={(e) => setPersianPhonetic(e.target.value)}
                  placeholder="مثلاً: دِیوید مَنیجِر"
                  className="w-full min-h-[44px] px-3.5 rounded-xl border border-slate-200 dark:border-emerald-900 bg-slate-50/70 dark:bg-[#0B1312] text-sm text-slate-900 dark:text-white"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                جمله اعلام تماس
              </label>
              <select
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
                className="w-full min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-emerald-900 bg-white dark:bg-[#0B1312] text-xs text-slate-800 dark:text-slate-100"
              >
                {TEMPLATES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">
                  تکرار نام
                </label>
                <select
                  value={repeatCount}
                  onChange={(e) => setRepeatCount(Number(e.target.value) as 1 | 2)}
                  className="w-full min-h-[42px] px-2.5 rounded-xl border border-slate-200 dark:border-emerald-900 bg-white dark:bg-[#0B1312] text-xs"
                >
                  <option value={1}>۱ بار</option>
                  <option value={2}>۲ بار</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">
                  آهنگ زنگ
                </label>
                <select
                  value={chimeStyle}
                  onChange={(e) => setChimeStyle(e.target.value as 'gentle' | 'classic' | 'chime')}
                  className="w-full min-h-[42px] px-2.5 rounded-xl border border-slate-200 dark:border-emerald-900 bg-white dark:bg-[#0B1312] text-xs"
                >
                  <option value="chime">ملودی گرم</option>
                  <option value="gentle">آرام</option>
                  <option value="classic">کلاسیک</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">
                  گوینده
                </label>
                <select
                  value={voiceName}
                  onChange={(e) => setVoiceName(e.target.value as VoiceName)}
                  className="w-full min-h-[42px] px-2 rounded-xl border border-slate-200 dark:border-emerald-900 bg-white dark:bg-[#0B1312] text-xs"
                >
                  {VOICE_PERSONAS.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <button
              type="submit"
              className="w-full min-h-[44px] rounded-xl bg-slate-900 dark:bg-emerald-600 hover:bg-slate-800 dark:hover:bg-emerald-500 text-white text-sm font-semibold flex items-center justify-center gap-2 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>افزودن به دفترچه تماس صوتی</span>
            </button>
          </form>
        </div>

        {/* Contacts List */}
        <div className="lg:col-span-7 rounded-2xl bg-white dark:bg-[#121E1C] border border-slate-200/80 dark:border-emerald-950/70 p-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-slate-900 dark:text-white">مخاطبین صوتی فارسی و لاتین</h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 tabular-nums">
                {toPersianDigits(callers.length)} مخاطب آماده شبیه‌سازی و دانلود زنگ اختصاصی
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={precacheBusy || callers.length === 0}
                onClick={handlePrecacheAllCallers}
                className="min-h-[40px] px-3.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
              >
                {precacheBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                <span>{precacheBusy ? 'در حال ذخیره...' : 'ذخیره صدای همه برای تماس آفلاین'}</span>
              </button>
              {isNativeAndroid() && (
                <button
                  type="button"
                  onClick={() =>
                    testNativeCallAnnouncement(
                      'مخاطب عزیز',
                      'تماس ورودی از طرف مخاطب',
                      getVoiceGender(defaultVoice),
                      defaultVoice
                    )
                  }
                  className="min-h-[40px] px-3.5 rounded-xl border border-slate-200 dark:border-emerald-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-emerald-950/40 text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <Phone className="w-3.5 h-3.5" />
                  <span>تست سرویس پس‌زمینه تماس</span>
                </button>
              )}
            </div>
          </div>

          <div className="mt-4 divide-y divide-slate-100 dark:divide-emerald-950/60">
            {callers.map((caller) => (
              <div key={caller.id} className="py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-base font-bold text-slate-900 dark:text-white font-latin">
                    {caller.name}
                  </div>
                  <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400 flex flex-wrap items-center gap-1.5">
                    <span>{caller.relation}</span>
                    <span aria-hidden="true">·</span>
                    <span>تکرار {toPersianDigits(caller.repeatCount)} بار</span>
                    {caller.persianPhonetic && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>تلفظ: {caller.persianPhonetic}</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => handleSimulateCall(caller)}
                    className="min-h-[42px] px-3.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                  >
                    <PhoneIncoming className="w-3.5 h-3.5" />
                    <span>شبیه‌سازی تماس</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleDownloadRingtone(caller)}
                    disabled={busyCallerId === caller.id}
                    className="min-h-[42px] px-3.5 rounded-xl border border-slate-200 dark:border-emerald-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-emerald-950/40 text-xs font-medium flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                  >
                    {busyCallerId === caller.id ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Download className="w-3.5 h-3.5" />
                    )}
                    <span>زنگ WAV</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => onDeleteCaller(caller.id)}
                    aria-label={`حذف ${caller.name}`}
                    className="min-h-[42px] min-w-[42px] rounded-xl text-slate-400 hover:text-rose-600 flex items-center justify-center cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Incoming Call Simulator Overlay */}
      {simulatingCaller && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-md p-4">
          <div className="w-full max-w-sm rounded-3xl bg-[#0E1B18] border border-emerald-900/60 p-8 text-center text-white shadow-2xl">
            <div className="text-xs text-emerald-300">تماس ورودی شبیه‌سازی‌شده</div>
            <div className="mt-6 w-20 h-20 mx-auto rounded-full bg-emerald-700/30 border border-emerald-500/50 flex items-center justify-center">
              <Phone className="w-9 h-9 text-emerald-300" />
            </div>
            <h3 className="mt-5 text-2xl font-extrabold font-latin">{simulatingCaller.name}</h3>
            <p className="mt-1 text-sm text-slate-300">{simulatingCaller.relation}</p>
            <p className="mt-4 text-xs text-emerald-200/80 leading-6">
              {buildSpokenScript(simulatingCaller.name, simulatingCaller.template)}
            </p>

            <div className="mt-8 flex items-center justify-center gap-4">
              <button
                type="button"
                onClick={handleEndSimulation}
                className="min-h-[48px] px-6 rounded-2xl bg-rose-600 hover:bg-rose-700 text-white text-sm font-semibold flex items-center gap-2 cursor-pointer"
              >
                <PhoneOff className="w-4 h-4" />
                <span>پایان شبیه‌سازی</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

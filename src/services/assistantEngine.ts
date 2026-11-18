import {formatJalaliFull, toPersianDigits} from '../data/persianLibrary';
import type {
  AppSettings,
  AppTab,
  AssistantCommandResult,
  CallerContact,
  DeviceOwner,
  MorningMessage,
  SyncedPhoneContact,
} from '../types/app';
import {
  extractCommandAfterWakeWord,
  getPartnerNameForDevice,
  getSelfName,
  normalizeAssistantText,
} from '../utils/deviceIdentity';
import {apiUrl, safeReadJsonResponse} from './apiConfig';

export interface PendingAssistantIntent {
  type: 'awaiting_sms_body' | 'awaiting_sms_recipient' | 'awaiting_sms_confirmation';
  targetName?: string;
  targetPhone?: string;
  smsBody?: string;
}

export interface AssistantEngineContext {
  settings: AppSettings;
  conversationHistory?: {role: 'user' | 'assistant'; text: string}[];
  deviceOwner: DeviceOwner;
  isOnline: boolean;
  syncedContacts: SyncedPhoneContact[];
  callers: CallerContact[];
  morningMessage: MorningMessage;
  pendingIntent: PendingAssistantIntent | null;
}

function persianDigitsToAscii(input: string): string {
  return input
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}

function normalizePhoneDigits(raw: string): string {
  return persianDigitsToAscii(raw).replace(/[^\d+]/g, '');
}

function getPartnerKeywords(): string[] {
  return ['همسر', 'همسرم', 'عشقم', 'عزیزم', 'خانم', 'خانوم', 'خانمم', 'خانومم', 'شوهرم', 'اقامون'];
}

export function findBestContactMatch(
  rawQuery: string,
  syncedContacts: SyncedPhoneContact[],
  callers: CallerContact[],
  settings: Pick<AppSettings, 'myName' | 'partnerName'>,
  deviceOwner: DeviceOwner
): {name: string; phone: string} | null {
  const trimmed = rawQuery.trim();
  if (!trimmed) return null;

  // 1. Direct phone number in query
  const directDigits = normalizePhoneDigits(trimmed);
  if (directDigits.replace(/\D/g, '').length >= 5) {
    return {name: trimmed, phone: directDigits};
  }

  let effectiveQuery = normalizeAssistantText(trimmed);
  const partnerName = getPartnerNameForDevice(settings, deviceOwner);
  const partnerNorm = normalizeAssistantText(partnerName);

  // 2. Partner shortcuts («همسر», «زری», «بهمن»)
  if (getPartnerKeywords().some((kw) => effectiveQuery === kw || effectiveQuery.includes(kw))) {
    effectiveQuery = partnerNorm;
  }

  const candidateNames = [effectiveQuery];
  if (effectiveQuery === 'زری' || effectiveQuery === 'زهرا') {
    candidateNames.push('zari', 'zahra', 'زری', 'زهرا');
  } else if (effectiveQuery === 'بهمن') {
    candidateNames.push('bahman', 'بهمن');
  }

  let bestScore = 0;
  let bestContact: {name: string; phone: string} | null = null;

  for (const contact of syncedContacts) {
    if (!contact.phone?.trim()) continue;
    const fields = [contact.name, contact.persianPhonetic].map((f) => normalizeAssistantText(f || '')).filter(Boolean);
    for (const q of candidateNames) {
      if (!q) continue;
      for (const f of fields) {
        let score = 0;
        if (f === q) score = 100;
        else if (f.startsWith(q) || q.startsWith(f)) score = 85;
        else if (f.includes(q)) score = 75;
        else {
          const qTokens = q.split(' ').filter((t) => t.length >= 2);
          const fTokens = f.split(' ').filter((t) => t.length >= 2);
          const overlap = qTokens.filter((t) => fTokens.some((ft) => ft === t || ft.includes(t)));
          if (overlap.length > 0) {
            score = 50 + overlap.length * 10;
          }
        }
        if (score > bestScore) {
          bestScore = score;
          bestContact = {name: contact.name, phone: contact.phone};
        }
      }
    }
  }

  // Never turn a weak phonetic resemblance into a real-world action.
  // A contact must be an exact or strong prefix match, and the best result must be unique.
  if (bestContact && bestScore >= 85) {
    const equallyGood = syncedContacts.filter((contact) => {
      if (!contact.phone?.trim()) return false;
      const fields = [contact.name, contact.persianPhonetic]
        .map((f) => normalizeAssistantText(f || ''))
        .filter(Boolean);
      return fields.some((f) =>
        candidateNames.some((q) => q && (f === q ? 100 : f.startsWith(q) || q.startsWith(f) ? 85 : 0) === bestScore)
      );
    });
    const uniquePhones = new Set(equallyGood.map((contact) => normalizePhoneDigits(contact.phone)));
    if (uniquePhones.size === 1) return bestContact;
  }

  // 3. Fallback: check saved CallerContacts and cross-match to syncedContacts if available
  for (const caller of callers) {
    const fields = [caller.name, caller.latinAlias || '', caller.persianPhonetic || '']
      .map((f) => normalizeAssistantText(f))
      .filter(Boolean);
    for (const q of candidateNames) {
      if (!q) continue;
      if (fields.some((f) => f === q || f.includes(q) || q.includes(f))) {
        // See if any syncedContact matches this caller name
        const synced = syncedContacts.find((sc) => {
          const scNorm = normalizeAssistantText(sc.name);
          const phNorm = normalizeAssistantText(sc.persianPhonetic);
          return fields.some((cf) => scNorm.includes(cf) || phNorm.includes(cf));
        });
        if (synced?.phone) {
          return {name: synced.name, phone: synced.phone};
        }
      }
    }
  }

  return null;
}

function getCurrentPersianTimeAndDate(): {timeStr: string; dateStr: string} {
  const now = new Date();
  const clockParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tehran',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const hh = clockParts.find((part) => part.type === 'hour')?.value ?? '00';
  const mm = clockParts.find((part) => part.type === 'minute')?.value ?? '00';
  const timeStr = `${toPersianDigits(hh)} و ${toPersianDigits(mm)} دقیقه`;
  const dateStr = formatJalaliFull(now);
  return {timeStr, dateStr};
}

function extractRecipientAndSmsBody(command: string): {targetRaw: string; bodyRaw: string} {
  let cleaned = command
    .replace(/^(لطفاً|لطفا|میشه|می‌شه|می شه)\s+/i, '')
    .trim();

  // Check if user specified message body inline (e.g. "به علی پیامک بده بگو سلام")
  let bodyRaw = '';
  const bodyMatch = cleaned.match(/(?:بگو|بنوس|بنویس|متنش|با متن|که)\s+(.+)$/);
  if (bodyMatch && bodyMatch.index !== undefined) {
    bodyRaw = bodyMatch[1].trim();
    cleaned = cleaned.slice(0, bodyMatch.index).trim();
  }

  const targetRaw = cleaned
    .replace(/^(یه |یک )?(پیامک|اس ام اس|اس‌ام‌اس|پیام|مسیج)\s*(بده|بفرست|ارسال کن)\s*(به|برای)?\s*/i, '')
    .replace(/^(به|برای)\s+/i, '')
    .replace(/\s*(پیامک|اس ام اس|اس‌ام‌اس|پیام|مسیج)\s*(بده|بفرست|ارسال کن).*$/i, '')
    .replace(/\s+(بده|بفرست|ارسال کن)$/i, '')
    .trim();

  return {targetRaw, bodyRaw};
}

function extractCallTarget(command: string): string {
  return command
    .replace(/^(لطفاً|لطفا|میشه|می‌شه|می شه)\s+/i, '')
    .replace(/^(با|به)\s+/i, '')
    .replace(/\s*(تماس بگیر|زنگ بزن|شماره بگیر|شماره‌گیری کن|تلفن بزن|تلفن کن).*$/i, '')
    .replace(/^(تماس بگیر|زنگ بزن|شماره بگیر|شماره‌گیری کن|تلفن بزن|تلفن کن)\s*(با|به)?\s*/i, '')
    .replace(/\s*(رو بگیر|را بگیر)$/i, '')
    .trim();
}

export function parseOfflineAssistantCommand(
  rawTranscript: string,
  ctx: AssistantEngineContext
): AssistantCommandResult | null {
  const selfName = getSelfName(ctx.settings, ctx.deviceOwner);
  const assistantName = ctx.settings.assistantName?.trim() || 'هم‌صدا';
  const wake = extractCommandAfterWakeWord(rawTranscript, assistantName);

  if (wake.matched && wake.onlyWakeWord) {
    return {
      action: 'answer',
      replyText: `جانم ${selfName}؟ گوش می‌کنم، بفرمایید.`,
    };
  }

  const commandRaw = wake.matched ? wake.command : rawTranscript.trim();
  const norm = normalizeAssistantText(commandRaw);
  if (!norm) return null;

  // Never send until the exact recipient and body are explicitly confirmed.
  if (ctx.pendingIntent?.type === 'awaiting_sms_confirmation') {
    if (/^(لغو|کنسل|بی ?خیال|بیخیال|نفرست|ولش کن|پشیمون شدم|انصراف|نه|خیر)/.test(norm)) return {action: 'answer', replyText: 'باشه، پیام ارسال نشد و لغو شد.'};
    if (/^(تایید|تأیید|بله|آره|اره|درسته|درست است|ارسال کن|بفرست|اوکی|باشه)/.test(norm)) return {action: 'send_sms', targetName: ctx.pendingIntent.targetName, targetPhone: ctx.pendingIntent.targetPhone, smsBody: ctx.pendingIntent.smsBody, replyText: 'در حال ارسال پیام تأییدشده به ' + ctx.pendingIntent.targetName + ' هستم.'};
    return {action: 'answer', replyText: 'برای جلوگیری از ارسال اشتباهی، فقط «تأیید» برای ارسال یا «لغو» برای انصراف بگو.'};
  }

  // Handle pending SMS conversation turn first
  if (ctx.pendingIntent?.type === 'awaiting_sms_body') {
    if (/^(لغو|کنسل|بی خیال|بیخیال|نفرست|ولش کن|پشیمون شدم|انصراف)/.test(norm)) {
      return {
        action: 'answer',
        replyText: 'باشه، ارسال پیامک لغو شد.',
      };
    }
    const smsBody = commandRaw.replace(/^(بگو|بنویس|بنوس|متنش|پیامش)\s+/i, '').trim();
    if (smsBody) {
      return {
        action: 'send_sms',
        targetName: ctx.pendingIntent.targetName,
        targetPhone: ctx.pendingIntent.targetPhone,
        smsBody,
        replyText: `پیامک به ${ctx.pendingIntent.targetName || 'مخاطب'} با متن «${smsBody}» ارسال می‌شود.`,
      };
    }
  }

  if (ctx.pendingIntent?.type === 'awaiting_sms_recipient') {
    if (/^(لغو|کنسل|بی خیال|بیخیال|نفرست|ولش کن|انصراف)/.test(norm)) {
      return {
        action: 'answer',
        replyText: 'باشه، ارسال پیامک لغو شد.',
      };
    }
    const matched = findBestContactMatch(
      commandRaw,
      ctx.syncedContacts,
      ctx.callers,
      ctx.settings,
      ctx.deviceOwner
    );
    if (matched) {
      return {
        action: 'ask_sms_body',
        targetName: matched.name,
        targetPhone: matched.phone,
        replyText: `متن پیامک برای ${matched.name} چی باشه؟`,
      };
    }
  }

  // 1. Time & Date
  if (
    /(ساعت چنده|ساعت چیه|چند ساعته|تایم چنده|الان ساعت|تاریخ امروز|امروز چندمه|امروز چه روزی)/.test(norm) ||
    norm === 'ساعت' ||
    norm === 'تاریخ'
  ) {
    const {timeStr, dateStr} = getCurrentPersianTimeAndDate();
    if (norm.includes('تاریخ') || norm.includes('چندمه') || norm.includes('چه روزی')) {
      return {
        action: 'tell_time',
        replyText: `${selfName} جان، امروز ${dateStr} و ساعت ${timeStr} است.`,
      };
    }
    return {
      action: 'tell_time',
      replyText: `${selfName} جان، الان ساعت ${timeStr} و امروز ${dateStr} است.`,
    };
  }

  // 2. End Call
  if (
    /(قطع کن تماس|تماس رو قطع|تماس را قطع|گوشی رو قطع|گوشی را قطع|تلفن رو قطع|تلفن را قطع|پایان تماس)/.test(norm)
  ) {
    return {
      action: 'end_call',
      replyText: 'باشه، تماس قطع می‌شود.',
    };
  }

  // 3. Audio Recording Stop (check BEFORE start!)
  if (
    /(ضبط رو متوقف|ضبط را متوقف|ضبط صدا رو قطع|ضبط را قطع|توقف ضبط|پایان ضبط|ضبط رو ببند|بسه ضبط)/.test(norm)
  ) {
    return {
      action: 'record_audio_stop',
      replyText: 'ضبط صدا متوقف و ذخیره می‌شود.',
    };
  }

  // 4. Camera Photo & Video & Audio Record Start
  if (/(عکس بگیر|عکس بنداز|عکاسی کن|دوربین عکس)/.test(norm)) {
    return {
      action: 'take_photo',
      replyText: 'دوربین را برای گرفتن عکس باز می‌کنم.',
    };
  }

  if (/(فیلم بگیر|فیلم برداری|فیلمبرداری|ویدیو بگیر|ویدئو بگیر)/.test(norm)) {
    return {
      action: 'record_video',
      replyText: 'دوربین فیلم‌برداری را باز می‌کنم.',
    };
  }

  if (/(ضبط صدا|صدا ضبط کن|صدا را ضبط|صدا رو ضبط|ضبط کن)/.test(norm)) {
    return {
      action: 'record_audio_start',
      replyText: 'در حال شروع ضبط صدا روی گوشی هستم.',
    };
  }

  // 4b. Flashlight On / Off
  if (/(چراغ قوه|فلش|فلاش)/.test(norm)) {
    if (/(خاموش|ببند|قطع)/.test(norm)) {
      return {action: 'flashlight_off', replyText: 'چراغ قوه گوشی خاموش می‌شود.'};
    }
    return {action: 'flashlight_on', replyText: 'چراغ قوه گوشی روشن می‌شود.'};
  }

  // 4c. Screen Brightness
  if (/(نور صفحه|روشنایی صفحه|روشنایی گوشی|نور گوشی)/.test(norm)) {
    if (/(حداکثر|تا اخر|بالاترین|زیادترین)/.test(norm)) {
      return {action: 'brightness_max', replyText: 'نور صفحه نمایش روی حداکثر تنظیم می‌شود.'};
    }
    if (/(حداقل|کمترین|خیلی کم|تاریک)/.test(norm)) {
      return {action: 'brightness_min', replyText: 'نور صفحه نمایش به حداقل می‌رسد.'};
    }
    if (/(زیاد|بیشتر|بالا)/.test(norm)) {
      return {action: 'brightness_up', replyText: 'نور صفحه نمایش افزایش می‌یابد.'};
    }
    if (/(کم|پایین)/.test(norm)) {
      return {action: 'brightness_down', replyText: 'نور صفحه نمایش کاهش می‌یابد.'};
    }
  }

  // 4d. Quick Connectivity Settings (Wi-Fi / Internet / Bluetooth / Location)
  if (/(وای فای|وایفای|wifi)/.test(norm) && /(تنظیم|باز|روشن|خاموش|وصل|قطع|پنل)/.test(norm)) {
    return {action: 'open_wifi_settings', replyText: 'پنل سریع وای‌فای و اینترنت باز می‌شود.'};
  }
  if (/(دیتا|اینترنت همراه|نت گوشی|اینترنت گوشی)/.test(norm) && /(تنظیم|باز|روشن|خاموش|وصل|قطع|پنل)/.test(norm)) {
    return {action: 'open_mobile_data_settings', replyText: 'پنل سریع اینترنت و شبکه باز می‌شود.'};
  }
  if (/(بلوتوث|bluetooth)/.test(norm)) {
    return {action: 'open_bluetooth_settings', replyText: 'تنظیمات بلوتوث گوشی باز می‌شود.'};
  }
  if (/(لوکیشن|مکان یاب|جی پی اس|gps)/.test(norm) && /(تنظیم|باز|روشن|خاموش)/.test(norm)) {
    return {action: 'open_location_settings', replyText: 'تنظیمات مکان‌یاب گوشی باز می‌شود.'};
  }

  // 4e. Alarm & Timer
  if (/(الارم|بیدارباش|ساعت زنگ)/.test(norm)) {
    const asciiCmd = persianDigitsToAscii(commandRaw);
    const timeMatch = asciiCmd.match(/(\d{1,2})(?::| و )?(\d{1,2})?/);
    let hour = timeMatch ? parseInt(timeMatch[1], 10) : 7;
    const minute = timeMatch?.[2] ? parseInt(timeMatch[2], 10) : 0;
    if ((norm.includes('عصر') || norm.includes('شب')) && hour < 12) hour += 12;
    return {
      action: 'set_alarm',
      alarmHour: Math.max(0, Math.min(23, hour)),
      alarmMinute: Math.max(0, Math.min(59, minute)),
      goalTitle: 'یادآور دستیار',
      replyText: `آلارم برای ساعت ${toPersianDigits(String(hour).padStart(2, '0'))}:${toPersianDigits(String(minute).padStart(2, '0'))} تنظیم می‌شود.`,
    };
  }
  if (norm.includes('تایمر')) {
    const asciiCmd = persianDigitsToAscii(commandRaw);
    const numMatch = asciiCmd.match(/(\d{1,3})/);
    const mins = numMatch ? Math.max(1, parseInt(numMatch[1], 10)) : 5;
    return {
      action: 'set_timer',
      timerMinutes: mins,
      goalTitle: 'تایمر دستیار',
      replyText: `تایمر ${toPersianDigits(mins)} دقیقه‌ای تنظیم می‌شود.`,
    };
  }

  // 4f. Direct URL open or explicit File Download URL
  const directUrlMatch = commandRaw.match(/https?:\/\/\S+/i);
  if (directUrlMatch?.[0]) {
    const url = directUrlMatch[0];
    if (norm.includes('دانلود')) {
      return {
        action: 'download_url',
        downloadUrl: url,
        downloadTitle: 'فایل درخواستی',
        replyText: 'دانلود مستقیم فایل در نوار اعلان گوشی شروع می‌شود.',
      };
    }
    return {
      action: 'open_url',
      downloadUrl: url,
      replyText: 'لینک مورد نظر در مرورگر گوشی باز می‌شود.',
    };
  }

  // 4g. Navigation / Maps
  if (/^(?:مسیر|مسیریابی|نقشه)\s+(?:به|تا|سمت)?\s*(.+)$/.test(norm)) {
    const dest = commandRaw.replace(/^(?:مسیر|مسیریابی|نقشه)\s*(?:به|تا|سمت)?\s*/i, '').trim();
    if (dest) {
      return {
        action: 'open_navigation',
        query: dest,
        replyText: `مسیریاب برای «${dest}» باز می‌شود.`,
      };
    }
  }

  // 4h. Open Installed App on Phone
  const knownApps = [
    'تلگرام',
    'واتساپ',
    'واتس‌اپ',
    'اینستاگرام',
    'اینستا',
    'روبیکا',
    'ایتا',
    'بله',
    'اسنپ',
    'نشان',
    'بلد',
    'گوگل مپ',
    'دیوار',
    'دیجی کالا',
    'دیجیکالا',
    'یوتیوب',
    'کروم',
    'ماشین حساب',
    'گالری',
    'تنظیمات',
    'کافه بازار',
    'بازار',
    'مایکت',
    'ساعت',
  ];
  if (
    /(باز کن|اجرا کن|بیار بالا)/.test(norm) &&
    !/(تب |بخش )/.test(norm) &&
    knownApps.some((a) => norm.includes(normalizeAssistantText(a)))
  ) {
    const matchedApp = knownApps.find((a) => norm.includes(normalizeAssistantText(a))) || '';
    return {
      action: 'open_app',
      targetName: matchedApp,
      query: matchedApp,
      replyText: `در حال باز کردن «${matchedApp}» هستم.`,
    };
  }

  // 5. Ringer / Silent / Vibrate / Normal
  if (/(سایلنت|حالت سکوت|گوشی رو بی صدا|گوشی را بی صدا|ساکت کن گوشی)/.test(norm)) {
    return {
      action: 'ringer_silent',
      replyText: 'گوشی را روی حالت سکوت و سایلنت می‌گذارم.',
    };
  }

  if (/(ویبره|حالت لرزش|لرزش بگذار|روی ویبره)/.test(norm)) {
    return {
      action: 'ringer_vibrate',
      replyText: 'گوشی روی حالت ویبره قرار می‌گیرد.',
    };
  }

  if (/(حالت عادی|از سایلنت در بیار|از سکوت در بیار|بزار رو صدا|بذار روی صدا|زنگدار کن)/.test(norm)) {
    return {
      action: 'ringer_normal',
      replyText: 'حالت زنگ گوشی به وضعیت عادی برمی‌گردد.',
    };
  }

  // 6. Media Volume Up / Down / Max / Mute
  if (/(صدا رو ببند|قطع صدا|میوت کن|صدا رو قطع کن|صدای گوشی رو قطع)/.test(norm)) {
    return {
      action: 'volume_mute',
      replyText: 'صدای رسانه و پخش گوشی کم/قطع شد.',
    };
  }

  if (/(صدا.*حداکثر|صدا.*تا اخر|بلندترین صدا|ماکزیمم صدا)/.test(norm)) {
    return {
      action: 'volume_max',
      replyText: 'صدا روی حداکثر تنظیم شد.',
    };
  }

  if (/(صدا.*زیاد|بلندتر کن|ببر بالا صدا|ولوم بالا)/.test(norm)) {
    return {
      action: 'volume_up',
      replyText: 'صدای گوشی بیشتر شد.',
    };
  }

  if (/(صدا.*کم|اروم تر کن|بیار پایین صدا|ولوم پایین)/.test(norm)) {
    return {
      action: 'volume_down',
      replyText: 'صدای گوشی کمتر شد.',
    };
  }

  // Telegram requests must never be treated as SMS.
  if (/تلگرام/.test(norm) && /(پیام|مسیج|بنویس|بفرست|ارسال)/.test(norm)) return {action: 'open_app', targetName: 'تلگرام', query: 'تلگرام', replyText: 'تلگرام را باز می‌کنم؛ اما ارسال پیام تلگرام را خودکار انجام نمی‌دهم. مخاطب و متن را داخل خود تلگرام بررسی و ارسال کن.'};

  // 7. Send SMS
  if (/(پیامک|اس ام اس|اس‌ام‌اس|پیام بده|پیام بفرست|مسیج)/.test(norm)) {
    const {targetRaw, bodyRaw} = extractRecipientAndSmsBody(commandRaw);
    if (!targetRaw) {
      return {
        action: 'ask_sms_body',
        replyText: 'به چه کسی پیامک بدم؟ لطفاً نام مخاطب را بگویید.',
      };
    }
    const contact = findBestContactMatch(
      targetRaw,
      ctx.syncedContacts,
      ctx.callers,
      ctx.settings,
      ctx.deviceOwner
    );
    if (!contact) {
      return {
        action: 'answer',
        replyText: `مخاطبی با نام «${targetRaw}» در دفترچه تلفن همگام‌شده پیدا نشد. از تب تماس و پیامک دفترچه را همگام کنید یا نام کامل را بگویید.`,
      };
    }
    if (bodyRaw) {
      return {
        action: 'send_sms',
        targetName: contact.name,
        targetPhone: contact.phone,
        smsBody: bodyRaw,
        replyText: `در حال ارسال پیامک به ${contact.name} هستم.`,
      };
    }
    return {
      action: 'ask_sms_body',
      targetName: contact.name,
      targetPhone: contact.phone,
      replyText: `متن پیامک برای ${contact.name} چی باشه؟`,
    };
  }

  // 8. Make Phone Call
  if (/(تماس بگیر|زنگ بزن|شماره بگیر|شماره‌گیری|تلفن بزن|تلفن کن)/.test(norm)) {
    const targetRaw = extractCallTarget(commandRaw);
    if (!targetRaw) {
      return {
        action: 'answer',
        replyText: 'نام شخص مورد نظر برای تماس را نفرمودید. با چه کسی تماس بگیرم؟',
      };
    }
    const contact = findBestContactMatch(
      targetRaw,
      ctx.syncedContacts,
      ctx.callers,
      ctx.settings,
      ctx.deviceOwner
    );
    if (!contact || !contact.phone) {
      return {
        action: 'answer',
        replyText: `شماره «${targetRaw}» در دفترچه تلفن همگام‌شده پیدا نشد. لطفاً در تب تماس و پیامک دکمه همگام‌سازی دفترچه تلفن را بزنید.`,
      };
    }
    return {
      action: 'make_call',
      targetName: contact.name,
      targetPhone: contact.phone,
      replyText: `در حال شماره‌گیری برای ${contact.name} هستم.`,
    };
  }

  // 9. Radio / Music / Stop Audio
  if (/(پخش رو قطع|موزیک رو قطع|اهنگ رو قطع|رادیو رو قطع|ساکت شو|پخش متوقف|توقف پخش)/.test(norm)) {
    return {
      action: 'stop_audio',
      replyText: 'پخش صدا متوقف شد.',
    };
  }

  if (norm.includes('رادیو') && /(بذار|بگذار|پخش|باز|گوش)/.test(norm)) {
    let query = 'iran';
    if (norm.includes('جهان') || norm.includes('خارجی')) query = 'world';
    else if (norm.includes('ارام') || norm.includes('لایت') || norm.includes('پیانو')) query = 'chill';
    return {
      action: 'play_radio',
      query,
      replyText: 'بخش رادیو زنده را باز می‌کنم.',
    };
  }

  if ((norm.includes('موزیک') || norm.includes('اهنگ') || norm.includes('موسیقی')) && /(بذار|بگذار|پخش|گوش)/.test(norm)) {
    return {
      action: 'play_music',
      query: commandRaw,
      replyText: 'بخش موزیک شبانه را باز می‌کنم.',
    };
  }

  // 10. Morning Message Readout
  if (/(پیام صبح|پیام امروز|پیام روز رو بخوان|پیام صبحگاهی)/.test(norm)) {
    return {
      action: 'answer',
      replyText: `${ctx.morningMessage.title}. ${ctx.morningMessage.message} ${ctx.morningMessage.affirmation}`,
    };
  }

  // 11. Add Goal
  const goalMatch = commandRaw.match(/(?:هدف|کار|یادآور)\s*(?:جدید\s*)?(?:اضافه کن|ثبت کن|بنویس)[:،]?\s*(.+)$/);
  if (goalMatch?.[1]?.trim()) {
    const goalTitle = goalMatch[1].trim();
    return {
      action: 'add_goal',
      goalTitle,
      replyText: `هدف «${goalTitle}» به لیست امروز اضافه شد.`,
    };
  }

  // 12. Tab Navigation
  if (/(برو به|باز کن|نشان بده|بخش)/.test(norm)) {
    const tabMap: {keywords: string[]; tab: AppTab; label: string}[] = [
      {keywords: ['امروز', 'هدف', 'برنامه'], tab: 'today', label: 'امروزِ ما'},
      {keywords: ['شکر', 'سپاس', 'انرژی'], tab: 'gratitude', label: 'شکرگذاری'},
      {keywords: ['شبانه', 'فیلم', 'پیام ساز'], tab: 'night', label: 'شبانه و رادیو'},
      {keywords: ['صوت', 'کتابخانه', 'گوینده'], tab: 'voice', label: 'کتابخانه صوتی'},
      {keywords: ['تماس', 'پیامک', 'دفترچه'], tab: 'caller', label: 'تماس و پیامک'},
      {keywords: ['تنظیم', 'نصب', 'همگام'], tab: 'sync', label: 'تنظیم و نصب'},
    ];
    for (const item of tabMap) {
      if (item.keywords.some((kw) => norm.includes(kw))) {
        return {
          action: 'open_tab',
          tab: item.tab,
          replyText: `بخش ${item.label} باز شد.`,
        };
      }
    }
  }

  // 13. Simple Offline Greeting
  if (/^(سلام|خوبی|چطوری|صبحت بخیر|شبت بخیر|عصرت بخیر)/.test(norm)) {
    return {
      action: 'answer',
      replyText: `سلام ${selfName} عزیز! من ${assistantName} هستم و آماده‌ام دستورت رو انجام بدم.`,
    };
  }

  return null;
}


function buildOfflineConversationReply(
  utterance: string,
  ctx: AssistantEngineContext
): string {
  const selfName = getSelfName(ctx.settings, ctx.deviceOwner);
  const assistantName = ctx.settings.assistantName?.trim() || 'هم‌صدا';
  const text = normalizeAssistantText(utterance);
  const previousUser = [...(ctx.conversationHistory || [])].reverse().find((item) => item.role === 'user')?.text;

  if (/^(سلام|درود|صبح بخیر|صبحت بخیر|عصر بخیر|شب بخیر)/.test(text)) {
    return `سلام ${selfName} جان! خوش اومدی. من ${assistantName} هستم؛ بگو ببینم چه خبر؟`;
  }
  if (/(اسم تو چیه|اسمت چیه|تو کی هستی|خودتو معرفی کن)/.test(text)) {
    return `من ${assistantName} هستم؛ دستیار شخصی تو. هم برای گفت‌وگو کنارتم، هم برای انجام کارهایی که روی گوشی در دسترسمه.`;
  }
  if (/(من کیم|اسم من چیه|منو می شناسی|منو میشناسی)/.test(text)) {
    return `تو ${selfName} هستی. چیزهایی رو که در تنظیمات و حافظه همین برنامه ثبت شده می‌تونم به خاطر بیارم.`;
  }
  if (/(چه کار(هایی)? می تونی|چیکار می تونی|چه قابلیت|چه امکاناتی)/.test(text)) {
    return 'می‌تونم بهت جواب بدم و در کارهای گوشی مثل تماس، پیامک با تأیید، باز کردن برنامه‌ها، آلارم و تنظیمات کمکت کنم. وقتی اینترنت وصل باشه، گفت‌وگوی آزاد و پرسش‌های گسترده‌تری هم دارم.';
  }
  if (/(خوبی|حالت چطوره|چه خبر)/.test(text)) {
    return `خوبم، ممنون که پرسیدی ${selfName} جان! تو چطوری؟ امروز اوضاع چطوره؟`;
  }
  if (/(یادت هست|یادته|درباره چی حرف می زدیم|چی گفتم)/.test(text) && previousUser) {
    return `آخرین چیزی که در این گفت‌وگو گفتی این بود: «${previousUser}». منظورت همون موضوعه؟`;
  }
  if (/^(ممنون|مرسی|دمت گرم|تشکر)/.test(text)) {
    return `قربونت ${selfName} جان؛ هر وقت خواستی من اینجام.`;
  }
  return `${selfName} جان، حرفت رو شنیدم. الان موتور گفت‌وگوی آفلاینم هنوز نسخه پایه‌ست و برای جواب دقیق‌تر به اینترنت نیاز دارم. می‌تونی یکم واضح‌تر بگی منظورت چیه؟`;
}

export async function processAssistantUtterance(
  rawTranscript: string,
  ctx: AssistantEngineContext
): Promise<AssistantCommandResult> {
  const selfName = getSelfName(ctx.settings, ctx.deviceOwner);
  const assistantName = ctx.settings.assistantName?.trim() || 'هم‌صدا';
  const wake = extractCommandAfterWakeWord(rawTranscript, assistantName);
  const cleanedUtterance = wake.matched ? wake.command : rawTranscript.trim();

  // Try deterministic fast parser first (works both online and offline)
  const localMatch = parseOfflineAssistantCommand(rawTranscript, ctx);
  if (localMatch) {
    // Handle case where user said "پیامک بده" without naming recipient yet
    if (localMatch.action === 'ask_sms_body' && !localMatch.targetPhone && !localMatch.targetName) {
      return localMatch;
    }
    return localMatch;
  }

  if (!ctx.isOnline) {
    const offlineReply = buildOfflineConversationReply(cleanedUtterance || rawTranscript.trim(), ctx);
    return {action: 'answer', replyText: offlineReply};
  }

  const {timeStr, dateStr} = getCurrentPersianTimeAndDate();
  try {
    const res = await fetch(apiUrl('/api/assistant-command'), {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        utterance: cleanedUtterance || rawTranscript.trim(),
        assistantName,
        deviceOwner: ctx.deviceOwner,
        myName: ctx.settings.myName,
        partnerName: ctx.settings.partnerName,
        localTimeText: timeStr,
        jalaliDate: dateStr,
        contacts: ctx.syncedContacts.slice(0, 80),
      }),
    });

    const parsed = await safeReadJsonResponse<AssistantCommandResult & {error?: string}>(res);
    if (parsed.isHtml || !parsed.data || !res.ok) {
      throw new Error(parsed.data?.error || 'پاسخ نامعتبر از دستیار آنلاین');
    }

    const result = parsed.data;
    // Calls are high-impact: never trust an AI-guessed phone number.
    // Re-resolve the spoken recipient against the local contact book with a strict match.
    if (result.action === 'make_call') {
      const match = result.targetName
        ? findBestContactMatch(result.targetName, ctx.syncedContacts, ctx.callers, ctx.settings, ctx.deviceOwner)
        : null;
      if (!match?.phone) {
        return {
          action: 'answer',
          replyText: `برای اینکه با شخص اشتباهی تماس نگیرم، مخاطب را دقیق پیدا نکردم. گفتی «${result.targetName || cleanedUtterance}». لطفاً اسم مخاطب را دوباره و واضح بگو.`,
        };
      }
      result.targetName = match.name;
      result.targetPhone = match.phone;
    } else if (
      (result.action === 'send_sms' || result.action === 'ask_sms_body') &&
      result.targetName &&
      !result.targetPhone
    ) {
      const match = findBestContactMatch(result.targetName, ctx.syncedContacts, ctx.callers, ctx.settings, ctx.deviceOwner);
      if (match) {
        result.targetName = match.name;
        result.targetPhone = match.phone;
      }
    }

    if ((result.action === 'send_sms' || result.action === 'make_call') && !result.targetPhone) {
      return {
        action: 'answer',
        replyText: `مخاطب «${result.targetName || ''}» شماره ذخیره‌شده در دفترچه همگام‌شده ندارد. لطفاً در تب تماس و پیامک دکمه همگام‌سازی دفترچه تلفن را بزنید.`,
      };
    }

    if (result.action === 'answer') {
      try {
        const chatRes = await fetch(apiUrl('/api/assistant-chat'), {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            assistantName,
            selfName,
            partnerName: getPartnerNameForDevice(ctx.settings, ctx.deviceOwner),
            userMessage: cleanedUtterance || rawTranscript.trim(),
            history: (ctx.conversationHistory || []).slice(-12),
          }),
        });
        const chatParsed = await safeReadJsonResponse<{replyText?: string; error?: string}>(chatRes);
        const conversationalReply = chatParsed.data?.replyText?.trim();
        if (chatRes.ok && conversationalReply) result.replyText = conversationalReply;
      } catch (chatError) {
        console.warn('Conversation engine unavailable; keeping command-router reply.', chatError);
      }
    }

    return result;
  } catch {
    return {
      action: 'answer',
      replyText: buildOfflineConversationReply(cleanedUtterance || rawTranscript.trim(), ctx),
    };
  }
}

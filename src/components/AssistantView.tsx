import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  AlarmClock,
  AppWindow,
  BellOff,
  Camera,
  Check,
  Clock,
  Download,
  ExternalLink,
  Flashlight,
  Globe,
  MessageSquare,
  Mic,
  MicOff,
  Music2,
  Phone,
  PhoneOff,
  Radio,
  Send,
  Sparkles,
  Square,
  Sun,
  Video,
  Volume2,
  VolumeX,
  Wifi,
} from 'lucide-react';
import {toPersianDigits} from '../data/persianLibrary';
import {
  parseOfflineAssistantCommand,
  processAssistantUtterance,
  type PendingAssistantIntent,
} from '../services/assistantEngine';
import {
  consumePendingWakeCommandNative,
  executeDeviceActionNative,
  isNativeAndroid,
  listenOncePersianNative,
  startNativeWakeWordService,
  stopNativeWakeWordService,
  stopListeningNative,
  type NativeCapabilities,
} from '../services/nativeAndroidBridge';
import type {
  AppSettings,
  AppTab,
  AssistantActionType,
  CallerContact,
  DeviceOwner,
  GroundingLink,
  MorningMessage,
  SyncedPhoneContact,
} from '../types/app';
import {
  getPartnerNameForDevice,
  getSelfName,
} from '../utils/deviceIdentity';

interface ChatMessage {
  id: string;
  sender: 'user' | 'assistant';
  text: string;
  action?: AssistantActionType;
  links?: GroundingLink[];
  downloadUrl?: string;
  downloadTitle?: string;
  timestamp: string;
}

interface AssistantViewProps {
  settings: AppSettings;
  deviceOwner: DeviceOwner;
  isOnline: boolean;
  isSpeaking: boolean;
  callers: CallerContact[];
  syncedContacts: SyncedPhoneContact[];
  morningMessage: MorningMessage;
  nativeCaps: NativeCapabilities;
  autoSpeakReplies: boolean;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  onSpeakText: (text: string, title: string, category: 'custom' | 'morning' | 'energy' | 'gratitude') => void;
  onStopSpeech: () => void;
  onOpenTab: (tab: AppTab) => void;
  onTriggerMedia: (tab: 'tracks' | 'radio', query?: string) => void;
  onAddGoalTitle: (title: string) => void;
  onStatusToast: (msg: string) => void;
}

interface WebSpeechRecognitionInstance {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: {results: ArrayLike<ArrayLike<{transcript: string}>>}) => void) | null;
  onerror: ((event: {error?: string}) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

const ACTION_LABELS: Partial<Record<AssistantActionType, string>> = {
  web_search: 'جستجو در اینترنت',
  download_url: 'دانلود فایل',
  open_url: 'باز کردن صفحه وب',
  open_app: 'باز کردن برنامه گوشی',
  open_navigation: 'مسیریاب و نقشه',
  flashlight_on: 'روشن شدن چراغ قوه',
  flashlight_off: 'خاموش شدن چراغ قوه',
  open_wifi_settings: 'پنل وای‌فای',
  open_bluetooth_settings: 'تنظیمات بلوتوث',
  open_mobile_data_settings: 'پنل اینترنت همراه',
  open_location_settings: 'تنظیمات مکان‌یاب',
  set_alarm: 'تنظیم آلارم',
  set_timer: 'تنظیم تایمر',
  brightness_up: 'افزایش نور صفحه',
  brightness_down: 'کاهش نور صفحه',
  brightness_max: 'حداکثر نور صفحه',
  brightness_min: 'حداقل نور صفحه',
  tell_time: 'ساعت و تاریخ',
  ask_sms_body: 'در انتظار متن پیامک',
  send_sms: 'ارسال پیامک',
  make_call: 'برقراری تماس',
  end_call: 'قطع تماس',
  volume_up: 'افزایش صدا',
  volume_down: 'کاهش صدا',
  volume_max: 'حداکثر صدا',
  volume_mute: 'قطع صدای رسانه',
  ringer_silent: 'حالت سکوت (سایلنت)',
  ringer_vibrate: 'حالت ویبره',
  ringer_normal: 'حالت عادی صدا',
  take_photo: 'دوربین عکس',
  record_video: 'دوربین فیلم‌برداری',
  record_audio_start: 'ضبط صدا فعال شد',
  record_audio_stop: 'ضبط صدا ذخیره شد',
  open_tab: 'تغییر بخش برنامه',
  play_radio: 'رادیو زنده',
  play_music: 'موزیک شبانه',
  stop_audio: 'توقف پخش',
  add_goal: 'افزودن هدف امروز',
};

const NATIVE_DEVICE_ACTIONS = new Set<AssistantActionType>([
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
]);

function nowTimeClock(): string {
  const d = new Date();
  return toPersianDigits(
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  );
}

export const AssistantView: React.FC<AssistantViewProps> = ({
  settings,
  deviceOwner,
  isOnline,
  isSpeaking,
  callers,
  syncedContacts,
  morningMessage,
  nativeCaps,
  autoSpeakReplies,
  onUpdateSettings,
  onSpeakText,
  onStopSpeech,
  onOpenTab,
  onTriggerMedia,
  onAddGoalTitle,
  onStatusToast,
}) => {
  const selfName = getSelfName(settings, deviceOwner);
  const partnerOtherName = getPartnerNameForDevice(settings, deviceOwner);
  const assistantName = settings.assistantName?.trim() || 'هم‌صدا';
  const wakeLoopEnabled = Boolean(settings.assistantWakeWordEnabled);

  const [assistantNameDraft, setAssistantNameDraft] = useState(assistantName);
  const [nameSavedFlash, setNameSavedFlash] = useState(false);
  const [textInput, setTextInput] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [isListeningOnce, setIsListeningOnce] = useState(false);
  const [isWakeListening, setIsWakeListening] = useState(false);
  const [isRecordingAudio, setIsRecordingAudio] = useState(false);
  const [pendingIntent, setPendingIntent] = useState<PendingAssistantIntent | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    {
      id: 'welcome-msg',
      sender: 'assistant',
      text: `سلام ${selfName} عزیز! من ${assistantName}، دستیار صوتی شخصی گوشی شما هستم. هر دستوری داری (تماس، پیامک، ساعت، عکس و فیلم، ضبط صدا، کم و زیاد کردن صدا، سایلنت/ویبره، رادیو یا هر سوالی) بگو تا انجام بدم.`,
      timestamp: nowTimeClock(),
    },
  ]);

  const webRecRef = useRef<WebSpeechRecognitionInstance | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const processingRef = useRef(false);
  // Prevent the wake-loop cleanup from cancelling a manually started recording.
  const manualListenRef = useRef(false);

  // Sync draft when settings.assistantName updates
  useEffect(() => {
    setAssistantNameDraft(settings.assistantName?.trim() || 'هم‌صدا');
  }, [settings.assistantName]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({behavior: 'smooth', block: 'nearest'});
  }, [messages]);

  const appendMessage = useCallback(
    (
      sender: 'user' | 'assistant',
      text: string,
      extra?: {
        action?: AssistantActionType;
        links?: GroundingLink[];
        downloadUrl?: string;
        downloadTitle?: string;
      }
    ) => {
      setMessages((prev) => [
        ...prev.slice(-30),
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          sender,
          text,
          action: extra?.action,
          links: extra?.links,
          downloadUrl: extra?.downloadUrl,
          downloadTitle: extra?.downloadTitle,
          timestamp: nowTimeClock(),
        },
      ]);
    },
    []
  );

  const handleDownloadLink = useCallback(
    async (url: string, title?: string) => {
      if (isNativeAndroid()) {
        const res = await executeDeviceActionNative({
          action: 'download_url',
          url,
          name: title || 'download',
        });
        onStatusToast(res.message || 'درخواست دانلود ارسال شد.');
      } else {
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.download = title || '';
        document.body.appendChild(a);
        a.click();
        a.remove();
        onStatusToast('لینک دانلود در برگه جدید باز شد.');
      }
    },
    [onStatusToast]
  );

  const executeUtterance = useCallback(
    async (rawUtterance: string, speakReply = true) => {
      const cleaned = rawUtterance.trim();
      if (!cleaned || processingRef.current) return;
      processingRef.current = true;
      setIsBusy(true);

      appendMessage('user', cleaned);

      try {
        const result = await processAssistantUtterance(cleaned, {
          settings,
          deviceOwner,
          isOnline,
          syncedContacts,
          callers,
          morningMessage,
          pendingIntent,
          conversationHistory: messages.slice(-12).map((message) => ({
            role: message.sender,
            text: message.text,
          })),
        });

        // Stage every SMS for review; do not execute it on the first pass.
        if (result.action === 'send_sms' && pendingIntent?.type !== 'awaiting_sms_confirmation') {
          setPendingIntent({type: 'awaiting_sms_confirmation', targetName: result.targetName || result.targetPhone || 'مخاطب نامشخص', targetPhone: result.targetPhone, smsBody: result.smsBody || ''});
        } else if (result.action === 'ask_sms_body') {
          if (result.targetPhone) {
            setPendingIntent({
              type: 'awaiting_sms_body',
              targetName: result.targetName || result.targetPhone,
              targetPhone: result.targetPhone,
            });
          } else {
            setPendingIntent({type: 'awaiting_sms_recipient'});
          }
        } else {
          setPendingIntent(null);
        }

        let finalReply = result.replyText;

        if (result.action === 'send_sms' && pendingIntent?.type !== 'awaiting_sms_confirmation') finalReply = 'قبل از ارسال، نام مخاطب و متن پیام را بررسی و تأیید کن.';

        // Execute Android Hardware/OS Action if applicable
        if (NATIVE_DEVICE_ACTIONS.has(result.action) && !(result.action === 'send_sms' && pendingIntent?.type !== 'awaiting_sms_confirmation')) {
          const shouldSkipAutoDownloadIfSearch =
            result.action === 'download_url' && !result.downloadUrl?.trim();

          if (!shouldSkipAutoDownloadIfSearch) {
            if (result.action === 'record_audio_start') {
              await stopListeningNative();
            }
            const nativeRes = await executeDeviceActionNative({
              action: result.action,
              phone: result.targetPhone,
              smsBody: result.smsBody,
              name: result.downloadTitle || result.targetName || result.goalTitle,
              url: result.downloadUrl,
              query: result.query,
              hour: result.alarmHour,
              minute: result.alarmMinute,
              seconds: result.timerMinutes ? result.timerMinutes * 60 : undefined,
            });
            if (nativeRes.recording !== undefined) {
              setIsRecordingAudio(Boolean(nativeRes.recording));
            } else if (result.action === 'record_audio_start' && nativeRes.ok) {
              setIsRecordingAudio(true);
            } else if (result.action === 'record_audio_stop') {
              setIsRecordingAudio(false);
            }

            if (!nativeRes.ok) {
              finalReply = nativeRes.message || finalReply;
              if (nativeRes.needsPolicyAccess) {
                onStatusToast('لطفاً در صفحه بازشده، دسترسی «مزاحم نشوید / سایلنت» را برای برنامه فعال کنید.');
              } else if (nativeRes.needsWriteSettings) {
                onStatusToast('لطفاً در صفحه بازشده، اجازه «تغییر تنظیمات سیستم (نور صفحه)» را فعال کنید.');
              } else if (nativeRes.permissionRequired) {
                onStatusToast(nativeRes.message || 'لطفاً مجوز اندروید خواسته‌شده را تایید کنید.');
              }
            } else if (nativeRes.savedPath) {
              finalReply = `${nativeRes.message || 'ذخیره شد'} (${nativeRes.savedPath})`;
            }
          }
        } else if (result.action === 'open_tab' && result.tab) {
          onOpenTab(result.tab);
        } else if (result.action === 'play_radio') {
          onOpenTab('night');
          onTriggerMedia('radio', result.query);
        } else if (result.action === 'play_music') {
          onOpenTab('night');
          onTriggerMedia('tracks', result.query);
        } else if (result.action === 'stop_audio') {
          onStopSpeech();
        } else if (result.action === 'add_goal' && result.goalTitle?.trim()) {
          onAddGoalTitle(result.goalTitle.trim());
        }

        appendMessage('assistant', finalReply, {
          action: result.action,
          links: result.links,
          downloadUrl: result.downloadUrl,
          downloadTitle: result.downloadTitle,
        });

        // Speak response aloud only if auto-speaker is enabled for this device
        if (
          speakReply &&
          autoSpeakReplies &&
          result.action !== 'record_audio_start' &&
          result.action !== 'stop_audio'
        ) {
          onSpeakText(finalReply, `پاسخ ${assistantName}`, 'custom');
        }
      } finally {
        setIsBusy(false);
        processingRef.current = false;
      }
    },
    [
      appendMessage,
      assistantName,
      autoSpeakReplies,
      callers,
      deviceOwner,
      isOnline,
      morningMessage,
      onAddGoalTitle,
      onOpenTab,
      onSpeakText,
      onStatusToast,
      onStopSpeech,
      onTriggerMedia,
      pendingIntent,
      settings,
      syncedContacts,
    ]
  );

  // Android owns the always-on wake-word lifecycle in a microphone foreground service.
  useEffect(() => {
    if (!isNativeAndroid()) {
      setIsWakeListening(false);
      return;
    }
    let mounted = true;
    if (!wakeLoopEnabled) {
      setIsWakeListening(false);
      void stopNativeWakeWordService();
      void stopListeningNative();
      return () => { mounted = false; };
    }
    setIsWakeListening(true);
    void startNativeWakeWordService(assistantName).then((result) => {
      if (!mounted) return;
      if (!result.ok) {
        setIsWakeListening(false);
        onUpdateSettings({assistantWakeWordEnabled: false});
        onStatusToast(result.message || (result.permissionRequired
          ? 'برای گوش‌به‌زنگ بودن، اجازه میکروفون لازم است.'
          : 'سرویس گوش‌به‌زنگ شروع نشد. برنامه را باز نگه دارید و دوباره امتحان کنید.'));
      }
    });
    return () => { mounted = false; };
  }, [wakeLoopEnabled, assistantName, onUpdateSettings, onStatusToast]);

  // Commands captured by the Android foreground listener are handed to the same
  // assistant pipeline. If Android paused the WebView in the background, the
  // pending command remains stored until the app resumes.
  useEffect(() => {
    if (!isNativeAndroid() || !wakeLoopEnabled) return;
    let disposed = false;
    let polling = false;
    const pollPendingCommand = async () => {
      if (disposed || polling || isBusy || isListeningOnce || isRecordingAudio) return;
      polling = true;
      try {
        const command = await consumePendingWakeCommandNative();
        if (!disposed && command) await executeUtterance(command, true);
      } finally {
        polling = false;
      }
    };
    void pollPendingCommand();
    const timer = window.setInterval(() => void pollPendingCommand(), 900);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [wakeLoopEnabled, executeUtterance, isBusy, isListeningOnce, isRecordingAudio]);

  const handleListenOnce = async () => {
    if (isListeningOnce) {
      manualListenRef.current = false;
      await stopListeningNative();
      webRecRef.current?.stop();
      setIsListeningOnce(false);
      return;
    }

    if (isSpeaking) {
      onStopSpeech();
    }

    if (isNativeAndroid()) {
      // Pause the background recognizer while the one-shot microphone session owns audio.
      if (wakeLoopEnabled) await stopNativeWakeWordService();
      // Set the ref before React runs the wake-loop effect cleanup.
      // listenOncePersianNative replaces the previous native recognizer itself.
      manualListenRef.current = true;
      setIsListeningOnce(true);
      try {
        await stopListeningNative();
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        const res = await listenOncePersianNative();
        if (res.permissionRequired) {
          onStatusToast('لطفاً مجوز میکروفون را برای استفاده از دستیار صوتی تایید کنید.');
        } else if (res.ok && (res.transcripts?.length || res.transcript?.trim())) {
          // Android returns N-best Persian hypotheses. Prefer the hypothesis that
          // resolves to a real local contact for call commands instead of blindly
          // executing Google's first guess (which can turn "Zari" into another word).
          const alternatives = Array.from(new Set(
            (res.transcripts?.length ? res.transcripts : [res.transcript || ''])
              .map((value) => value.trim())
              .filter(Boolean)
          ));
          const context = {
            settings,
            deviceOwner,
            isOnline,
            syncedContacts,
            callers,
            morningMessage,
            pendingIntent,
          };
          const evaluated = alternatives.map((transcript) => ({
            transcript,
            result: parseOfflineAssistantCommand(transcript, context),
          }));
          const resolvedCalls = evaluated.filter(
            (item) => item.result?.action === 'make_call' && item.result.targetPhone
          );
          const resolvedPhones = new Set(resolvedCalls.map((item) => item.result?.targetPhone));
          if (resolvedPhones.size > 1) {
            const reply = 'دو برداشت متفاوت از نام مخاطب شنیدم. برای اینکه با شخص اشتباهی تماس نگیرم، لطفاً فقط نام مخاطب را دوباره و شمرده بگو.';
            appendMessage('assistant', reply);
            if (autoSpeakReplies) onSpeakText(reply, `پاسخ ${assistantName}`, 'custom');
          } else if (resolvedCalls.length > 0) {
            await executeUtterance(resolvedCalls[0].transcript, true);
          } else {
            const callLike = evaluated.find((item) =>
              /(تماس بگیر|زنگ بزن|شماره بگیر|شماره‌گیری|تلفن بزن|تلفن کن)/.test(item.transcript)
            );
            const recognizedCommand = evaluated.find(
              (item) => item.result && item.result.action !== 'answer'
            );
            await executeUtterance(
              (callLike || recognizedCommand || evaluated[0]).transcript,
              true
            );
          }
        } else if (res.error && res.errorCode !== 6 && res.errorCode !== 7) {
          onStatusToast(res.error);
        } else {
          onStatusToast('صدایی واضح دریافت نشد؛ دوباره دکمه صحبت را بزنید یا دستور را تایپ کنید.');
        }
      } catch {
        onStatusToast('ارتباط با میکروفون برقرار نشد؛ دوباره تلاش کن.');
      } finally {
        manualListenRef.current = false;
        setIsListeningOnce(false);
        if (wakeLoopEnabled) window.setTimeout(() => void startNativeWakeWordService(assistantName), 1200);
      }
      return;
    }

    // Web Speech API fallback (Chrome / Edge / Android WebView)
    const win = window as unknown as {
      SpeechRecognition?: new () => WebSpeechRecognitionInstance;
      webkitSpeechRecognition?: new () => WebSpeechRecognitionInstance;
    };
    const SpeechRec = win.SpeechRecognition || win.webkitSpeechRecognition;
    if (!SpeechRec) {
      onStatusToast('مرورگر این دستگاه تشخیص گفتار وب ندارد؛ می‌توانید دستور را در کادر پایین تایپ کنید یا در APK صحبت کنید.');
      return;
    }

    try {
      const rec = new SpeechRec();
      rec.lang = 'fa-IR';
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      webRecRef.current = rec;
      setIsListeningOnce(true);

      rec.onresult = (event) => {
        const transcript = event.results?.[0]?.[0]?.transcript?.trim() || '';
        setIsListeningOnce(false);
        if (transcript) {
          executeUtterance(transcript, true);
        }
      };
      rec.onerror = () => {
        setIsListeningOnce(false);
        onStatusToast('صدایی از میکروفون مرورگر دریافت نشد؛ دستور را تایپ یا مجوز میکروفون را بررسی کنید.');
      };
      rec.onend = () => {
        setIsListeningOnce(false);
      };
      rec.start();
    } catch {
      setIsListeningOnce(false);
      onStatusToast('امکان فعال‌سازی میکروفون مرورگر نبود.');
    }
  };

  const handleSaveAssistantName = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = assistantNameDraft.trim() || 'هم‌صدا';
    onUpdateSettings({assistantName: cleaned});
    setNameSavedFlash(true);
    onStatusToast(`نام دستیار به «${cleaned}» تغییر کرد. از این به بعد با همین نام صدایش بزنید.`);
    window.setTimeout(() => setNameSavedFlash(false), 1800);
  };

  const handleToggleWakeWord = () => {
    const next = !wakeLoopEnabled;
    if (next && !isNativeAndroid()) {
      onStatusToast('حالت گوش‌به‌زنگ خودکار با صدا زدن نام دستیار در نسخه اندروید (APK) کار می‌کند.');
      return;
    }
    onUpdateSettings({assistantWakeWordEnabled: next});
    onStatusToast(
      next
        ? `در حال فعال‌کردن سرویس گوش‌به‌زنگ «${assistantName}» هستم؛ اعلان دائمی هم‌صدا نمایش داده می‌شود.`
        : 'گوش‌به‌زنگ خودکار دستیار خاموش شد (دکمه میکروفون همچنان فعال است).'
    );
  };

  const handleTextSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cmd = textInput.trim();
    if (!cmd) return;
    setTextInput('');
    executeUtterance(cmd, true);
  };

  const quickCommands: {label: string; command: string; icon: React.FC<{className?: string}>}[] = [
    {label: 'ساعت و تاریخ', command: 'ساعت چنده؟', icon: Clock},
    {label: `پیامک به ${partnerOtherName}`, command: `به ${partnerOtherName} پیامک بده`, icon: MessageSquare},
    {label: `تماس با ${partnerOtherName}`, command: `با ${partnerOtherName} تماس بگیر`, icon: Phone},
    {label: 'قطع تماس', command: 'تماس را قطع کن', icon: PhoneOff},
    {label: 'جستجو در اینترنت', command: 'آب و هوای امروز تهران چطوره؟', icon: Globe},
    {label: 'چراغ قوه روشن', command: 'چراغ قوه را روشن کن', icon: Flashlight},
    {label: 'چراغ قوه خاموش', command: 'چراغ قوه را خاموش کن', icon: Flashlight},
    {label: 'وای‌فای و اینترنت', command: 'وای فای را باز کن', icon: Wifi},
    {label: 'نور صفحه زیاد', command: 'نور صفحه را زیاد کن', icon: Sun},
    {label: 'آلارم ۷ صبح', command: 'آلارم ساعت ۷ صبح بگذار', icon: AlarmClock},
    {label: 'باز کردن واتساپ', command: 'واتساپ را باز کن', icon: AppWindow},
    {label: 'عکس بگیر', command: 'عکس بگیر', icon: Camera},
    {label: 'فیلم بگیر', command: 'فیلم بگیر', icon: Video},
    {
      label: isRecordingAudio ? 'توقف ضبط صدا' : 'ضبط صدا',
      command: isRecordingAudio ? 'ضبط صدا را متوقف کن' : 'صدا را ضبط کن',
      icon: isRecordingAudio ? Square : Mic,
    },
    {label: 'حالت سایلنت', command: 'گوشی را سایلنت کن', icon: BellOff},
    {label: 'حالت ویبره', command: 'گوشی را بگذار روی ویبره', icon: VolumeX},
    {label: 'حالت عادی صدا', command: 'گوشی را بگذار روی صدا', icon: Volume2},
    {label: 'صدا زیاد', command: 'صدا را زیاد کن', icon: Volume2},
    {label: 'رادیو ایران', command: 'رادیو ایران بگذار', icon: Radio},
    {label: 'موزیک آرام', command: 'موزیک آرام بگذار', icon: Music2},
  ];

  return (
    <div className="space-y-6">
      {/* Identity & Name Customization */}
      <section className="rounded-2xl bg-white dark:bg-[#121E1C] border border-slate-200/80 dark:border-emerald-950/70 p-6 sm:p-8">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div>
            <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <Sparkles className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
              <span>دستیار شخصی صوتی و هوشمند روی گوشی {selfName}</span>
            </div>
            <h1 className="mt-2 text-2xl sm:text-3xl font-extrabold text-slate-900 dark:text-white text-balance">
              سلام {selfName} عزیز، من «{assistantName}» هستم
            </h1>
            <p className="mt-1.5 text-sm leading-7 text-slate-600 dark:text-slate-300 max-w-2xl">
              با صدای خودت یا تایپ فرمان بگو: ساعت چنده، به {partnerOtherName} پیامک بده، تماس بگیر یا قطع کن، عکس و فیلم بگیر، صدا ضبط کن، سایلنت/ویبره بگذار یا هر سوالی بپرس.
            </p>
          </div>

          <form onSubmit={handleSaveAssistantName} className="flex flex-col sm:flex-row gap-2.5 shrink-0">
            <div>
              <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
                نام دلخواه دستیار
              </label>
              <input
                type="text"
                value={assistantNameDraft}
                onChange={(e) => setAssistantNameDraft(e.target.value)}
                placeholder="مثلاً: آوا، نگار، سارا"
                className="w-full sm:w-44 min-h-[44px] rounded-xl border border-slate-200 dark:border-emerald-950 bg-slate-50 dark:bg-[#0D1614] px-3.5 text-sm font-semibold text-slate-900 dark:text-white focus:outline-none focus:border-emerald-700"
              />
            </div>
            <button
              type="submit"
              className="sm:self-end min-h-[44px] px-4 rounded-xl bg-slate-900 hover:bg-slate-800 dark:bg-emerald-700 dark:hover:bg-emerald-600 text-white text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
            >
              {nameSavedFlash ? <Check className="w-4 h-4" /> : null}
              <span>{nameSavedFlash ? 'ذخیره شد' : 'ثبت نام دستیار'}</span>
            </button>
          </form>
        </div>

        {/* Wake-word & Microphone Controls */}
        <div className="mt-6 pt-5 border-t border-slate-100 dark:border-emerald-950/60 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleListenOnce}
              disabled={isBusy}
              className={`min-h-[52px] px-6 py-3 rounded-xl font-bold text-sm flex items-center gap-2.5 transition-colors cursor-pointer ${
                isListeningOnce
                  ? 'bg-amber-600 hover:bg-amber-700 text-white'
                  : 'bg-emerald-700 hover:bg-emerald-800 text-white'
              }`}
            >
              {isListeningOnce ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
              <span>
                {isListeningOnce
                  ? 'در حال گوش دادن... (برای توقف بزنید)'
                  : `صحبت با ${assistantName}`}
              </span>
            </button>

            {isSpeaking && (
              <button
                type="button"
                onClick={onStopSpeech}
                className="min-h-[52px] px-4 rounded-xl bg-slate-900 dark:bg-slate-800 text-white text-xs font-semibold flex items-center gap-2 cursor-pointer"
              >
                <Square className="w-4 h-4" />
                <span>توقف صحبت {assistantName}</span>
              </button>
            )}

            {isRecordingAudio && (
              <button
                type="button"
                onClick={() => executeUtterance('ضبط صدا را متوقف کن', true)}
                className="min-h-[52px] px-4 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold flex items-center gap-2 cursor-pointer"
              >
                <Square className="w-4 h-4" />
                <span>توقف و ذخیره ضبط صدا</span>
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={handleToggleWakeWord}
            className={`min-h-[44px] px-4 py-2.5 rounded-xl border text-xs font-semibold flex items-center gap-2 transition-colors cursor-pointer ${
              wakeLoopEnabled
                ? 'border-emerald-700 bg-emerald-50 text-emerald-900 dark:border-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-200'
                : 'border-slate-200 dark:border-emerald-950 text-slate-700 dark:text-slate-300'
            }`}
          >
            <Mic className="w-4 h-4" />
            <span>
              {wakeLoopEnabled
                ? isWakeListening
                  ? `گوش‌به‌زنگ صدای «${assistantName}» روشن است...`
                  : `گوش‌به‌زنگ «${assistantName}» آماده است`
                : `گوش‌به‌زنگ صدا زدن «${assistantName}»`}
            </span>
          </button>
        </div>

        {nativeCaps.isNative && (!nativeCaps.microphone || !nativeCaps.sms || !nativeCaps.callPhone) && (
          <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">
            نکته: برای اجرای کامل دستورات صوتی روی گوشی (میکروفون، تماس، پیامک، سایلنت)، در تب «تنظیم و نصب» دکمه اعطای مجوزهای اندروید را یک بار بزنید.
          </p>
        )}
      </section>

      {/* Pending Multi-Turn SMS Prompt Banner */}
      {pendingIntent && (
        <section className="rounded-2xl bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-800/70 p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="text-sm text-amber-950 dark:text-amber-100">
            {pendingIntent.type === 'awaiting_sms_confirmation' ? (
              <>
                <strong>بررسی نهایی پیامک</strong>
                <div className="mt-2">گیرنده: <b>{pendingIntent.targetName}</b></div>
                <div className="mt-1 break-words">شماره: <b dir="ltr">{pendingIntent.targetPhone || 'نامشخص'}</b></div>
                <div className="mt-1 whitespace-pre-wrap">متن پیام: «{pendingIntent.smsBody}»</div>
                <div className="mt-2 font-semibold">فقط اگر همه موارد درست است، تأیید و ارسال را بزن.</div>
              </>
            ) : pendingIntent.type === 'awaiting_sms_body' ? (
              <>
                <strong>در انتظار متن پیامک به {pendingIntent.targetName}:</strong>{' '}
                متن پیامک را بگو یا تایپ کن؛ قبل از ارسال تأیید نهایی می‌گیری.
              </>
            ) : (
              <>
                <strong>در انتظار نام مخاطب برای پیامک:</strong> نام شخص مورد نظر را بگویید یا بنویسید.
              </>
            )}
          </div>
          <div className="flex flex-wrap gap-2 shrink-0">
            {pendingIntent.type === 'awaiting_sms_confirmation' && <button type="button" onClick={() => executeUtterance('تأیید ارسال پیامک', false)} className="min-h-[44px] px-4 rounded-xl bg-green-600 text-white text-xs font-semibold cursor-pointer">تأیید و ارسال</button>}
            <button type="button" onClick={() => { setPendingIntent(null); appendMessage('assistant', 'ارسال پیامک لغو شد.'); }} className="min-h-[44px] px-4 rounded-xl border border-amber-400 dark:border-amber-700 text-xs font-semibold text-amber-900 dark:text-amber-200 cursor-pointer shrink-0">لغو پیامک</button>
          </div>
        </section>
      )}

      {/* Main Split: Conversation + Quick Commands */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Chat & Command Input */}
        <section className="lg:col-span-7 rounded-2xl bg-white dark:bg-[#121E1C] border border-slate-200/80 dark:border-emerald-950/70 p-5 sm:p-6 flex flex-col justify-between gap-4">
          <div className="flex items-center justify-between border-b border-slate-100 dark:border-emerald-950/60 pb-3">
            <h2 className="text-base font-bold text-slate-900 dark:text-white">
              گفت‌وگو و اجرای دستورات «{assistantName}»
            </h2>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {toPersianDigits(syncedContacts.length)} مخاطب همگام‌شده برای تماس و پیامک
            </span>
          </div>

          <div className="space-y-3 max-h-[380px] overflow-y-auto pr-1">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.sender === 'user' ? 'justify-start' : 'justify-end'}`}
              >
                <div
                  className={`max-w-[90%] rounded-2xl px-4 py-3 text-sm leading-7 ${
                    msg.sender === 'user'
                      ? 'bg-emerald-700 text-white'
                      : 'bg-slate-50 dark:bg-[#0E1715] border border-slate-200/80 dark:border-emerald-950/70 text-slate-900 dark:text-slate-100'
                  }`}
                >
                  <p>{msg.text}</p>

                  {msg.downloadUrl && (
                    <div className="mt-2.5 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => handleDownloadLink(msg.downloadUrl!, msg.downloadTitle)}
                        className="min-h-[40px] px-3 py-1.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>دانلود در گوشی</span>
                      </button>
                      <a
                        href={msg.downloadUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="min-h-[40px] px-3 py-1.5 rounded-xl border border-slate-300 dark:border-emerald-800 text-slate-800 dark:text-slate-100 text-xs font-semibold flex items-center gap-1.5"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                        <span>باز کردن لینک</span>
                      </a>
                    </div>
                  )}

                  {msg.links && msg.links.length > 0 && (
                    <div className="mt-2.5 pt-2.5 border-t border-slate-200/70 dark:border-emerald-950/60 space-y-1.5">
                      <div className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                        نتایج و لینک‌های یافت‌شده از اینترنت:
                      </div>
                      {msg.links.map((lk) => (
                        <div
                          key={lk.url}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white dark:bg-[#121E1C] border border-slate-200/70 dark:border-emerald-950/60 px-2.5 py-1.5 text-xs"
                        >
                          <a
                            href={lk.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-emerald-700 dark:text-emerald-400 font-medium hover:underline truncate max-w-[200px] sm:max-w-[260px]"
                          >
                            {lk.title}
                          </a>
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleDownloadLink(lk.url, lk.title)}
                              className="px-2 py-1 rounded-lg bg-slate-900 dark:bg-emerald-800 text-white text-[11px] font-medium flex items-center gap-1 cursor-pointer"
                            >
                              <Download className="w-3 h-3" />
                              <span>دانلود</span>
                            </button>
                            <a
                              href={lk.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="px-2 py-1 rounded-lg border border-slate-200 dark:border-emerald-900 text-[11px] text-slate-700 dark:text-slate-200 flex items-center gap-1"
                            >
                              <ExternalLink className="w-3 h-3" />
                              <span>مشاهده</span>
                            </a>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div
                    className={`mt-1.5 flex items-center justify-between gap-3 text-[11px] ${
                      msg.sender === 'user' ? 'text-emerald-100' : 'text-slate-400 dark:text-slate-500'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span>{msg.sender === 'user' ? selfName : assistantName}</span>
                      {msg.sender === 'assistant' && (
                        <button
                          type="button"
                          onClick={() => onSpeakText(msg.text, `پاسخ ${assistantName}`, 'custom')}
                          title="خواندن دستی این پاسخ با صدای فارسی"
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg border border-slate-200 dark:border-emerald-900 bg-white dark:bg-[#121E1C] text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 cursor-pointer"
                        >
                          <Volume2 className="w-3 h-3" />
                          <span>خواندن</span>
                        </button>
                      )}
                    </div>
                    {msg.action && ACTION_LABELS[msg.action] && (
                      <span className="font-medium text-emerald-700 dark:text-emerald-400">
                        · {ACTION_LABELS[msg.action]}
                      </span>
                    )}
                    <span>{msg.timestamp}</span>
                  </div>
                </div>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>

          <form onSubmit={handleTextSubmit} className="flex gap-2 pt-2 border-t border-slate-100 dark:border-emerald-950/60">
            <input
              type="text"
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              placeholder={
                pendingIntent?.type === 'awaiting_sms_body'
                  ? `متن پیامک به ${pendingIntent.targetName} را بنویسید...`
                  : `مثلاً: ${assistantName} ساعت چنده؟ یا به ${partnerOtherName} پیامک بده...`
              }
              className="flex-1 min-h-[46px] rounded-xl border border-slate-200 dark:border-emerald-950 bg-slate-50 dark:bg-[#0D1614] px-3.5 text-sm text-slate-900 dark:text-white focus:outline-none focus:border-emerald-700"
            />
            <button
              type="submit"
              disabled={isBusy || !textInput.trim()}
              className="min-h-[46px] px-4 rounded-xl bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white text-sm font-semibold flex items-center gap-1.5 cursor-pointer shrink-0"
            >
              <Send className="w-4 h-4" />
              <span>اجرا</span>
            </button>
          </form>
        </section>

        {/* Quick Command Buttons */}
        <section className="lg:col-span-5 rounded-2xl bg-white dark:bg-[#121E1C] border border-slate-200/80 dark:border-emerald-950/70 p-5 sm:p-6 space-y-4">
          <div>
            <h2 className="text-base font-bold text-slate-900 dark:text-white">
              دستورهای فوری تک‌ضربه‌ای
            </h2>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              هر دستور را می‌توانید با صدا، تایپ یا لمس مستقیم اجرا کنید.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            {quickCommands.map((qc) => {
              const Icon = qc.icon;
              return (
                <button
                  key={qc.label}
                  type="button"
                  disabled={isBusy}
                  onClick={() => executeUtterance(qc.command, true)}
                  className="min-h-[46px] px-3 py-2.5 rounded-xl border border-slate-200 dark:border-emerald-950/80 hover:border-emerald-600 dark:hover:border-emerald-700 bg-slate-50/70 dark:bg-[#0E1715] text-xs font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-2 text-right transition-colors cursor-pointer"
                >
                  <Icon className="w-4 h-4 text-emerald-700 dark:text-emerald-400 shrink-0" />
                  <span className="truncate">{qc.label}</span>
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
};

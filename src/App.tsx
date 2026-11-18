import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {WifiOff, X} from 'lucide-react';
import {AssistantView} from './components/AssistantView';
import {CallerAnnouncerView} from './components/CallerAnnouncerView';
import {GratitudeView} from './components/GratitudeView';
import {NightAndMessagesView} from './components/NightAndMessagesView';
import {SyncSettingsView} from './components/SyncSettingsView';
import {TodayView} from './components/TodayView';
import {TopBar} from './components/TopBar';
import {VoiceLibraryView} from './components/VoiceLibraryView';
import {
  DEFAULT_CALLERS,
  DEFAULT_GOALS,
  DEFAULT_GRATITUDES,
  DEFAULT_HABITS,
  DEFAULT_SCHEDULES,
  formatJalaliFull,
  getDayPart,
  getTodayKey,
  INSTANT_ENERGY_BOOSTERS,
  OFFLINE_MORNING_MESSAGES,
} from './data/persianLibrary';
import {useBackgroundScheduler} from './hooks/useBackgroundScheduler';
import {useOnlineStatus} from './hooks/usePWAInstall';
import {apiUrl, getCloudApiBaseUrl, safeReadJsonResponse} from './services/apiConfig';
import {
  buildCallerRingtoneWav,
  getAudioClipBuffer,
  hashTextKey,
  listAudioClips,
} from './services/audioLibraryDb';
import {
  deleteCallerFromCloud,
  deleteGoalFromCloud,
  deleteGratitudeFromCloud,
  deleteHabitFromCloud,
  deleteScheduleFromCloud,
  ensureUserAndDiscoverSpace,
  invitePartnerEmail,
  joinSpaceByCode,
  pushCallerToCloud,
  pushGoalToCloud,
  pushGratitudeToCloud,
  pushHabitToCloud,
  pushScheduleToCloud,
  pushSettingsToCloud,
  subscribeToCoupleSpace,
  uploadLocalBundleToSpace,
  type CoupleSpaceInfo,
} from './services/coupleSyncService';
import {
  auth,
  checkRedirectSignIn,
  onAuthStateChanged,
  signInWithGoogleSmart,
  signOutFirebase,
} from './services/firebaseClient';
import {
  getNativeCapabilities,
  openAppInfoSettings,
  openNotificationListenerSettings,
  openXiaomiOtherPermissions,
  precacheNativeWav,
  requestNativePermissionsAndMiuiSetup,
  saveLearnedPhoneticsNative,
  setDeviceIdentityNative,
  setNativeKeepAliveService,
  syncAnnounceTogglesToNative,
  syncCallersToNative,
  syncSchedulesToNative,
  syncServerBaseUrlToNative,
  type NativeCapabilities,
} from './services/nativeAndroidBridge';
import {
  generateAndCacheGeminiWav,
  playSoftChime,
  speakFluentPersian,
  stopAllSpeech,
  unlockAudioPlayback,
} from './services/speechEngine';
import type {
  AppSettings,
  AppTab,
  AudioLibraryEntry,
  CallerContact,
  DeviceOwner,
  GoalItem,
  GratitudeEntry,
  HabitItem,
  LocalVoiceControls,
  MorningMessage,
  NightDiscoveryResponse,
  OwnerRole,
  ScheduledAnnouncement,
  SyncedPhoneContact,
} from './types/app';
import {
  adaptTextForDevice,
  getOrderedPairNames,
  getPartnerNameForDevice,
  getSelfName,
  readDeviceOwner,
  readLocalVoiceControls,
  refreshAppShell,
  writeDeviceOwner,
  writeLocalVoiceControls,
} from './utils/deviceIdentity';

const STORAGE_KEYS = {
  goals: 'rmz_goals_v1',
  habits: 'rmz_habits_v1',
  gratitudes: 'rmz_gratitudes_v1',
  callers: 'rmz_callers_v1',
  syncedContacts: 'rmz_synced_contacts_v1',
  settings: 'rmz_settings_v1',
  morningMsg: 'rmz_morning_msg_v1',
  schedules: 'rmz_schedules_v1',
  nightMovies: 'rmz_night_movies_v1',
  nightMusic: 'rmz_night_music_v1',
  triggeredAuto: 'rmz_triggered_auto_v1',
};

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  defaultVoice: 'Kore',
  speechRate: 1,
  myName: 'من',
  partnerName: 'همراه',
  assistantName: 'هم‌صدا',
  assistantWakeWordEnabled: false,
  backgroundKeepAlive: false,
  announceCalls: true,
  announceSms: true,
  autoOpenMorning: true,
  nightMovieAutoCheck: true,
  nightMovieTime: '22:00',
};

function readJsonStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export default function App() {
  const isOnline = useOnlineStatus();
  const [activeTab, setActiveTab] = useState<AppTab>('today');

  const [assistantMediaTrigger, setAssistantMediaTrigger] = useState<{
    tab: 'tracks' | 'radio';
    query?: string;
    nonce: number;
  } | null>(null);

  const [settings, setSettings] = useState<AppSettings>(() => {
    const saved = readJsonStorage<Partial<AppSettings>>(STORAGE_KEYS.settings, {});
    const normalizedMyName =
      typeof saved.myName === 'string' && saved.myName.trim() && saved.myName.trim() !== 'مهدی' && saved.myName.trim() !== 'بهمن'
        ? saved.myName.trim()
        : 'من';
    const normalizedPartnerName =
      typeof saved.partnerName === 'string' && saved.partnerName.trim() && saved.partnerName.trim() !== 'زری'
        ? saved.partnerName.trim()
        : 'همراه';
    const normalizedAssistantName =
      typeof saved.assistantName === 'string' && saved.assistantName.trim() && !['بهمن', 'زری', 'آوا'].includes(saved.assistantName.trim())
        ? saved.assistantName.trim()
        : 'هم‌صدا';
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      defaultVoice: 'Kore',
      myName: normalizedMyName,
      partnerName: normalizedPartnerName,
      assistantName: normalizedAssistantName,
    };
  });

  const [goals, setGoals] = useState<GoalItem[]>(() =>
    readJsonStorage<GoalItem[]>(STORAGE_KEYS.goals, DEFAULT_GOALS)
  );
  const [habits, setHabits] = useState<HabitItem[]>(() =>
    readJsonStorage<HabitItem[]>(STORAGE_KEYS.habits, DEFAULT_HABITS)
  );
  const [gratitudes, setGratitudes] = useState<GratitudeEntry[]>(() =>
    readJsonStorage<GratitudeEntry[]>(STORAGE_KEYS.gratitudes, DEFAULT_GRATITUDES)
  );
  const [callers, setCallers] = useState<CallerContact[]>(() =>
    readJsonStorage<CallerContact[]>(STORAGE_KEYS.callers, DEFAULT_CALLERS)
  );
  const [syncedContacts, setSyncedContacts] = useState<SyncedPhoneContact[]>(() =>
    readJsonStorage<SyncedPhoneContact[]>(STORAGE_KEYS.syncedContacts, [])
  );
  const [schedules, setSchedules] = useState<ScheduledAnnouncement[]>(() =>
    readJsonStorage<ScheduledAnnouncement[]>(STORAGE_KEYS.schedules, DEFAULT_SCHEDULES)
  );

  const [morningMessage, setMorningMessage] = useState<MorningMessage>(() => {
    const saved = readJsonStorage<MorningMessage | null>(STORAGE_KEYS.morningMsg, null);
    if (saved) return saved;
    const part = getDayPart();
    return OFFLINE_MORNING_MESSAGES.find((m) => m.dayPart === part) ?? OFFLINE_MORNING_MESSAGES[0];
  });

  const [nightMoviesResult, setNightMoviesResult] = useState<NightDiscoveryResponse | null>(() =>
    readJsonStorage<NightDiscoveryResponse | null>(STORAGE_KEYS.nightMovies, null)
  );
  const [nightMusicResult, setNightMusicResult] = useState<NightDiscoveryResponse | null>(() =>
    readJsonStorage<NightDiscoveryResponse | null>(STORAGE_KEYS.nightMusic, null)
  );
  const [triggeredAutoMap, setTriggeredAutoMap] = useState<Record<string, string>>(() =>
    readJsonStorage<Record<string, string>>(STORAGE_KEYS.triggeredAuto, {})
  );

  const [audioClips, setAudioClips] = useState<AudioLibraryEntry[]>([]);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [speechSourceLabel, setSpeechSourceLabel] = useState('');
  const [isGeneratingAi, setIsGeneratingAi] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Cloud Sync state
  const [cloudUserEmail, setCloudUserEmail] = useState<string | null>(null);
  const [cloudBusy, setCloudBusy] = useState(false);
  const [spaceInfo, setSpaceInfo] = useState<CoupleSpaceInfo | null>(null);

  // Native Android state
  const [nativeCaps, setNativeCaps] = useState<NativeCapabilities>({
    isNative: false,
    phoneState: false,
    callLog: false,
    contacts: false,
    sms: false,
    notificationListener: false,
    notifications: false,
    batteryIgnored: false,
    overlay: false,
    keepAliveRunning: false,
    exactAlarm: false,
  });

  const [deviceOwner, setDeviceOwner] = useState<DeviceOwner>(() => readDeviceOwner());
  const [localVoiceControls, setLocalVoiceControls] = useState<LocalVoiceControls>(() =>
    readLocalVoiceControls()
  );

  const selfName = useMemo(() => getSelfName(settings, deviceOwner), [settings, deviceOwner]);
  const orderedPairNames = useMemo(
    () => getOrderedPairNames(settings, deviceOwner),
    [settings, deviceOwner]
  );

  const showToast = useCallback((msg: string) => {
    setToast(msg);
  }, []);

  const handleChangeDeviceOwner = useCallback(
    (owner: DeviceOwner) => {
      setDeviceOwner(owner);
      writeDeviceOwner(owner);
      showToast(
        owner === 'zari'
          ? 'هویت این گوشی برای کاربر دوم ذخیره شد.'
          : 'هویت این گوشی برای کاربر اول ذخیره شد.'
      );
    },
    [showToast]
  );

  const handleUpdateLocalVoiceControls = useCallback(
    (patch: Partial<LocalVoiceControls>) => {
      setLocalVoiceControls((prev) => {
        const next = {...prev, ...patch};
        writeLocalVoiceControls(next);
        if (!next.masterSpeakerEnabled) {
          stopAllSpeech();
          setIsSpeaking(false);
        }
        return next;
      });
    },
    []
  );

  const handleToggleMasterSpeaker = useCallback(() => {
    setLocalVoiceControls((prev) => {
      const nextEnabled = !prev.masterSpeakerEnabled;
      const next = {...prev, masterSpeakerEnabled: nextEnabled};
      writeLocalVoiceControls(next);
      if (!nextEnabled) {
        stopAllSpeech();
        setIsSpeaking(false);
        showToast(
          `سخنگوی خودکار روی گوشی ${getSelfName(settings, deviceOwner)} خاموش شد (حالت دستی فعال است).`
        );
      } else {
        showToast(`سخنگوی خودکار روی گوشی ${getSelfName(settings, deviceOwner)} دوباره روشن شد.`);
      }
      return next;
    });
  }, [deviceOwner, settings, showToast]);

  const handleRefreshApp = useCallback(() => {
    showToast('در حال بروزرسانی برنامه...');
    void refreshAppShell();
  }, [showToast]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
    syncAnnounceTogglesToNative({
      announceCalls:
        settings.announceCalls &&
        localVoiceControls.masterSpeakerEnabled &&
        localVoiceControls.autoCallAnnounce,
      announceSms:
        settings.announceSms &&
        localVoiceControls.masterSpeakerEnabled &&
        localVoiceControls.autoSmsAnnounce,
      announceSchedules:
        localVoiceControls.masterSpeakerEnabled && localVoiceControls.autoScheduleAnnounce,
      autoOpenMorning: settings.autoOpenMorning,
      defaultVoice: settings.defaultVoice,
    });
  }, [settings, localVoiceControls]);

  useEffect(() => {
    setDeviceIdentityNative({
      deviceOwner,
      selfName: getSelfName(settings, deviceOwner),
      partnerName: getPartnerNameForDevice(settings, deviceOwner),
      assistantName: settings.assistantName?.trim() || 'آوا',
    });
  }, [deviceOwner, settings.myName, settings.partnerName, settings.assistantName]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.goals, JSON.stringify(goals));
  }, [goals]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.habits, JSON.stringify(habits));
  }, [habits]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.gratitudes, JSON.stringify(gratitudes));
  }, [gratitudes]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.callers, JSON.stringify(callers));
    syncCallersToNative(callers);
    callers.forEach((c) => {
      const names = c.persianPhonetic?.trim()
        ? Array.from(new Set([c.name, c.persianPhonetic.trim()]))
        : [c.name];
      names.forEach((n) => {
        const script = c.template.replace('{name}', n);
        const id = hashTextKey(script, c.voiceName);
        getAudioClipBuffer(id)
          .then((buf) => {
            if (buf) precacheNativeWav(script, c.voiceName, buf);
          })
          .catch(() => {});
      });
    });
  }, [callers]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.syncedContacts, JSON.stringify(syncedContacts));
    if (syncedContacts.length > 0) {
      const map: Record<string, string> = {};
      for (const c of syncedContacts) {
        if (c.name.trim() && c.persianPhonetic.trim()) {
          map[c.name.trim().toLowerCase()] = c.persianPhonetic.trim();
        }
      }
      saveLearnedPhoneticsNative(map);
    }
  }, [syncedContacts]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.morningMsg, JSON.stringify(morningMessage));
  }, [morningMessage]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.schedules, JSON.stringify(schedules));
  }, [schedules]);

  useEffect(() => {
    if (nightMoviesResult) localStorage.setItem(STORAGE_KEYS.nightMovies, JSON.stringify(nightMoviesResult));
  }, [nightMoviesResult]);

  useEffect(() => {
    if (nightMusicResult) localStorage.setItem(STORAGE_KEYS.nightMusic, JSON.stringify(nightMusicResult));
  }, [nightMusicResult]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.triggeredAuto, JSON.stringify(triggeredAutoMap));
  }, [triggeredAutoMap]);

  // Check native Android capabilities and sync server URL on mount and when returning from Settings
  useEffect(() => {
    getNativeCapabilities().then(setNativeCaps);
    syncServerBaseUrlToNative(getCloudApiBaseUrl());
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        getNativeCapabilities().then(setNativeCaps);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Firebase Auth listener + automatic space discovery & real-time sync
  useEffect(() => {
    checkRedirectSignIn().catch(() => {});
    let unsubSpace: (() => void) | null = null;

    const unsubAuth = onAuthStateChanged(auth, async (user) => {
      if (unsubSpace) {
        unsubSpace();
        unsubSpace = null;
      }

      if (!user) {
        setCloudUserEmail(null);
        setSpaceInfo(null);
        return;
      }

      setCloudUserEmail(user.email ?? user.uid);
      setCloudBusy(true);
      try {
        const discovered = await ensureUserAndDiscoverSpace(user);
        setSpaceInfo(discovered);
        unsubSpace = subscribeToCoupleSpace(discovered.spaceId, {
          onSpaceMeta: (partnerEmail) => {
            setSpaceInfo((prev) => (prev ? {...prev, partnerEmail} : prev));
          },
          onGoals: (cloudGoals) => setGoals(cloudGoals),
          onHabits: (cloudHabits) => setHabits(cloudHabits),
          onGratitudes: (cloudGratitudes) => setGratitudes(cloudGratitudes),
          onCallers: (cloudCallers) => setCallers(cloudCallers),
          onSchedules: (cloudSchedules) => setSchedules(cloudSchedules),
          onSettings: (cloudSettings) =>
            setSettings((prev) => ({
              ...DEFAULT_SETTINGS,
              ...prev,
              ...cloudSettings,
              myName: cloudSettings.myName === 'مهدی' || cloudSettings.myName === 'بهمن' ? 'من' : cloudSettings.myName || 'من',
              partnerName: cloudSettings.partnerName === 'زری' ? 'همراه' : cloudSettings.partnerName || prev.partnerName || 'همراه',
              assistantName: cloudSettings.assistantName?.trim() && !['بهمن', 'زری', 'آوا'].includes(cloudSettings.assistantName.trim()) ? cloudSettings.assistantName.trim() : 'هم‌صدا',
            })),
          onError: (msg) => console.warn('Cloud sync listener notice:', msg),
        });
      } catch (err) {
        console.warn('Cloud discovery error:', err);
        showToast('ورود انجام شد، اما بارگذاری فضای مشترک ابری با تاخیر مواجه شد؛ داده‌های گوشی شما فعال هستند.');
      } finally {
        setCloudBusy(false);
      }
    });

    return () => {
      unsubAuth();
      if (unsubSpace) unsubSpace();
    };
  }, [showToast]);

  const refreshClips = useCallback(async () => {
    try {
      const items = await listAudioClips();
      setAudioClips(items);
    } catch {
      // IndexedDB unavailable fallback
    }
  }, []);

  useEffect(() => {
    refreshClips();
  }, [refreshClips]);

  const handleSpeakText = useCallback(
    async (text: string, title: string, category: AudioLibraryEntry['category']) => {
      setIsSpeaking(true);
      setSpeechSourceLabel('در حال آماده‌سازی صدای روان فارسی...');
      await speakFluentPersian({
        text,
        title,
        category,
        voiceName: settings.defaultVoice,
        rate: settings.speechRate,
        onLoading: () => setSpeechSourceLabel('در حال تولید صدای روان فارسی...'),
        onStart: (src) => {
          if (src === 'cache') setSpeechSourceLabel('پخش از کتابخانه آفلاین');
          else if (src === 'gemini') setSpeechSourceLabel('صدای روان فارسی (ذخیره برای آفلاین شد)');
          else if (src === 'neural-fallback')
            setSpeechSourceLabel('صدای کمکی موقت (سهمیه استودیویی امروز پر شده)');
          else setSpeechSourceLabel('پخش با موتور گفتار آفلاین');
        },
        onEnd: () => {
          setIsSpeaking(false);
          refreshClips();
        },
        onError: (msg) => {
          setIsSpeaking(false);
          setSpeechSourceLabel('');
          showToast(msg);
        },
      });
    },
    [settings.defaultVoice, settings.speechRate, refreshClips, showToast]
  );

  const handleStopSpeech = useCallback(() => {
    stopAllSpeech();
    setIsSpeaking(false);
  }, []);

  const buildScheduleText = useCallback(
    (schedule: ScheduledAnnouncement): string => {
      if (schedule.topic === 'custom' && schedule.customText?.trim()) {
        return adaptTextForDevice(schedule.customText.trim(), settings, deviceOwner);
      }
      if (schedule.topic === 'night_movies') {
        return `وقت پیشنهاد فیلم و سریال دوبله امشب برای ${orderedPairNames} رسید! در تب شبانه و پیام‌ساز می‌توانید لیست آثار امتیاز بالا را ببینید.`;
      }
      if (schedule.topic === 'morning') {
        const morningPool = OFFLINE_MORNING_MESSAGES.filter((m) => m.dayPart === 'morning');
        const msg = morningMessage.dayPart === 'morning' ? morningMessage : (morningPool[0] ?? morningMessage);
        const rawText = `سلام ${orderedPairNames}! ${msg.title}. ${msg.message} ${msg.affirmation}`;
        return adaptTextForDevice(rawText, settings, deviceOwner);
      }
      if (schedule.topic === 'goals') {
        const pending = goals.filter((g) => g.dateKey === getTodayKey() && !g.completed);
        if (pending.length === 0) {
          return `آفرین ${orderedPairNames}! تمام هدف‌های ثبت‌شده امروز را انجام دادید. وقت استراحت و شکرگذاری است.`;
        }
        const topTitles = pending
          .slice(0, 3)
          .map((g, idx) => `هدف ${idx + 1}: ${g.title}`)
          .join('. ');
        return `مرور هدف‌های امروز برای ${orderedPairNames}. ${topTitles}. با آرامش و تمرکز پیش بروید.`;
      }
      if (schedule.topic === 'gratitude') {
        const latest = gratitudes[0];
        if (latest) {
          return adaptTextForDevice(
            `وقت شکرگذاری و آرامش است. نمونه شکرگذاری امروز: ${latest.items[0]}. ${latest.loveNote || ''}`.trim(),
            settings,
            deviceOwner
          );
        }
        return `وقت شکرگذاری شبانه برای ${orderedPairNames}. امروز بابت چه نعمتی سپاسگزارید؟`;
      }
      const booster = INSTANT_ENERGY_BOOSTERS[new Date().getDate() % INSTANT_ENERGY_BOOSTERS.length];
      return adaptTextForDevice(`${booster.title}. ${booster.text}`, settings, deviceOwner);
    },
    [deviceOwner, goals, gratitudes, morningMessage, orderedPairNames, settings]
  );

  // Merge manual schedules + today's goal-specific reminders + nightly auto movie alert
  const effectiveSchedules = useMemo<ScheduledAnnouncement[]>(() => {
    const today = getTodayKey();
    const goalSchedules: ScheduledAnnouncement[] = goals
      .filter((g) => g.dateKey === today && !g.completed && g.reminderTime && /^\d{2}:\d{2}$/.test(g.reminderTime))
      .map((g) => {
        const id = `goal-rem-${g.id}`;
        const scopeWord = g.scope === 'work' ? 'کاری' : 'خانه';
        const ownerWord =
          g.owner === 'man'
            ? settings.myName
            : g.owner === 'zari'
              ? settings.partnerName
              : `${settings.myName} و ${settings.partnerName}`;
        return {
          id,
          title: `یادآور برنامه ${scopeWord}: ${g.title}`,
          topic: 'custom',
          time: g.reminderTime!,
          enabled: true,
          voiceName: g.reminderVoice ?? settings.defaultVoice,
          customText: `یادآور برنامه برای ${ownerWord}: ${g.title}`,
          days: 'daily',
          lastTriggeredDate: triggeredAutoMap[id],
        };
      });

    const extras: ScheduledAnnouncement[] = [];
    if (settings.nightMovieAutoCheck && /^\d{2}:\d{2}$/.test(settings.nightMovieTime)) {
      const id = 'auto-night-movies';
      extras.push({
        id,
        title: 'پیشنهاد خودکار فیلم و سریال دوبله امشب',
        topic: 'night_movies',
        time: settings.nightMovieTime,
        enabled: true,
        voiceName: settings.defaultVoice,
        days: 'daily',
        lastTriggeredDate: triggeredAutoMap[id],
      });
    }

    return [...schedules, ...goalSchedules, ...extras];
  }, [
    goals,
    schedules,
    settings.defaultVoice,
    settings.myName,
    settings.nightMovieAutoCheck,
    settings.nightMovieTime,
    settings.partnerName,
    triggeredAutoMap,
  ]);

  // Sync all schedules (including goal reminders & nightly check) down to native Android AlarmManager
  useEffect(() => {
    syncSchedulesToNative(effectiveSchedules, buildScheduleText, settings.autoOpenMorning);
  }, [effectiveSchedules, buildScheduleText, settings.autoOpenMorning]);

  const showNotifRef = useRef<(title: string, body: string, scheduleId: string) => Promise<void>>(
    async () => {}
  );

  const handleMarkTriggered = useCallback(
    (scheduleId: string, dateKey: string) => {
      if (scheduleId.startsWith('goal-rem-') || scheduleId === 'auto-night-movies') {
        setTriggeredAutoMap((prev) => ({...prev, [scheduleId]: dateKey}));
        return;
      }
      setSchedules((prev) => {
        const updated = prev.map((s) =>
          s.id === scheduleId ? {...s, lastTriggeredDate: dateKey} : s
        );
        const target = updated.find((s) => s.id === scheduleId);
        if (target && spaceInfo) {
          pushScheduleToCloud(spaceInfo.spaceId, target).catch(() => {});
        }
        return updated;
      });
    },
    [spaceInfo]
  );

  const handleTriggerSchedule = useCallback(
    async (schedule: ScheduledAnnouncement, isManualTest = false) => {
      stopAllSpeech();
      if (isManualTest) {
        unlockAudioPlayback();
      }
      let text = buildScheduleText(schedule);

      if (schedule.topic === 'night_movies' && isOnline) {
        try {
          const res = await fetch(apiUrl('/api/night-discover'), {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
              mode: 'movies',
              mediaType: 'both',
              moodOrGenre: 'پیشنهادهای برتر امشب با امتیاز IMDb بالای ۷.۵ و دوبله فارسی',
            }),
          });
          if (res.ok) {
            const parsed = await safeReadJsonResponse<NightDiscoveryResponse>(res);
            if (!parsed.isHtml && parsed.data) {
              setNightMoviesResult(parsed.data);
              if (parsed.data.spokenSummary) {
                text = `پیشنهاد فیلم و سریال دوبله امشب: ${parsed.data.spokenSummary}`;
              }
            }
          }
        } catch {
          // keep fallback text if network fails
        }
      }

      const category: AudioLibraryEntry['category'] =
        schedule.topic === 'morning'
          ? 'morning'
          : schedule.topic === 'gratitude'
            ? 'gratitude'
            : schedule.topic === 'energy'
              ? 'energy'
              : 'custom';

      showToast(`اعلام زمان‌بندی: ${schedule.title}`);
      await showNotifRef.current(schedule.title, text, schedule.id);

      const canAutoSpeakSchedule =
        isManualTest ||
        (localVoiceControls.masterSpeakerEnabled && localVoiceControls.autoScheduleAnnounce);
      if (!canAutoSpeakSchedule) {
        return;
      }

      await playSoftChime('chime');

      setIsSpeaking(true);
      setSpeechSourceLabel(`پخش زمان‌بندی: ${schedule.title}`);
      await speakFluentPersian({
        text,
        title: schedule.title,
        category,
        voiceName: schedule.voiceName,
        rate: settings.speechRate,
        onStart: (src) => {
          if (src === 'cache') setSpeechSourceLabel('پخش زمان‌بندی از کتابخانه آفلاین');
          else if (src === 'gemini') setSpeechSourceLabel('پخش زمان‌بندی با صدای روان فارسی');
          else if (src === 'neural-fallback')
            setSpeechSourceLabel('پخش زمان‌بندی با صدای کمکی (محدودیت سهمیه)');
          else setSpeechSourceLabel('پخش زمان‌بندی با موتور گفتار آفلاین');
        },
        onEnd: () => {
          setIsSpeaking(false);
          refreshClips();
        },
        onError: (msg) => {
          setIsSpeaking(false);
          setSpeechSourceLabel('');
          showToast(msg);
        },
      });
    },
    [
      buildScheduleText,
      isOnline,
      localVoiceControls.autoScheduleAnnounce,
      localVoiceControls.masterSpeakerEnabled,
      refreshClips,
      settings.speechRate,
      showToast,
    ]
  );

  const {
    notifPermission,
    keepAliveActive,
    requestNotificationPermission,
    showSystemNotification,
  } = useBackgroundScheduler({
    schedules: effectiveSchedules,
    keepAliveEnabled: settings.backgroundKeepAlive,
    onTriggerSchedule: handleTriggerSchedule,
    onMarkTriggered: handleMarkTriggered,
    onStatusToast: showToast,
  });

  showNotifRef.current = showSystemNotification;

  const handleUpdateSettings = useCallback(
    (patch: Partial<AppSettings>) => {
      setSettings((prev) => {
        const next = {...prev, ...patch};
        if (spaceInfo) {
          pushSettingsToCloud(spaceInfo.spaceId, next).catch(() => {});
        }
        return next;
      });
    },
    [spaceInfo]
  );

  const handleToggleKeepAlive = useCallback(
    async (enabled: boolean) => {
      unlockAudioPlayback();
      handleUpdateSettings({backgroundKeepAlive: enabled});
      if (nativeCaps.isNative) {
        const running = await setNativeKeepAliveService(enabled);
        setNativeCaps((prev) => ({...prev, keepAliveRunning: running}));
      }
      showToast(
        enabled
          ? 'اجرای دائمی پس‌زمینه فعال شد. پیام‌ها و تماس‌ها به‌صورت خودکار اعلام می‌شوند.'
          : 'نگهدارنده پس‌زمینه غیرفعال شد.'
      );
    },
    [handleUpdateSettings, nativeCaps.isNative, showToast]
  );

  const handleAddSchedule = useCallback(
    (item: Omit<ScheduledAnnouncement, 'id'>) => {
      const created: ScheduledAnnouncement = {...item, id: `sch-${Date.now()}`};
      setSchedules((prev) => [created, ...prev]);
      if (spaceInfo) {
        pushScheduleToCloud(spaceInfo.spaceId, created).catch(() => {});
      }
    },
    [spaceInfo]
  );

  const handleToggleSchedule = useCallback(
    (id: string) => {
      setSchedules((prev) => {
        const next = prev.map((s) => (s.id === id ? {...s, enabled: !s.enabled} : s));
        const target = next.find((s) => s.id === id);
        if (target && spaceInfo) {
          pushScheduleToCloud(spaceInfo.spaceId, target).catch(() => {});
        }
        return next;
      });
    },
    [spaceInfo]
  );

  const handleUpdateSchedule = useCallback(
    (id: string, patch: Partial<ScheduledAnnouncement>) => {
      setSchedules((prev) => {
        const next = prev.map((s) => (s.id === id ? {...s, ...patch} : s));
        const target = next.find((s) => s.id === id);
        if (target && spaceInfo) {
          pushScheduleToCloud(spaceInfo.spaceId, target).catch(() => {});
        }
        return next;
      });
    },
    [spaceInfo]
  );

  const handleDeleteSchedule = useCallback(
    (id: string) => {
      setSchedules((prev) => prev.filter((s) => s.id !== id));
      if (spaceInfo) {
        deleteScheduleFromCloud(spaceInfo.spaceId, id).catch(() => {});
      }
    },
    [spaceInfo]
  );

  const handleDownloadScheduleAlarm = useCallback(
    async (schedule: ScheduledAnnouncement) => {
      const text = buildScheduleText(schedule);
      const clipId = hashTextKey(text, schedule.voiceName);
      let wavBuffer = await getAudioClipBuffer(clipId);

      if (!wavBuffer && isOnline) {
        try {
          const res = await generateAndCacheGeminiWav({
            text,
            title: schedule.title,
            category: 'morning',
            voiceName: schedule.voiceName,
            clipId,
          });
          if ('buffer' in res) {
            wavBuffer = res.buffer;
            refreshClips();
          }
        } catch {
          // Fall back to chime-only WAV if online generation fails
        }
      }

      const blob = await buildCallerRingtoneWav(wavBuffer, 'chime', 1);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `alarm-${schedule.topic}-${schedule.time.replace(':', '-')}.wav`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      showToast(
        wavBuffer
          ? 'فایل زنگ صوتی فارسی (.wav) ساخته و دانلود شد؛ می‌توانید آن را در ساعت گوشی شیائومی تنظیم کنید.'
          : 'فایل زنگ ملودی (.wav) دانلود شد (به دلیل محدودیت سهمیه سرور/آفلاین بودن، نسخه ملودی ساخته شد).'
      );
    },
    [buildScheduleText, isOnline, refreshClips, showToast]
  );

  const handleCloudSignIn = async () => {
    setCloudBusy(true);
    try {
      await signInWithGoogleSmart();
      showToast('ورود انجام شد. فضای مشترک هم‌صدا همگام‌سازی می‌شود.');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'خطا در ورود با گوگل');
    } finally {
      setCloudBusy(false);
    }
  };

  const handleCloudSignOut = async () => {
    setCloudBusy(true);
    try {
      await signOutFirebase();
      showToast('از حساب همگام‌سازی خارج شدید. داده‌های محلی همچنان در گوشی باقی هستند.');
    } finally {
      setCloudBusy(false);
    }
  };

  const handleInvitePartner = async (email: string) => {
    if (!spaceInfo) return;
    setCloudBusy(true);
    try {
      await invitePartnerEmail(spaceInfo.spaceId, email);
      showToast(`ایمیل ${email} به فضای مشترک اضافه شد. وقتی همراهتان با این جیمیل وارد شود، به‌صورت خودکار متصل می‌شوید.`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'خطا در ثبت ایمیل همراه');
    } finally {
      setCloudBusy(false);
    }
  };

  const handleJoinSpaceByCode = async (spaceCode: string) => {
    if (!auth.currentUser) return;
    setCloudBusy(true);
    try {
      const joined = await joinSpaceByCode(spaceCode, auth.currentUser);
      setSpaceInfo(joined);
      showToast('به فضای مشترک متصل شدید! داده‌ها به‌صورت لحظه‌ای همگام می‌شوند.');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'امکان اتصال با این کد وجود نداشت.');
    } finally {
      setCloudBusy(false);
    }
  };

  const handlePushLocalToCloud = async () => {
    if (!spaceInfo) return;
    setCloudBusy(true);
    try {
      await uploadLocalBundleToSpace(spaceInfo.spaceId, {
        goals,
        habits,
        gratitudes,
        callers,
        schedules,
        settings,
      });
      showToast('تمام داده‌ها و تنظیمات این گوشی به فضای مشترک ارسال شد.');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'خطا در ارسال به ابر');
    } finally {
      setCloudBusy(false);
    }
  };

  const handleRequestNativePermissions = async () => {
    const updated = await requestNativePermissionsAndMiuiSetup();
    if (updated) {
      setNativeCaps(updated);
      showToast('درخواست مجوزهای تماس، باتری بدون محدودیت و Autostart ارسال شد.');
    }
  };

  const handleOpenNotificationListenerSettings = async () => {
    const ok = await openNotificationListenerSettings();
    if (!ok) {
      showToast('تنظیمات دسترسی اعلان‌ها فقط در نسخه اندروید (APK) در دسترس است.');
    }
  };

  const handleOpenAppInfoSettings = async () => {
    const ok = await openAppInfoSettings();
    if (!ok) {
      showToast('تنظیمات برنامه فقط در نسخه اندروید (APK) در دسترس است.');
    }
  };

  const handleOpenXiaomiOtherPermissions = async () => {
    const ok = await openXiaomiOtherPermissions();
    if (!ok) {
      showToast('بخش مجوزهای دیگر شیائومی فقط در نسخه اندروید (APK) در دسترس است.');
    }
  };

  const handleCycleOfflineMessage = () => {
    const idx = OFFLINE_MORNING_MESSAGES.findIndex((m) => m.id === morningMessage.id);
    const next = OFFLINE_MORNING_MESSAGES[(idx + 1) % OFFLINE_MORNING_MESSAGES.length];
    setMorningMessage(next);
  };

  const handleGenerateAiMessage = async () => {
    if (!isOnline) {
      showToast('برای تولید پیام تازه به اینترنت نیاز است؛ می‌توانید از پیام‌های کتابخانه آفلاین استفاده کنید.');
      return;
    }
    setIsGeneratingAi(true);
    try {
      const todayGoalsText = goals
        .filter((g) => g.dateKey === getTodayKey())
        .slice(0, 3)
        .map((g) => g.title)
        .join('، ');

      const res = await fetch(apiUrl('/api/morning-message'), {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          dayPart: getDayPart(),
          mood: 'هدفمند، سپاسگزار و پرانرژی',
          goalsSummary: todayGoalsText,
          recipient: orderedPairNames,
        }),
      });
      const parsed = await safeReadJsonResponse<{
        title?: string;
        message?: string;
        affirmation?: string;
        energyTip?: string;
        error?: string;
      }>(res);
      if (parsed.isHtml || !parsed.data || !res.ok) {
        throw new Error(parsed.data?.error || 'خطا در دریافت پیام');
      }
      const data = parsed.data;

      setMorningMessage({
        id: `ai-${Date.now()}`,
        dayPart: getDayPart(),
        title: data.title || `پیام روز ${orderedPairNames}`,
        message: data.message || '',
        affirmation: data.affirmation || '',
        energyTip: data.energyTip || '',
        isAiGenerated: true,
      });
      showToast('پیام تازه و اختصاصی برای امروز آماده شد.');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'امکان دریافت پیام هوشمند نبود.');
    } finally {
      setIsGeneratingAi(false);
    }
  };

  const handleAddGoal = (input: Omit<GoalItem, 'id' | 'createdAt' | 'completed' | 'dateKey'>) => {
    const newGoal: GoalItem = {
      ...input,
      id: `g-${Date.now()}`,
      completed: false,
      dateKey: getTodayKey(),
      createdAt: Date.now(),
    };
    setGoals((prev) => [newGoal, ...prev]);
    if (spaceInfo) {
      pushGoalToCloud(spaceInfo.spaceId, newGoal).catch(() => {});
    }
  };

  const handleToggleGoal = (id: string) => {
    setGoals((prev) => {
      const next = prev.map((g) => (g.id === id ? {...g, completed: !g.completed} : g));
      const target = next.find((g) => g.id === id);
      if (target && spaceInfo) {
        pushGoalToCloud(spaceInfo.spaceId, target).catch(() => {});
      }
      return next;
    });
  };

  const handleDeleteGoal = (id: string) => {
    setGoals((prev) => prev.filter((g) => g.id !== id));
    if (spaceInfo) {
      deleteGoalFromCloud(spaceInfo.spaceId, id).catch(() => {});
    }
  };

  const handleToggleHabitDate = (habitId: string, dateKey: string) => {
    setHabits((prev) => {
      const next = prev.map((h) => {
        if (h.id !== habitId) return h;
        const exists = h.completedDates.includes(dateKey);
        return {
          ...h,
          completedDates: exists
            ? h.completedDates.filter((d) => d !== dateKey)
            : [...h.completedDates, dateKey],
        };
      });
      const target = next.find((h) => h.id === habitId);
      if (target && spaceInfo) {
        pushHabitToCloud(spaceInfo.spaceId, target).catch(() => {});
      }
      return next;
    });
  };

  const handleAddHabit = (title: string, owner: OwnerRole) => {
    const item: HabitItem = {
      id: `h-${Date.now()}`,
      title,
      owner,
      completedDates: [],
    };
    setHabits((prev) => [...prev, item]);
    if (spaceInfo) {
      pushHabitToCloud(spaceInfo.spaceId, item).catch(() => {});
    }
  };

  const handleDeleteHabit = (id: string) => {
    setHabits((prev) => prev.filter((h) => h.id !== id));
    if (spaceInfo) {
      deleteHabitFromCloud(spaceInfo.spaceId, id).catch(() => {});
    }
  };

  const handleAddGratitude = (
    input: Omit<GratitudeEntry, 'id' | 'createdAt' | 'dateKey' | 'jalaliDate'>
  ) => {
    const entry: GratitudeEntry = {
      ...input,
      id: `grat-${Date.now()}`,
      dateKey: getTodayKey(),
      jalaliDate: formatJalaliFull(new Date()),
      createdAt: Date.now(),
    };
    setGratitudes((prev) => [entry, ...prev]);
    if (spaceInfo) {
      pushGratitudeToCloud(spaceInfo.spaceId, entry).catch(() => {});
    }
    showToast('شکرگذاری امروز با موفقیت ثبت شد.');
  };

  const handleDeleteGratitude = (id: string) => {
    setGratitudes((prev) => prev.filter((g) => g.id !== id));
    if (spaceInfo) {
      deleteGratitudeFromCloud(spaceInfo.spaceId, id).catch(() => {});
    }
  };

  const handleAddCaller = (input: Omit<CallerContact, 'id'>) => {
    const created: CallerContact = {...input, id: `c-${Date.now()}`};
    setCallers((prev) => [created, ...prev]);
    if (spaceInfo) {
      pushCallerToCloud(spaceInfo.spaceId, created).catch(() => {});
    }
  };

  const handleDeleteCaller = (id: string) => {
    setCallers((prev) => prev.filter((c) => c.id !== id));
    if (spaceInfo) {
      deleteCallerFromCloud(spaceInfo.spaceId, id).catch(() => {});
    }
  };

  const handleImportBundle = (payload: {
    goals?: GoalItem[];
    habits?: HabitItem[];
    gratitudes?: GratitudeEntry[];
    callers?: CallerContact[];
    schedules?: ScheduledAnnouncement[];
  }) => {
    if (Array.isArray(payload.goals)) {
      setGoals((prev) => {
        const ids = new Set(prev.map((x) => x.id));
        return [...payload.goals!.filter((x) => !ids.has(x.id)), ...prev];
      });
    }
    if (Array.isArray(payload.habits)) {
      setHabits((prev) => {
        const ids = new Set(prev.map((x) => x.id));
        return [...prev, ...payload.habits!.filter((x) => !ids.has(x.id))];
      });
    }
    if (Array.isArray(payload.gratitudes)) {
      setGratitudes((prev) => {
        const ids = new Set(prev.map((x) => x.id));
        return [...payload.gratitudes!.filter((x) => !ids.has(x.id)), ...prev];
      });
    }
    if (Array.isArray(payload.callers)) {
      setCallers((prev) => {
        const ids = new Set(prev.map((x) => x.id));
        return [...prev, ...payload.callers!.filter((x) => !ids.has(x.id))];
      });
    }
    if (Array.isArray(payload.schedules)) {
      setSchedules((prev) => {
        const ids = new Set(prev.map((x) => x.id));
        return [...prev, ...payload.schedules!.filter((x) => !ids.has(x.id))];
      });
    }
  };

  const quickPlayMorning = () => {
    const raw = `${morningMessage.title}. ${morningMessage.message} ${morningMessage.affirmation}`;
    const fullText = adaptTextForDevice(raw, settings, deviceOwner);
    handleSpeakText(fullText, adaptTextForDevice(morningMessage.title, settings, deviceOwner), 'morning');
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#F6F8F7] dark:bg-[#0B1312] text-slate-900 dark:text-slate-100">
      <TopBar
        activeTab={activeTab}
        deviceOwner={deviceOwner}
        selfName={selfName}
        assistantName={settings.assistantName?.trim() || 'آوا'}
        masterSpeakerEnabled={localVoiceControls.masterSpeakerEnabled}
        onToggleMasterSpeaker={handleToggleMasterSpeaker}
        onRefreshApp={handleRefreshApp}
        onSelectTab={setActiveTab}
        onQuickPlayMorning={quickPlayMorning}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-8 pb-24 md:pb-12">
        {activeTab === 'today' && (
          <TodayView
            goals={goals}
            habits={habits}
            morningMessage={morningMessage}
            isOnline={isOnline}
            isSpeaking={isSpeaking}
            speechSourceLabel={speechSourceLabel}
            myName={settings.myName}
            partnerName={settings.partnerName}
            deviceOwner={deviceOwner}
            defaultVoice={settings.defaultVoice}
            onChangeDefaultVoice={(voice) => handleUpdateSettings({defaultVoice: voice})}
            onAddGoal={handleAddGoal}
            onToggleGoal={handleToggleGoal}
            onDeleteGoal={handleDeleteGoal}
            onToggleHabitDate={handleToggleHabitDate}
            onAddHabit={handleAddHabit}
            onDeleteHabit={handleDeleteHabit}
            onCycleOfflineMessage={handleCycleOfflineMessage}
            onGenerateAiMessage={handleGenerateAiMessage}
            isGeneratingAi={isGeneratingAi}
            onSpeakText={handleSpeakText}
            onStopSpeech={handleStopSpeech}
          />
        )}

        {activeTab === 'assistant' && (
          <AssistantView
            settings={settings}
            deviceOwner={deviceOwner}
            isOnline={isOnline}
            isSpeaking={isSpeaking}
            callers={callers}
            syncedContacts={syncedContacts}
            morningMessage={morningMessage}
            nativeCaps={nativeCaps}
            autoSpeakReplies={
              localVoiceControls.masterSpeakerEnabled && localVoiceControls.autoAssistantSpeak
            }
            onUpdateSettings={handleUpdateSettings}
            onSpeakText={handleSpeakText}
            onStopSpeech={handleStopSpeech}
            onOpenTab={setActiveTab}
            onTriggerMedia={(tab, query) =>
              setAssistantMediaTrigger({tab, query, nonce: Date.now()})
            }
            onAddGoalTitle={(title) =>
              handleAddGoal({
                title,
                owner: deviceOwner === 'zari' ? 'zari' : 'man',
                scope: 'home',
                category: 'purpose',
                timeBlock:
                  getDayPart() === 'morning'
                    ? 'morning'
                    : getDayPart() === 'midday'
                      ? 'afternoon'
                      : 'evening',
                priority: 'normal',
              })
            }
            onStatusToast={showToast}
          />
        )}

        {activeTab === 'gratitude' && (
          <GratitudeView
            entries={gratitudes}
            myName={settings.myName}
            partnerName={settings.partnerName}
            deviceOwner={deviceOwner}
            isSpeaking={isSpeaking}
            onAddEntry={handleAddGratitude}
            onDeleteEntry={handleDeleteGratitude}
            onSpeakText={handleSpeakText}
            onStopSpeech={handleStopSpeech}
          />
        )}

        {activeTab === 'night' && (
          <NightAndMessagesView
            settings={settings}
            deviceOwner={deviceOwner}
            isOnline={isOnline}
            isSpeaking={isSpeaking}
            nightMoviesResult={nightMoviesResult}
            nightMusicResult={nightMusicResult}
            onSaveNightResult={(res) => {
              if (res.mode === 'music') setNightMusicResult(res);
              else setNightMoviesResult(res);
            }}
            onUpdateSettings={handleUpdateSettings}
            onSpeakText={handleSpeakText}
            onStopSpeech={handleStopSpeech}
            onStatusToast={showToast}
            assistantMediaTrigger={assistantMediaTrigger}
          />
        )}

        {activeTab === 'voice' && (
          <VoiceLibraryView
            clips={audioClips}
            isOnline={isOnline}
            isSpeaking={isSpeaking}
            defaultVoice={settings.defaultVoice}
            speechRate={settings.speechRate}
            onRefreshClips={refreshClips}
            onStopSpeech={handleStopSpeech}
            onUpdateRate={(rate) => handleUpdateSettings({speechRate: rate})}
            onStatusToast={showToast}
          />
        )}

        {activeTab === 'caller' && (
          <CallerAnnouncerView
            callers={callers}
            syncedContacts={syncedContacts}
            isOnline={isOnline}
            defaultVoice={settings.defaultVoice}
            speechRate={settings.speechRate}
            announceCalls={settings.announceCalls}
            announceSms={settings.announceSms}
            settings={settings}
            deviceOwner={deviceOwner}
            onUpdateSettings={handleUpdateSettings}
            onAddCaller={handleAddCaller}
            onDeleteCaller={handleDeleteCaller}
            onSaveSyncedContacts={setSyncedContacts}
            onRefreshClips={refreshClips}
            onStatusToast={showToast}
          />
        )}

        {activeTab === 'sync' && (
          <SyncSettingsView
            settings={settings}
            deviceOwner={deviceOwner}
            onChangeDeviceOwner={handleChangeDeviceOwner}
            localVoiceControls={localVoiceControls}
            onUpdateLocalVoiceControls={handleUpdateLocalVoiceControls}
            onRefreshApp={handleRefreshApp}
            goals={goals}
            habits={habits}
            gratitudes={gratitudes}
            callers={callers}
            schedules={schedules}
            notifPermission={notifPermission}
            keepAliveActive={keepAliveActive}
            isOnline={isOnline}
            cachedClipsCount={audioClips.length}
            cloudUserEmail={cloudUserEmail}
            cloudBusy={cloudBusy}
            spaceInfo={spaceInfo}
            nativeCaps={nativeCaps}
            onUpdateSettings={handleUpdateSettings}
            onImportBundle={handleImportBundle}
            onRequestNotificationPermission={requestNotificationPermission}
            onToggleKeepAlive={handleToggleKeepAlive}
            onAddSchedule={handleAddSchedule}
            onToggleSchedule={handleToggleSchedule}
            onUpdateSchedule={handleUpdateSchedule}
            onDeleteSchedule={handleDeleteSchedule}
            onTestSchedule={(item) => handleTriggerSchedule(item, true)}
            onDownloadScheduleAlarm={handleDownloadScheduleAlarm}
            onCloudSignIn={handleCloudSignIn}
            onCloudSignOut={handleCloudSignOut}
            onInvitePartner={handleInvitePartner}
            onJoinSpaceByCode={handleJoinSpaceByCode}
            onPushLocalToCloud={handlePushLocalToCloud}
            onRequestNativePermissions={handleRequestNativePermissions}
            onOpenNotificationListenerSettings={handleOpenNotificationListenerSettings}
            onOpenAppInfoSettings={handleOpenAppInfoSettings}
            onOpenXiaomiOtherPermissions={handleOpenXiaomiOtherPermissions}
            onStatusToast={showToast}
          />
        )}
      </main>

      <footer className="hidden md:block border-t border-slate-200/70 dark:border-emerald-950/60 py-5 text-center text-xs text-slate-500 dark:text-slate-400">
        هم‌صدا · برنامه‌ریزی هدفمند، شکرگذاری، همگام‌سازی ابری و کتابخانه صوتی فارسی و دوزبانه
      </footer>

      {!isOnline && (
        <div className="fixed bottom-20 md:bottom-5 left-4 z-40 flex items-center gap-2 rounded-xl bg-amber-600 px-3.5 py-2 text-xs font-medium text-white shadow-lg">
          <WifiOff className="w-4 h-4 shrink-0" />
          <span>حالت آفلاین — تمام داده‌ها و صوت‌های ذخیره‌شده در دسترس هستند</span>
        </div>
      )}

      {toast && (
        <div className="fixed top-16 md:top-20 right-4 left-4 md:left-auto md:max-w-md z-50 flex items-start justify-between gap-2 rounded-xl bg-slate-900 dark:bg-emerald-800 text-white px-4 py-3 text-xs sm:text-sm font-medium shadow-xl">
          <span className="leading-6">{toast}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            aria-label="بستن پیام"
            className="shrink-0 p-1 rounded-lg text-white/80 hover:text-white hover:bg-white/10 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}

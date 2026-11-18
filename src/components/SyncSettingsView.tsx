import React, {useState} from 'react';
import {
  Bell,
  BellOff,
  Check,
  Clock,
  Cloud,
  Copy,
  Download,
  FileAudio,
  Link2,
  LogIn,
  LogOut,
  Moon,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Share2,
  ShieldCheck,
  Smartphone,
  Sun,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
} from 'lucide-react';
import {toPersianDigits, VOICE_PERSONAS} from '../data/persianLibrary';
import {usePWAInstall} from '../hooks/usePWAInstall';
import {getCloudApiBaseUrl, safeReadJsonResponse, setCloudApiBaseUrl} from '../services/apiConfig';
import type {CoupleSpaceInfo} from '../services/coupleSyncService';
import {
  isNativeAndroid,
  openBatteryAndAutostartSettingsNative,
  pickJsonFileNative,
  requestSmsPermissionsOnlyNative,
  saveBackupJsonNative,
  syncServerBaseUrlToNative,
  type NativeCapabilities,
} from '../services/nativeAndroidBridge';
import type {
  AppSettings,
  CallerContact,
  DeviceOwner,
  GoalItem,
  GratitudeEntry,
  HabitItem,
  LocalVoiceControls,
  ScheduleTopic,
  ScheduledAnnouncement,
  VoiceName,
} from '../types/app';
import {getPartnerNameForDevice, getSelfName} from '../utils/deviceIdentity';

interface SyncSettingsViewProps {
  settings: AppSettings;
  deviceOwner: DeviceOwner;
  onChangeDeviceOwner: (owner: DeviceOwner) => void;
  localVoiceControls: LocalVoiceControls;
  onUpdateLocalVoiceControls: (patch: Partial<LocalVoiceControls>) => void;
  onRefreshApp: () => void;
  goals: GoalItem[];
  habits: HabitItem[];
  gratitudes: GratitudeEntry[];
  callers: CallerContact[];
  schedules: ScheduledAnnouncement[];
  notifPermission: NotificationPermission;
  keepAliveActive: boolean;
  isOnline: boolean;
  cachedClipsCount: number;
  cloudUserEmail: string | null;
  cloudBusy: boolean;
  spaceInfo: CoupleSpaceInfo | null;
  nativeCaps: NativeCapabilities;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  onImportBundle: (payload: {
    goals?: GoalItem[];
    habits?: HabitItem[];
    gratitudes?: GratitudeEntry[];
    callers?: CallerContact[];
  }) => void;
  onRequestNotificationPermission: () => void;
  onToggleKeepAlive: (enabled: boolean) => void;
  onAddSchedule: (schedule: Omit<ScheduledAnnouncement, 'id'>) => void;
  onToggleSchedule: (id: string) => void;
  onUpdateSchedule: (id: string, patch: Partial<ScheduledAnnouncement>) => void;
  onDeleteSchedule: (id: string) => void;
  onTestSchedule: (schedule: ScheduledAnnouncement) => void;
  onDownloadScheduleAlarm: (schedule: ScheduledAnnouncement) => Promise<void>;
  onCloudSignIn: () => Promise<void>;
  onCloudSignOut: () => Promise<void>;
  onInvitePartner: (email: string) => Promise<void>;
  onJoinSpaceByCode: (spaceCode: string) => Promise<void>;
  onPushLocalToCloud: () => Promise<void>;
  onRequestNativePermissions: () => Promise<void>;
  onOpenNotificationListenerSettings: () => Promise<void>;
  onOpenAppInfoSettings: () => Promise<void>;
  onOpenXiaomiOtherPermissions: () => Promise<void>;
  onStatusToast: (msg: string) => void;
}

const TOPIC_LABELS: Record<ScheduleTopic, string> = {
  morning: 'پیام صبحگاهی',
  goals: 'اهداف امروز',
  energy: 'انرژی و انگیزه',
  gratitude: 'شکرگذاری',
  night_movies: 'معرفی فیلم و سریال شبانه',
  custom: 'متن دلخواه',
};

const DAYS_LABELS: Record<ScheduledAnnouncement['days'], string> = {
  daily: 'هر روز',
  weekdays: 'روزهای کاری (شنبه تا چهارشنبه)',
  weekends: 'آخر هفته (پنج‌شنبه و جمعه)',
};

export const SyncSettingsView: React.FC<SyncSettingsViewProps> = ({
  settings,
  deviceOwner,
  onChangeDeviceOwner,
  localVoiceControls,
  onUpdateLocalVoiceControls,
  onRefreshApp,
  goals,
  habits,
  gratitudes,
  callers,
  schedules,
  notifPermission,
  keepAliveActive,
  isOnline,
  cachedClipsCount,
  cloudUserEmail,
  cloudBusy,
  spaceInfo,
  nativeCaps,
  onUpdateSettings,
  onImportBundle,
  onRequestNotificationPermission,
  onToggleKeepAlive,
  onAddSchedule,
  onToggleSchedule,
  onUpdateSchedule,
  onDeleteSchedule,
  onTestSchedule,
  onDownloadScheduleAlarm,
  onCloudSignIn,
  onCloudSignOut,
  onInvitePartner,
  onJoinSpaceByCode,
  onPushLocalToCloud,
  onRequestNativePermissions,
  onOpenNotificationListenerSettings,
  onOpenAppInfoSettings,
  onOpenXiaomiOtherPermissions,
  onStatusToast,
}) => {
  const selfName = getSelfName(settings, deviceOwner);
  const partnerOtherName = getPartnerNameForDevice(settings, deviceOwner);
  const {isInstallable, isInstalled, isIOS, install} = usePWAInstall();
  const [importText, setImportText] = useState('');
  const [copied, setCopied] = useState(false);
  const [copiedSpace, setCopiedSpace] = useState(false);

  const [partnerEmailInput, setPartnerEmailInput] = useState(spaceInfo?.partnerEmail ?? '');
  const [joinCodeInput, setJoinCodeInput] = useState('');
  const [serverUrlInput, setServerUrlInput] = useState(() => getCloudApiBaseUrl());
  const [serverCheckStatus, setServerCheckStatus] = useState<{ok: boolean; msg: string} | null>(null);
  const [checkingServer, setCheckingServer] = useState(false);

  // New schedule form state
  const [newTitle, setNewTitle] = useState('');
  const [newTopic, setNewTopic] = useState<ScheduleTopic>('morning');
  const [newTime, setNewTime] = useState('08:00');
  const [newDays, setNewDays] = useState<ScheduledAnnouncement['days']>('daily');
  const [newVoice, setNewVoice] = useState<VoiceName>(settings.defaultVoice);
  const [newCustomText, setNewCustomText] = useState('');
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const exportPayload = JSON.stringify(
    {
      app: 'roozhaye-man-o-zari',
      exportedAt: new Date().toISOString(),
      goals,
      habits,
      gratitudes,
      callers,
      schedules,
    },
    null,
    2
  );

  const handleDownloadJson = async (shareAfter = false) => {
    const filename = `man-o-zari-backup-${new Date().toISOString().slice(0, 10)}.json`;
    if (isNativeAndroid()) {
      const res = await saveBackupJsonNative(filename, exportPayload, shareAfter);
      if (res.ok) {
        onStatusToast(
          shareAfter
            ? `فایل پشتیبان (${filename}) ذخیره و پنجره اشتراک‌گذاری باز شد.`
            : `فایل پشتیبان با نام ${filename} در پوشه Download/RoozhayeManOZari ذخیره شد.`
        );
      } else {
        onStatusToast(res.error || 'خطا در ذخیره فایل پشتیبان؛ از «کپی کد پشتیبان» نیز می‌توانید استفاده کنید.');
      }
      return;
    }

    const blob = new Blob([exportPayload], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    onStatusToast('فایل پشتیبان با موفقیت دانلود شد.');
  };

  const handleNativePickJson = async () => {
    const res = await pickJsonFileNative();
    if (res.cancelled) return;
    if (!res.ok || !res.content) {
      onStatusToast(res.error || 'امکان خواندن فایل انتخاب‌شده نبود.');
      return;
    }
    try {
      const parsed = JSON.parse(res.content);
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('فرمت نامعتبر است');
      }
      onImportBundle(parsed);
      onStatusToast(`فایل پشتیبان «${res.name || 'backup.json'}» با موفقیت بارگذاری و ادغام شد.`);
    } catch {
      onStatusToast('فایل انتخاب‌شده JSON معتبر هم‌صدا نیست.');
    }
  };

  const handleCopyCode = async () => {
    try {
      await navigator.clipboard.writeText(exportPayload);
      setCopied(true);
      onStatusToast('کد همگام‌سازی کپی شد.');
      setTimeout(() => setCopied(false), 2500);
    } catch {
      onStatusToast('کپی خودکار انجام نشد؛ از دانلود فایل استفاده کنید.');
    }
  };

  const handleCopySpaceId = async () => {
    if (!spaceInfo?.spaceId) return;
    try {
      await navigator.clipboard.writeText(spaceInfo.spaceId);
      setCopiedSpace(true);
      onStatusToast('کد فضای مشترک کپی شد. می‌توانید برای همراهتان بفرستید.');
      setTimeout(() => setCopiedSpace(false), 2500);
    } catch {
      onStatusToast('لطفاً کد فضای مشترک را دستی کپی کنید.');
    }
  };

  const handleImportSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const parsed = JSON.parse(importText.trim());
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('فرمت نامعتبر است');
      }
      onImportBundle(parsed);
      setImportText('');
      onStatusToast('اطلاعات با داده‌های فعلی شما ادغام و همگام‌سازی شد.');
    } catch {
      onStatusToast('متن واردشده معتبر نیست. لطفاً فایل یا کد صحیح همگام‌سازی را وارد کنید.');
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      onImportBundle(parsed);
      onStatusToast('فایل پشتیبان با موفقیت ادغام شد.');
    } catch {
      onStatusToast('فایل انتخاب‌شده معتبر نیست.');
    }
    e.target.value = '';
  };

  const handleCreateSchedule = (e: React.FormEvent) => {
    e.preventDefault();
    const title = newTitle.trim() || TOPIC_LABELS[newTopic];
    if (newTopic === 'custom' && !newCustomText.trim()) {
      onStatusToast('لطفاً متن اعلان دلخواه را بنویسید.');
      return;
    }
    onAddSchedule({
      title,
      topic: newTopic,
      time: newTime || '08:00',
      enabled: true,
      voiceName: newVoice,
      days: newDays,
      customText: newTopic === 'custom' ? newCustomText.trim() : undefined,
    });
    setNewTitle('');
    setNewCustomText('');
    onStatusToast(`زمان‌بندی «${title}» برای ساعت ${toPersianDigits(newTime)} اضافه شد.`);
  };

  const handleAlarmDownload = async (item: ScheduledAnnouncement) => {
    setDownloadingId(item.id);
    try {
      await onDownloadScheduleAlarm(item);
    } finally {
      setDownloadingId(null);
    }
  };

  const handleSaveServerUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    const normalized = setCloudApiBaseUrl(serverUrlInput);
    setServerUrlInput(normalized || getCloudApiBaseUrl());
    const targetBase = normalized || getCloudApiBaseUrl();
    syncServerBaseUrlToNative(targetBase).catch(() => {});
    setCheckingServer(true);
    setServerCheckStatus(null);
    try {
      const res = await fetch(`${targetBase}/api/health`);
      const parsed = await safeReadJsonResponse<{ok?: boolean; aiReady?: boolean}>(res);
      if (parsed.isHtml) {
        const msg = 'این نشانی صفحه وب برگرداند و به سرور برنامه وصل نیست. نشانی دقیق یا وضعیت فیلترشکن را بررسی کنید.';
        setServerCheckStatus({ok: false, msg});
        onStatusToast(msg);
        return;
      }
      if (!res.ok) {
        const msg = `سرور پاسخ خطا داد (کد ${res.status}). مطمئن شوید برنامه Publish شده است.`;
        setServerCheckStatus({ok: false, msg});
        onStatusToast(msg);
        return;
      }
      const data = parsed.data;
      if (data?.ok) {
        const msg = data.aiReady
          ? 'آدرس ذخیره شد و اتصال به سرور صدا برقرار است.'
          : 'سرور در دسترس است اما کلید سرویس صدا فعال نیست.';
        setServerCheckStatus({ok: Boolean(data.aiReady), msg});
        onStatusToast(msg);
      } else {
        setServerCheckStatus({ok: false, msg: 'پاسخ نامعتبر از سرور دریافت شد.'});
        onStatusToast('پاسخ نامعتبر از سرور دریافت شد.');
      }
    } catch {
      const msg = 'خطا در اتصال به سرور. فیلترشکن گوشی را برای برنامه باز بگذارید یا آدرس را بررسی کنید.';
      setServerCheckStatus({ok: false, msg});
      onStatusToast(msg);
    } finally {
      setCheckingServer(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Device Owner Identity & Personal Assistant Identity (Stored Locally Per Phone!) */}
      <section className="rounded-2xl bg-white dark:bg-[#121E1C] border border-slate-200/80 dark:border-emerald-950/70 p-6 sm:p-8 space-y-5">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-center">
          <div className="lg:col-span-7 space-y-2">
            <div className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">
              تشخیص هوشمند کاربر این گوشی (ذخیره اختصاصی روی همین دستگاه)
            </div>
            <h2 className="text-lg sm:text-xl font-extrabold text-slate-900 dark:text-white">
              این برنامه الان روی گوشی چه کسی نصب است؟
            </h2>
            <p className="text-xs sm:text-sm leading-6 text-slate-600 dark:text-slate-300">
              این انتخاب فقط روی همین گوشی ذخیره می‌شود و با همگام‌سازی ابری تغییر نمی‌کند؛ اگر انتخاب کنید «گوشی {settings.partnerName}»، تمام خطاب‌ها و دستیار صوتی اول {settings.partnerName} را صدا می‌زنند.
            </p>
            <div className="pt-2 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => onChangeDeviceOwner('man')}
                className={`min-h-[52px] px-4 py-3 rounded-xl border text-right transition-colors cursor-pointer ${
                  deviceOwner === 'man'
                    ? 'bg-emerald-700 border-emerald-700 text-white'
                    : 'bg-slate-50/70 dark:bg-[#0B1312] border-slate-200 dark:border-emerald-900 text-slate-800 dark:text-slate-200 hover:bg-emerald-50 dark:hover:bg-emerald-950/40'
                }`}
              >
                <div className="text-sm font-bold">این گوشی {settings.myName} است</div>
                <div className={`text-[11px] mt-0.5 ${deviceOwner === 'man' ? 'text-emerald-100' : 'text-slate-500 dark:text-slate-400'}`}>
                  خطاب اول با «{settings.myName}» · پیامک پیش‌فرض به {settings.partnerName}
                </div>
              </button>

              <button
                type="button"
                onClick={() => onChangeDeviceOwner('zari')}
                className={`min-h-[52px] px-4 py-3 rounded-xl border text-right transition-colors cursor-pointer ${
                  deviceOwner === 'zari'
                    ? 'bg-emerald-700 border-emerald-700 text-white'
                    : 'bg-slate-50/70 dark:bg-[#0B1312] border-slate-200 dark:border-emerald-900 text-slate-800 dark:text-slate-200 hover:bg-emerald-50 dark:hover:bg-emerald-950/40'
                }`}
              >
                <div className="text-sm font-bold">این گوشی {settings.partnerName} است</div>
                <div className={`text-[11px] mt-0.5 ${deviceOwner === 'zari' ? 'text-emerald-100' : 'text-slate-500 dark:text-slate-400'}`}>
                  خطاب اول با «{settings.partnerName}» · پیامک پیش‌فرض به {settings.myName}
                </div>
              </button>
            </div>
          </div>

          <div className="lg:col-span-5 rounded-xl bg-slate-50/80 dark:bg-[#0B1312] border border-slate-200/80 dark:border-emerald-900/70 p-4 space-y-3">
            <label className="block text-xs font-bold text-slate-900 dark:text-white">
              نام اختصاصی دستیار شخصی ({settings.myName} و {settings.partnerName})
            </label>
            <input
              type="text"
              value={settings.assistantName || 'آوا'}
              onChange={(e) => onUpdateSettings({assistantName: e.target.value})}
              placeholder="مثلاً: آوا، نگار، یاس، همدم..."
              className="w-full min-h-[44px] px-3.5 rounded-xl border border-slate-200 dark:border-emerald-900 bg-white dark:bg-[#121E1C] text-sm font-semibold text-slate-900 dark:text-white"
            />
            <p className="text-[11px] leading-5 text-slate-500 dark:text-slate-400">
              در تب <strong>دستیار صوتی</strong> وقتی با همین نام صدایش بزنید (مثلاً «{settings.assistantName || 'آوا'} ساعت چنده؟») جواب می‌دهد و دستورها را اجرا می‌کند.
            </p>
          </div>
        </div>
      </section>

      {/* Per-Device Master Speaker Mode (Auto vs Manual) & Quick App Refresh */}
      <section className="rounded-2xl bg-white dark:bg-[#121E1C] border border-slate-200/80 dark:border-emerald-950/70 p-6 sm:p-8 space-y-5">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
              {localVoiceControls.masterSpeakerEnabled ? (
                <Volume2 className="w-4 h-4" />
              ) : (
                <VolumeX className="w-4 h-4 text-amber-600 dark:text-amber-400" />
              )}
              <span>تنظیم کلی سخنگو (مختص همین گوشی: {selfName})</span>
            </div>
            <h2 className="text-lg sm:text-xl font-extrabold text-slate-900 dark:text-white">
              حالت سخنگوی خودکار یا دستی کردن (بی‌صدا) روی گوشی {selfName}
            </h2>
            <p className="text-xs sm:text-sm leading-6 text-slate-600 dark:text-slate-300 max-w-3xl">
              این تنظیم فقط روی <strong>گوشی {selfName}</strong> اعمال می‌شود و گوشی {partnerOtherName} را تغییر نمی‌دهد. در حالت عادی همه‌چیز خودکار با صدا اعلام می‌شود؛ با خاموش کردن این کلید، برنامه کاملاً به <strong>حالت دستی</strong> می‌رود و هیچ تماس، پیامک، یادآور صبحگاهی یا پاسخ دستیاری خودکار بلند خوانده نمی‌شود (فقط وقتی خودتان دکمه پخش را بزنید صدا می‌آید).
            </p>
          </div>

          <div className="shrink-0 flex flex-wrap gap-2.5">
            <button
              type="button"
              onClick={() =>
                onUpdateLocalVoiceControls({
                  masterSpeakerEnabled: !localVoiceControls.masterSpeakerEnabled,
                })
              }
              className={`min-h-[48px] px-5 py-2.5 rounded-xl text-xs sm:text-sm font-bold flex items-center gap-2 transition-colors cursor-pointer ${
                localVoiceControls.masterSpeakerEnabled
                  ? 'bg-emerald-700 hover:bg-emerald-800 text-white'
                  : 'bg-amber-600 hover:bg-amber-700 text-white'
              }`}
            >
              {localVoiceControls.masterSpeakerEnabled ? (
                <>
                  <Volume2 className="w-4 h-4" />
                  <span>سخنگو روشن است (کلیک برای خاموش/دستی کردن)</span>
                </>
              ) : (
                <>
                  <VolumeX className="w-4 h-4" />
                  <span>سخنگو خاموش / دستی است (کلیک برای روشن کردن)</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={onRefreshApp}
              className="min-h-[48px] px-4 py-2.5 rounded-xl border border-slate-200 dark:border-emerald-900 bg-slate-50 dark:bg-[#0B1312] hover:bg-slate-100 dark:hover:bg-emerald-950/40 text-slate-800 dark:text-slate-100 text-xs sm:text-sm font-semibold flex items-center gap-2 cursor-pointer"
            >
              <RefreshCw className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
              <span>بروزرسانی برنامه (رفرش)</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-2">
          {[
            {
              key: 'autoCallAnnounce' as const,
              title: 'اعلام خودکار تماس ورودی',
              desc: `اعلام نام تماس‌گیرنده روی گوشی ${selfName}`,
            },
            {
              key: 'autoSmsAnnounce' as const,
              title: 'خواندن خودکار پیامک ورودی',
              desc: `خواندن فرستنده و متن پیامک روی گوشی ${selfName}`,
            },
            {
              key: 'autoScheduleAnnounce' as const,
              title: 'پخش خودکار صبحگاهی و زمان‌بند',
              desc: `پخش صوتی یادآورهای روزانه روی گوشی ${selfName}`,
            },
            {
              key: 'autoAssistantSpeak' as const,
              title: 'خواندن خودکار پاسخ دستیار',
              desc: `پاسخ صوتی خودکار دستیار ${settings.assistantName || 'آوا'} روی گوشی ${selfName}`,
            },
          ].map((item) => {
            const active = localVoiceControls.masterSpeakerEnabled && localVoiceControls[item.key];
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => {
                  const nextVal = !localVoiceControls[item.key];
                  onUpdateLocalVoiceControls({
                    ...(nextVal && !localVoiceControls.masterSpeakerEnabled
                      ? {masterSpeakerEnabled: true}
                      : {}),
                    [item.key]: nextVal,
                  });
                }}
                className={`min-h-[68px] p-3.5 rounded-xl border text-right transition-colors cursor-pointer flex flex-col justify-between ${
                  active
                    ? 'bg-emerald-50/80 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-950 dark:text-emerald-100'
                    : 'bg-slate-50/70 dark:bg-[#0B1312] border-slate-200 dark:border-emerald-950 text-slate-600 dark:text-slate-400'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold">{item.title}</span>
                  <span
                    className={`text-[11px] font-bold ${
                      active ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-300'
                    }`}
                  >
                    {!localVoiceControls.masterSpeakerEnabled
                      ? 'دستی (کل خاموش)'
                      : localVoiceControls[item.key]
                        ? 'روشن'
                        : 'دستی'}
                  </span>
                </div>
                <span className="mt-1 text-[11px] opacity-80">{item.desc}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Real-time Cloud Sync between Bahman & Zari's Phones */}
      <section className="rounded-2xl bg-white dark:bg-[#121E1C] border border-slate-200/80 dark:border-emerald-950/70 p-6 sm:p-8 space-y-5">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <Cloud className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
              <span>همگام‌سازی لحظه‌ای ابری (Firestore) بین گوشی {selfName} و {partnerOtherName}</span>
            </div>
            <h1 className="mt-2 text-xl sm:text-2xl font-extrabold text-slate-900 dark:text-white">
              همگام‌سازی خودکار دو گوشی، زمان‌بند و نسخه اندروید (APK)
            </h1>
            <p className="mt-1.5 text-sm leading-7 text-slate-600 dark:text-slate-300 max-w-3xl">
              با ورود به حساب گوگل روی گوشی {selfName} و گوشی {partnerOtherName}، تمام اهداف، عادت‌ها، شکرگذاری‌ها، زمان‌بندی‌ها، مخاطبین تماس و تنظیمات به‌صورت خودکار بین هر دو دستگاه مچ می‌شوند.
            </p>
          </div>

          <div className="shrink-0">
            {cloudUserEmail ? (
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-h-[44px] px-3.5 py-2 rounded-xl bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-800 text-xs font-semibold text-emerald-900 dark:text-emerald-200 flex items-center gap-2">
                  <Check className="w-4 h-4 text-emerald-600" />
                  <span dir="ltr">{cloudUserEmail}</span>
                </div>
                <button
                  type="button"
                  disabled={cloudBusy}
                  onClick={onCloudSignOut}
                  className="min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-200 dark:border-emerald-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-emerald-950/40 text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                >
                  <LogOut className="w-4 h-4" />
                  <span>خروج</span>
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={cloudBusy || !isOnline}
                onClick={onCloudSignIn}
                className="min-h-[44px] px-5 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white text-sm font-semibold flex items-center gap-2 cursor-pointer"
              >
                <LogIn className="w-4 h-4" />
                <span>{cloudBusy ? 'در حال اتصال...' : 'ورود با گوگل برای همگام‌سازی'}</span>
              </button>
            )}
          </div>
        </div>

        {cloudUserEmail && spaceInfo && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 pt-4 border-t border-slate-100 dark:border-emerald-950/60">
            <div className="rounded-xl bg-slate-50/80 dark:bg-[#0B1312] border border-slate-200/80 dark:border-emerald-900/70 p-4 space-y-3">
              <div className="text-xs font-bold text-slate-900 dark:text-white">
                ۱. دعوت گوشی {partnerOtherName} (مچ شدن خودکار با جیمیل)
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-300 leading-5">
                کافی است ایمیل جیمیل گوشی {partnerOtherName} را اینجا ثبت کنید (یا با همین ایمیل در هر دو گوشی وارد شوید) تا گوشی {partnerOtherName} به‌محض باز کردن برنامه خودکار به همین فضای مشترک وصل شود.
              </p>
              <div className="flex flex-wrap gap-2">
                <input
                  type="email"
                  dir="ltr"
                  value={partnerEmailInput}
                  onChange={(e) => setPartnerEmailInput(e.target.value)}
                  placeholder="partner.gmail@gmail.com"
                  className="flex-1 min-w-[200px] min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-emerald-900 bg-white dark:bg-[#121E1C] text-xs font-mono-num text-slate-900 dark:text-white"
                />
                <button
                  type="button"
                  disabled={cloudBusy || !partnerEmailInput.trim()}
                  onClick={() => onInvitePartner(partnerEmailInput)}
                  className="min-h-[44px] px-4 rounded-xl bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white text-xs font-semibold cursor-pointer"
                >
                  ثبت ایمیل همراه
                </button>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs">
                <span className="text-slate-500 dark:text-slate-400">
                  کد فضای مشترک:{' '}
                  <code dir="ltr" className="font-mono-num text-slate-800 dark:text-slate-200">
                    {spaceInfo.spaceId}
                  </code>
                </span>
                <button
                  type="button"
                  onClick={handleCopySpaceId}
                  className="min-h-[36px] px-2.5 rounded-lg border border-slate-200 dark:border-emerald-900 text-xs text-slate-700 dark:text-slate-200 flex items-center gap-1 cursor-pointer"
                >
                  {copiedSpace ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>کپی کد فضا</span>
                </button>
              </div>
            </div>

            <div className="rounded-xl bg-slate-50/80 dark:bg-[#0B1312] border border-slate-200/80 dark:border-emerald-900/70 p-4 space-y-3">
              <div className="text-xs font-bold text-slate-900 dark:text-white">
                ۲. اتصال با کد فضا یا ارسال داده‌های فعلی
              </div>
              <div className="flex flex-wrap gap-2">
                <input
                  type="text"
                  dir="ltr"
                  value={joinCodeInput}
                  onChange={(e) => setJoinCodeInput(e.target.value)}
                  placeholder="کد فضای دریافت‌شده از گوشی دیگر"
                  className="flex-1 min-w-[180px] min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-emerald-900 bg-white dark:bg-[#121E1C] text-xs font-mono-num text-slate-900 dark:text-white"
                />
                <button
                  type="button"
                  disabled={cloudBusy || !joinCodeInput.trim()}
                  onClick={() => onJoinSpaceByCode(joinCodeInput)}
                  className="min-h-[44px] px-4 rounded-xl border border-slate-200 dark:border-emerald-900 bg-white dark:bg-[#121E1C] hover:bg-slate-100 text-slate-800 dark:text-slate-100 text-xs font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  <Link2 className="w-3.5 h-3.5" />
                  <span>اتصال</span>
                </button>
              </div>
              <button
                type="button"
                disabled={cloudBusy}
                onClick={onPushLocalToCloud}
                className="w-full min-h-[44px] px-4 rounded-xl bg-slate-900 dark:bg-emerald-600 hover:bg-slate-800 dark:hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-semibold cursor-pointer"
              >
                همگام‌سازی و ارسال داده‌های فعلی این گوشی به ابر
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Native Android APK Capabilities & GitHub Actions APK Build */}
      <section className="rounded-2xl bg-white dark:bg-[#121E1C] border border-slate-200/80 dark:border-emerald-950/70 p-6 sm:p-8 space-y-5">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <Smartphone className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
              <span>
                وضعیت محیط اجرا:{' '}
                {nativeCaps.isNative ? 'اپلیکیشن بومی اندروید (APK)' : 'نسخه وب / PWA'}
                {' · '}فایل‌های صوتی آفلاین: {toPersianDigits(cachedClipsCount)} مورد
              </span>
            </div>
            <h2 className="mt-2 text-lg sm:text-xl font-bold text-slate-900 dark:text-white">
              سرویس دائمی پس‌زمینه، اعلام خودکار تماس ورودی و ساخت فایل APK در گیت‌هاب
            </h2>
            <p className="mt-1.5 text-xs sm:text-sm leading-6 text-slate-600 dark:text-slate-300 max-w-3xl">
              پروژه بومی اندروید (Capacitor + سرویس پس‌زمینه کاتلین + گیرنده تماس ورودی + آلارم دقیق بیدارباش) و گردش‌کار گیت‌هاب (<code dir="ltr">.github/workflows/build-apk.yml</code>) داخل کدهای این برنامه آماده شده است.
            </p>
          </div>

          <div className="shrink-0 flex flex-wrap gap-2">
            {nativeCaps.isNative ? (
              <>
                <button
                  type="button"
                  onClick={onRequestNativePermissions}
                  className="min-h-[44px] px-4 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white text-xs sm:text-sm font-semibold flex items-center gap-2 cursor-pointer"
                >
                  <ShieldCheck className="w-4 h-4" />
                  <span>مجوز تماس، باتری و Autostart</span>
                </button>
                <button
                  type="button"
                  onClick={onOpenNotificationListenerSettings}
                  className="min-h-[44px] px-3.5 py-2.5 rounded-xl bg-slate-900 dark:bg-emerald-800 hover:bg-slate-800 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                >
                  <Bell className="w-4 h-4" />
                  <span>فعال‌سازی خواندن پیامک و RCS (اعلان‌ها)</span>
                </button>
                <button
                  type="button"
                  onClick={onOpenAppInfoSettings}
                  className="min-h-[44px] px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-emerald-900 bg-white dark:bg-[#0B1312] text-slate-700 dark:text-slate-200 text-xs font-semibold cursor-pointer"
                >
                  باز کردن تنظیمات محدودشده برنامه
                </button>
                <button
                  type="button"
                  onClick={onOpenXiaomiOtherPermissions}
                  className="min-h-[44px] px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-emerald-900 bg-white dark:bg-[#0B1312] text-slate-700 dark:text-slate-200 text-xs font-semibold cursor-pointer"
                >
                  مجوزهای دیگر شیائومی (پاپ‌آپ و پس‌زمینه)
                </button>
                <button
                  type="button"
                  onClick={() => openBatteryAndAutostartSettingsNative()}
                  className="min-h-[44px] px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-emerald-900 bg-white dark:bg-[#0B1312] text-slate-700 dark:text-slate-200 text-xs font-semibold cursor-pointer"
                >
                  باتری بدون محدودیت و Autostart
                </button>
              </>
            ) : isInstalled ? (
              <div className="min-h-[44px] px-4 py-2.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300 text-xs sm:text-sm font-semibold flex items-center gap-2">
                <Check className="w-4 h-4" />
                <span>نسخه PWA نصب شده است</span>
              </div>
            ) : isInstallable ? (
              <button
                type="button"
                onClick={install}
                className="min-h-[44px] px-5 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white text-xs sm:text-sm font-semibold flex items-center gap-2 cursor-pointer"
              >
                <Download className="w-4 h-4" />
                <span>نصب وب‌اپ (PWA) روی گوشی</span>
              </button>
            ) : (
              <div className="text-xs text-slate-600 dark:text-slate-300 max-w-xs leading-6">
                {isIOS
                  ? 'در Safari دکمه Share و سپس Add to Home Screen را بزنید.'
                  : 'برای ساخت APK: پروژه را به گیت‌هاب خود بفرستید تا در تب Actions فایل app-debug.apk ساخته و آماده دانلود شود.'}
              </div>
            )}
          </div>
        </div>

        {/* Dedicated 3-Step Restricted Settings Unlock Wizard for Android 13-16 / HyperOS 3 (POCO X6 Pro) */}
        {nativeCaps.isNative && (!nativeCaps.sms || !nativeCaps.notificationListener) && (
          <div className="rounded-xl bg-amber-50 dark:bg-amber-950/35 border border-amber-300 dark:border-amber-800 p-4 sm:p-5 space-y-3">
            <div className="text-xs sm:text-sm font-extrabold text-amber-950 dark:text-amber-200">
              رفع قفل «تنظیمات محدودشده / Restricted setting» برای خواندن پیامک در گوشی همراه (اندروید ۱۳ تا ۱۶)
            </div>
            <p className="text-xs leading-6 text-amber-900 dark:text-amber-100/90">
              چون برنامه از بیرون گوگل‌پلی نصب شده، اندروید ابتدا اجازه پیامک و اعلان را قفل می‌کند و لینک راهنمای گوگل را نشان می‌دهد. با این ۳ قدم ساده قفل آن برای همیشه باز می‌شود:
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
              <div className="rounded-xl bg-white/80 dark:bg-[#0B1312] border border-amber-200/80 dark:border-amber-900 p-3 space-y-2 flex flex-col justify-between">
                <div className="text-xs leading-5 text-slate-700 dark:text-slate-200">
                  <strong>قدم ۱ (ظاهر شدن دکمه قفل):</strong> دکمه زیر را بزنید و کلید <em>هم‌صدا</em> را لمس کنید؛ اگر پنجره «تنظیمات محدودشده» داد، تایید/برگشت بزنید. (تا این را یک‌بار نزنید، گزینه قدم ۲ مخفی است!)
                </div>
                <button
                  type="button"
                  onClick={onOpenNotificationListenerSettings}
                  className="w-full min-h-[40px] px-3 rounded-lg bg-slate-900 dark:bg-emerald-700 text-white text-xs font-semibold cursor-pointer"
                >
                  ۱. باز کردن دسترسی اعلان پیامک
                </button>
              </div>

              <div className="rounded-xl bg-white/80 dark:bg-[#0B1312] border border-amber-200/80 dark:border-amber-900 p-3 space-y-2 flex flex-col justify-between">
                <div className="text-xs leading-5 text-slate-700 dark:text-slate-200">
                  <strong>قدم ۲ (باز کردن قفل):</strong> در صفحه اطلاعات برنامه، یا صفحه را <strong>تا پایینِ پایین</strong> بکشید و <strong>اجازه به تنظیمات محدودشده</strong> را بزنید، یا <strong>سه‌نقطه بالای صفحه (⋮)</strong> ← <em>Allow restricted settings</em> را تایید کنید.
                </div>
                <button
                  type="button"
                  onClick={onOpenAppInfoSettings}
                  className="w-full min-h-[40px] px-3 rounded-lg bg-amber-700 hover:bg-amber-800 text-white text-xs font-semibold cursor-pointer"
                >
                  ۲. باز کردن اطلاعات برنامه (رفع قفل)
                </button>
              </div>

              <div className="rounded-xl bg-white/80 dark:bg-[#0B1312] border border-amber-200/80 dark:border-amber-900 p-3 space-y-2 flex flex-col justify-between">
                <div className="text-xs leading-5 text-slate-700 dark:text-slate-200">
                  <strong>قدم ۳ (روشن کردن نهایی):</strong> پس از باز کردن قفل، دوباره دکمه قدم ۱ را بزنید و کلید را روشن کنید؛ سپس دکمه زیر را بزنید تا مجوز SMS تایید شود.
                </div>
                <button
                  type="button"
                  onClick={() => {
                    void requestSmsPermissionsOnlyNative().then((caps) => {
                      if (caps?.sms) {
                        onStatusToast('مجوز خواندن پیامک (SMS) با موفقیت فعال شد.');
                      } else if (caps) {
                        onStatusToast(
                          'اگر پنجره اجازه SMS باز نشد، قدم ۲ (باز کردن اطلاعات برنامه و اجازه تنظیمات محدودشده) را انجام دهید و در Permissions مجوز SMS را Allow کنید.'
                        );
                      }
                    });
                  }}
                  className="w-full min-h-[40px] px-3 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-semibold cursor-pointer"
                >
                  ۳. تایید نهایی مجوز پیامک (SMS)
                </button>
              </div>
            </div>
          </div>
        )}

        {nativeCaps.isNative && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5 pt-2">
            {[
              {label: 'تشخیص تماس ورودی', ok: nativeCaps.phoneState},
              {label: 'شماره تماس‌گیرنده', ok: nativeCaps.callLog},
              {label: 'خواندن پیامک (SMS)', ok: nativeCaps.sms},
              {label: 'اعلان پیامک / RCS', ok: nativeCaps.notificationListener},
              {label: 'خواندن نام مخاطبین', ok: nativeCaps.contacts},
              {label: 'اعلان‌های اندروید', ok: nativeCaps.notifications},
              {label: 'معافیت باتری MIUI/HyperOS', ok: nativeCaps.batteryIgnored},
              {label: 'باز شدن خودکار صبح', ok: nativeCaps.overlay},
              {label: 'سرویس دائمی پس‌زمینه', ok: nativeCaps.keepAliveRunning},
              {label: 'آلارم دقیق صبحگاهی', ok: nativeCaps.exactAlarm},
              {label: 'میکروفون دستیار و ضبط', ok: Boolean(nativeCaps.microphone)},
              {label: 'تغییر حالت سایلنت', ok: Boolean(nativeCaps.dndPolicy)},
              {label: 'تماس و پیامک دستیار', ok: Boolean(nativeCaps.callPhone && nativeCaps.sendSms)},
              {label: 'تنظیم نور صفحه سیستم', ok: Boolean(nativeCaps.writeSettings)},
            ].map((perm) => (
              <div
                key={perm.label}
                className={`rounded-xl border px-3 py-2.5 text-xs font-semibold ${
                  perm.ok
                    ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300'
                    : 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200'
                }`}
              >
                <div>{perm.label}</div>
                <div className="mt-0.5 text-[11px] font-normal">
                  {perm.ok ? 'فعال و آماده' : 'نیاز به تایید'}
                </div>
              </div>
            ))}
          </div>
        )}

        <form onSubmit={handleSaveServerUrl} className="rounded-xl bg-slate-50/70 dark:bg-[#0B1312] border border-slate-200/80 dark:border-emerald-900/70 p-4 space-y-2.5">
          <div className="flex flex-col sm:flex-row sm:items-end gap-3">
            <div className="flex-1">
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                نشانی سرور صدای روان فارسی برای استفاده داخل فایل APK
              </label>
              <input
                type="text"
                inputMode="url"
                dir="ltr"
                value={serverUrlInput}
                onChange={(e) => setServerUrlInput(e.target.value)}
                placeholder="https://roozhaye-manozari-7.ai.studio"
                className="w-full min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-emerald-900 bg-white dark:bg-[#121E1C] text-xs font-mono-num text-slate-900 dark:text-white"
              />
            </div>
            <button
              type="submit"
              disabled={checkingServer}
              className="min-h-[44px] px-4 rounded-xl bg-slate-900 dark:bg-emerald-700 text-white text-xs font-semibold cursor-pointer shrink-0 disabled:opacity-60"
            >
              {checkingServer ? 'در حال بررسی...' : 'ذخیره و تست اتصال سرور'}
            </button>
          </div>
          {serverCheckStatus && (
            <div
              className={`text-xs font-medium px-3 py-2 rounded-lg ${
                serverCheckStatus.ok
                  ? 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-800 dark:text-emerald-300'
                  : 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300'
              }`}
            >
              {serverCheckStatus.msg}
            </div>
          )}
        </form>
      </section>

      {/* Background Scheduler & Daily Announcements */}
      <section className="rounded-2xl bg-white dark:bg-[#121E1C] border border-slate-200/80 dark:border-emerald-950/70 p-6 sm:p-8 space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-100 dark:border-emerald-950/60 pb-5">
          <div>
            <h2 className="text-lg sm:text-xl font-bold text-slate-900 dark:text-white">
              زمان‌بند خودکار و اجرای پس‌زمینه موبایل
            </h2>
            <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-300 mt-1 leading-6">
              ساعت و موضوع اعلام‌ها را تنظیم کنید تا هر روز صبح پیام صبحگاهی، اهداف یا یادآورهای دلخواه به‌صورت خودکار اعلان و پخش شوند.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={onRequestNotificationPermission}
              className={`min-h-[44px] px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold flex items-center gap-2 border cursor-pointer transition-colors ${
                notifPermission === 'granted'
                  ? 'bg-emerald-50 dark:bg-emerald-950/50 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300'
                  : 'bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-950/70'
              }`}
            >
              {notifPermission === 'granted' ? <Bell className="w-4 h-4" /> : <BellOff className="w-4 h-4" />}
              <span>
                {notifPermission === 'granted' ? 'اعلان‌های گوشی فعال است' : 'فعال‌سازی اعلان‌های گوشی'}
              </span>
            </button>

            <button
              type="button"
              onClick={() => onToggleKeepAlive(!settings.backgroundKeepAlive)}
              className={`min-h-[44px] px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold flex items-center gap-2 border cursor-pointer transition-colors ${
                settings.backgroundKeepAlive
                  ? 'bg-emerald-700 border-emerald-700 text-white hover:bg-emerald-800'
                  : 'bg-slate-100 dark:bg-[#0B1312] border-slate-200 dark:border-emerald-900 text-slate-800 dark:text-slate-200 hover:bg-slate-200/70'
              }`}
            >
              <Radio className="w-4 h-4" />
              <span>
                {settings.backgroundKeepAlive
                  ? keepAliveActive || nativeCaps.keepAliveRunning
                    ? 'سرویس پس‌زمینه: روشن'
                    : 'سرویس پس‌زمینه: آماده با اولین لمس'
                  : 'روشن کردن اجرا در پس‌زمینه'}
              </span>
            </button>

            <button
              type="button"
              onClick={() => onUpdateSettings({autoOpenMorning: !settings.autoOpenMorning})}
              className={`min-h-[44px] px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold flex items-center gap-2 border cursor-pointer transition-colors ${
                settings.autoOpenMorning
                  ? 'bg-emerald-50 dark:bg-emerald-950/50 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300'
                  : 'bg-slate-100 dark:bg-[#0B1312] border-slate-200 dark:border-emerald-900 text-slate-700 dark:text-slate-300'
              }`}
            >
              <span>
                {settings.autoOpenMorning ? 'باز شدن خودکار صبح: فعال' : 'باز شدن خودکار صبح: خاموش'}
              </span>
            </button>
          </div>
        </div>

        {/* Active Schedules List */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {schedules.map((item) => (
            <div
              key={item.id}
              className={`rounded-xl border p-4 space-y-3 transition-colors ${
                item.enabled
                  ? 'bg-slate-50/70 dark:bg-[#0B1312] border-slate-200 dark:border-emerald-900/80'
                  : 'bg-slate-50/30 dark:bg-[#0B1312]/50 border-slate-200/60 dark:border-emerald-950/50 opacity-75'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="px-2 py-0.5 rounded-md text-[11px] font-semibold bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300">
                      {TOPIC_LABELS[item.topic]}
                    </span>
                    <span className="text-[11px] text-slate-500 dark:text-slate-400">
                      {DAYS_LABELS[item.days]}
                    </span>
                  </div>
                  <h3 className="mt-1.5 text-sm font-bold text-slate-900 dark:text-white truncate">
                    {item.title}
                  </h3>
                  {item.customText && (
                    <p className="mt-1 text-xs text-slate-600 dark:text-slate-300 line-clamp-2">
                      {item.customText}
                    </p>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => onToggleSchedule(item.id)}
                  aria-label={item.enabled ? 'غیرفعال کردن زمان‌بندی' : 'فعال کردن زمان‌بندی'}
                  className={`min-h-[44px] min-w-[68px] px-3 rounded-xl text-xs font-semibold cursor-pointer shrink-0 transition-colors ${
                    item.enabled
                      ? 'bg-emerald-700 text-white hover:bg-emerald-800'
                      : 'bg-slate-200 dark:bg-emerald-950 text-slate-700 dark:text-slate-300'
                  }`}
                >
                  {item.enabled ? 'فعال' : 'خاموش'}
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">
                    ساعت اعلام
                  </label>
                  <div className="relative flex items-center">
                    <Clock className="w-3.5 h-3.5 text-slate-400 absolute right-3 pointer-events-none" />
                    <input
                      type="time"
                      value={item.time}
                      onChange={(e) => onUpdateSchedule(item.id, {time: e.target.value})}
                      className="w-full min-h-[44px] pr-8 pl-2 rounded-xl border border-slate-200 dark:border-emerald-900 bg-white dark:bg-[#121E1C] text-xs font-mono-num text-slate-900 dark:text-white"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">
                    گوینده
                  </label>
                  <select
                    value={item.voiceName}
                    onChange={(e) => onUpdateSchedule(item.id, {voiceName: e.target.value as VoiceName})}
                    className="w-full min-h-[44px] px-2.5 rounded-xl border border-slate-200 dark:border-emerald-900 bg-white dark:bg-[#121E1C] text-xs text-slate-800 dark:text-slate-100"
                  >
                    {VOICE_PERSONAS.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => onTestSchedule(item)}
                  className="min-h-[44px] flex-1 px-3 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <Play className="w-3.5 h-3.5" />
                  <span>تست اعلام الان</span>
                </button>

                <button
                  type="button"
                  disabled={downloadingId === item.id}
                  onClick={() => handleAlarmDownload(item)}
                  className="min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-emerald-900 bg-white dark:bg-[#121E1C] hover:bg-slate-50 dark:hover:bg-emerald-950/50 text-slate-700 dark:text-slate-200 text-xs font-medium flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  <FileAudio className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" />
                  <span>{downloadingId === item.id ? 'در حال ساخت...' : 'دانلود زنگ ساعت (.wav)'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => onDeleteSchedule(item.id)}
                  aria-label="حذف زمان‌بندی"
                  className="min-h-[44px] min-w-[44px] rounded-xl border border-slate-200 dark:border-emerald-900 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 flex items-center justify-center cursor-pointer"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Add Custom Schedule Form */}
        <form
          onSubmit={handleCreateSchedule}
          className="rounded-xl border border-slate-200/80 dark:border-emerald-900/70 bg-slate-50/50 dark:bg-[#0B1312] p-4 sm:p-5 space-y-4"
        >
          <div className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Plus className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
            <span>افزودن یادآور و موضوع جدید روزانه</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="عنوان (مثلاً پیام صبحگاهی)"
              className="lg:col-span-2 min-h-[44px] px-3.5 rounded-xl border border-slate-200 dark:border-emerald-900 bg-white dark:bg-[#121E1C] text-xs sm:text-sm text-slate-900 dark:text-white"
            />

            <select
              value={newTopic}
              onChange={(e) => setNewTopic(e.target.value as ScheduleTopic)}
              className="min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-emerald-900 bg-white dark:bg-[#121E1C] text-xs sm:text-sm text-slate-800 dark:text-slate-100"
            >
              <option value="morning">موضوع: پیام صبحگاهی</option>
              <option value="goals">موضوع: مرور اهداف امروز</option>
              <option value="energy">موضوع: جمله انرژی‌بخش</option>
              <option value="gratitude">موضوع: شکرگذاری</option>
              <option value="night_movies">موضوع: فیلم و سریال دوبله شبانه</option>
              <option value="custom">موضوع: متن دلخواه</option>
            </select>

            <input
              type="time"
              value={newTime}
              onChange={(e) => setNewTime(e.target.value)}
              className="min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-emerald-900 bg-white dark:bg-[#121E1C] text-xs sm:text-sm font-mono-num text-slate-900 dark:text-white"
            />

            <select
              value={newDays}
              onChange={(e) => setNewDays(e.target.value as ScheduledAnnouncement['days'])}
              className="min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-emerald-900 bg-white dark:bg-[#121E1C] text-xs text-slate-800 dark:text-slate-100"
            >
              <option value="daily">هر روز</option>
              <option value="weekdays">روزهای کاری</option>
              <option value="weekends">آخر هفته</option>
            </select>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-start">
            <div>
              <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">
                انتخاب گوینده این اعلام
              </label>
              <select
                value={newVoice}
                onChange={(e) => setNewVoice(e.target.value as VoiceName)}
                className="w-full min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-emerald-900 bg-white dark:bg-[#121E1C] text-xs sm:text-sm text-slate-800 dark:text-slate-100"
              >
                {VOICE_PERSONAS.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
            </div>

            {newTopic === 'custom' && (
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">
                  متنی که در زمان مقرر خوانده شود
                </label>
                <textarea
                  rows={2}
                  value={newCustomText}
                  onChange={(e) => setNewCustomText(e.target.value)}
                  placeholder="مثلاً: سلام عزیز دلم! وقت نوشیدن آب و استراحت کوتاه است."
                  className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-emerald-900 bg-white dark:bg-[#121E1C] text-xs sm:text-sm text-slate-900 dark:text-white"
                />
              </div>
            )}
          </div>

          <button
            type="submit"
            className="min-h-[44px] px-5 rounded-xl bg-slate-900 dark:bg-emerald-600 hover:bg-slate-800 dark:hover:bg-emerald-700 text-white text-xs sm:text-sm font-semibold inline-flex items-center gap-2 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>ثبت زمان‌بندی جدید</span>
          </button>
        </form>

        {/* Xiaomi Mi 10T Pro (MIUI 14) & POCO X6 Pro (HyperOS 3 / Android 16) Background Checklist */}
        <div className="rounded-xl bg-amber-50/70 dark:bg-amber-950/25 border border-amber-200/80 dark:border-amber-900/50 p-4 sm:p-5 space-y-2.5">
          <div className="text-xs sm:text-sm font-bold text-amber-950 dark:text-amber-200">
            راهنمای گام‌به‌گام برای POCO X6 Pro (HyperOS 3 / اندروید ۱۶) و Mi 10T Pro (MIUI 14)
          </div>
          <ol className="list-decimal list-inside space-y-1.5 text-xs leading-6 text-amber-900 dark:text-amber-100/90">
            <li>
              <strong>باز کردن قفل تنظیمات محدودشده در POCO X6 Pro (اندروید ۱۶ / HyperOS 3):</strong> اول دکمه <em>«فعال‌سازی خواندن پیامک و RCS»</em> را بزنید و روی برنامه کلیک کنید تا پیام محدودیت نمایش داده شود؛ سپس دکمه <em>«باز کردن تنظیمات محدودشده برنامه»</em> را بزنید، صفحه را <strong>تا پایینِ پایین</strong> بکشید و <strong>اجازه به تنظیمات محدودشده</strong> را روشن کنید (یا آیکون <strong>سه‌نقطه بالای صفحه ⋮</strong> ← <em>Allow restricted settings</em> را تایید کنید).
            </li>
            <li>
              <strong>مجوزهای مخفی شیائومی (خیلی مهم در HyperOS 3):</strong> دکمه <em>«مجوزهای دیگر شیائومی (پاپ‌آپ و پس‌زمینه)»</em> را بزنید و هر دو گزینه <strong>Display pop-up windows while running in the background</strong> و <strong>Show on Lock screen</strong> و <strong>Service SMS</strong> را سبز (Always allow) کنید.
            </li>
            <li>
              <strong>خواندن پیامک‌های Google Messages و RCS:</strong> روی دکمه <strong>«فعال‌سازی خواندن پیامک و RCS (اعلان‌ها)»</strong> بزنید و «هم‌صدا» را روشن کنید تا علاوه بر پیامک معمولی، چت‌های RCS هم با صدای روان فارسی خوانده شوند.
            </li>
            <li>
              <strong>باتری بدون محدودیت و شروع خودکار:</strong> صرفه‌جویی باتری را روی <strong>No restrictions (بدون محدودیت)</strong> بگذارید، <strong>Autostart</strong> را فعال کنید و کلید «روشن کردن اجرا در پس‌زمینه» را روشن نگه دارید.
            </li>
          </ol>
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Preferences */}
        <section className="lg:col-span-5 rounded-2xl bg-white dark:bg-[#121E1C] border border-slate-200/80 dark:border-emerald-950/70 p-6 space-y-5">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">شخصی‌سازی و ظاهر</h2>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                نام من
              </label>
              <input
                type="text"
                value={settings.myName}
                onChange={(e) => onUpdateSettings({myName: e.target.value || 'من'})}
                className="w-full min-h-[44px] px-3.5 rounded-xl border border-slate-200 dark:border-emerald-900 bg-slate-50/70 dark:bg-[#0B1312] text-sm text-slate-900 dark:text-white"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                نام همراه
              </label>
              <input
                type="text"
                value={settings.partnerName}
                onChange={(e) => onUpdateSettings({partnerName: e.target.value || 'همراه'})}
                className="w-full min-h-[44px] px-3.5 rounded-xl border border-slate-200 dark:border-emerald-900 bg-slate-50/70 dark:bg-[#0B1312] text-sm text-slate-900 dark:text-white"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
              گوینده پیش‌فرض صدای روان فارسی
            </label>
            <select
              value={settings.defaultVoice}
              onChange={(e) => onUpdateSettings({defaultVoice: e.target.value as VoiceName})}
              className="w-full min-h-[44px] px-3.5 rounded-xl border border-slate-200 dark:border-emerald-900 bg-white dark:bg-[#0B1312] text-sm text-slate-800 dark:text-slate-100"
            >
              {VOICE_PERSONAS.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-2">
              حالت نمایش
            </label>
            <div className="grid grid-cols-2 gap-2 p-1 bg-slate-100 dark:bg-emerald-950/70 rounded-xl">
              <button
                type="button"
                onClick={() => onUpdateSettings({theme: 'light'})}
                className={`min-h-[42px] rounded-lg text-xs font-semibold flex items-center justify-center gap-2 transition-colors cursor-pointer ${
                  settings.theme === 'light'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                <Sun className="w-4 h-4" />
                <span>روز روشن</span>
              </button>
              <button
                type="button"
                onClick={() => onUpdateSettings({theme: 'dark'})}
                className={`min-h-[42px] rounded-lg text-xs font-semibold flex items-center justify-center gap-2 transition-colors cursor-pointer ${
                  settings.theme === 'dark'
                    ? 'bg-[#172724] text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                <Moon className="w-4 h-4" />
                <span>شب آرام</span>
              </button>
            </div>
          </div>
        </section>

        {/* Manual JSON Backup (Secondary offline method) */}
        <section className="lg:col-span-7 rounded-2xl bg-white dark:bg-[#121E1C] border border-slate-200/80 dark:border-emerald-950/70 p-6 space-y-5">
          <div>
            <h2 className="text-lg font-bold text-slate-900 dark:text-white">
              پشتیبان‌گیری دستی و انتقال آفلاین فایل (JSON)
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              علاوه بر همگام‌سازی خودکار ابری، همیشه می‌توانید یک نسخه فایل پشتیبان در گوشی ذخیره کنید.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => handleDownloadJson(false)}
              className="min-h-[44px] px-4 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white text-xs sm:text-sm font-semibold flex items-center gap-2 cursor-pointer"
            >
              <Download className="w-4 h-4" />
              <span>ذخیره فایل پشتیبان (JSON)</span>
            </button>

            {nativeCaps.isNative && (
              <button
                type="button"
                onClick={() => handleDownloadJson(true)}
                className="min-h-[44px] px-4 py-2.5 rounded-xl bg-slate-900 dark:bg-emerald-800 hover:bg-slate-800 text-white text-xs sm:text-sm font-semibold flex items-center gap-2 cursor-pointer"
              >
                <Share2 className="w-4 h-4" />
                <span>اشتراک‌گذاری مستقیم فایل</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleCopyCode}
              className="min-h-[44px] px-4 py-2.5 rounded-xl border border-slate-200 dark:border-emerald-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-emerald-950/40 text-xs sm:text-sm font-medium flex items-center gap-2 cursor-pointer"
            >
              {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
              <span>کپی کد پشتیبان</span>
            </button>

            {nativeCaps.isNative ? (
              <button
                type="button"
                onClick={handleNativePickJson}
                className="min-h-[44px] px-4 py-2.5 rounded-xl border border-slate-200 dark:border-emerald-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-emerald-950/40 text-xs sm:text-sm font-medium flex items-center gap-2 cursor-pointer"
              >
                <Upload className="w-4 h-4" />
                <span>بارگذاری فایل پشتیبان</span>
              </button>
            ) : (
              <label className="min-h-[44px] px-4 py-2.5 rounded-xl border border-slate-200 dark:border-emerald-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-emerald-950/40 text-xs sm:text-sm font-medium flex items-center gap-2 cursor-pointer">
                <Upload className="w-4 h-4" />
                <span>بارگذاری فایل پشتیبان</span>
                <input type="file" accept="*/*" onChange={handleFileUpload} className="hidden" />
              </label>
            )}
          </div>

          <form onSubmit={handleImportSubmit} className="pt-4 border-t border-slate-100 dark:border-emerald-950/60 space-y-3">
            <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300">
              یا کد پشتیبان دریافت‌شده را اینجا جای‌گذاری کنید
            </label>
            <textarea
              rows={2}
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              dir="ltr"
              placeholder='{"app":"roozhaye-man-o-zari", ...}'
              className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-emerald-900 bg-slate-50/70 dark:bg-[#0B1312] text-xs font-mono-num text-slate-800 dark:text-slate-200"
            />
            <button
              type="submit"
              disabled={!importText.trim()}
              className="min-h-[44px] px-5 rounded-xl bg-slate-900 dark:bg-emerald-600 disabled:opacity-50 text-white text-xs sm:text-sm font-semibold cursor-pointer"
            >
              ادغام اطلاعات
            </button>
          </form>
        </section>
      </div>
    </div>
  );
};

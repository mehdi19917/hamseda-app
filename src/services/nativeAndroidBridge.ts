import {Capacitor, registerPlugin} from '@capacitor/core';
import {VOICE_PERSONAS} from '../data/persianLibrary';
import type {
  CallerContact,
  DeviceOwner,
  ScheduledAnnouncement,
  SyncedPhoneContact,
} from '../types/app';

export interface NativeCapabilities {
  isNative: boolean;
  phoneState: boolean;
  callLog: boolean;
  contacts: boolean;
  sms: boolean;
  notificationListener: boolean;
  notifications: boolean;
  batteryIgnored: boolean;
  overlay: boolean;
  keepAliveRunning: boolean;
  exactAlarm: boolean;
  microphone?: boolean;
  dndPolicy?: boolean;
  callPhone?: boolean;
  sendSms?: boolean;
  writeSettings?: boolean;
}

interface NativeSchedulePayload {
  id: string;
  title: string;
  time: string;
  enabled: boolean;
  days: 'daily' | 'weekdays' | 'weekends';
  voiceGender: 'male' | 'female';
  voiceName?: string;
  spokenText: string;
  autoOpen: boolean;
}

interface NativeCallerPayload {
  id: string;
  name: string;
  latinAlias: string;
  persianPhonetic: string;
  template: string;
  repeatCount: number;
  voiceGender: 'male' | 'female';
  voiceName: string;
}

interface RoozhayeNativePlugin {
  getNativeCapabilities(): Promise<NativeCapabilities>;
  requestPermissionsAndMiuiSetup(): Promise<NativeCapabilities>;
  requestSmsPermissionsOnly(): Promise<NativeCapabilities>;
  openBatteryAndAutostartSettings(): Promise<NativeCapabilities>;
  openNotificationListenerSettings(): Promise<{ok: boolean}>;
  openAppInfoSettings(): Promise<{ok: boolean}>;
  openXiaomiOtherPermissions(): Promise<{ok: boolean}>;
  setKeepAliveService(options: {enabled: boolean}): Promise<{running: boolean}>;
  setServerBaseUrl(options: {url: string}): Promise<{ok: boolean}>;
  precacheNativeAudio(options: {text: string; voiceName: string; audioBase64: string}): Promise<{ok: boolean}>;
  setAnnounceToggles(options: {
    announceCalls: boolean;
    announceSms: boolean;
    announceSchedules?: boolean;
    autoOpenMorning: boolean;
    defaultGender: 'male' | 'female';
    defaultVoice: string;
  }): Promise<{ok: boolean}>;
  syncCallers(options: {callersJson: string}): Promise<{count: number}>;
  syncSchedules(options: {schedulesJson: string}): Promise<{count: number}>;
  wasScheduleFiredNatively(options: {scheduleId: string; todayKey: string}): Promise<{fired: boolean}>;
  markScheduleFiredNatively(options: {scheduleId: string; todayKey: string}): Promise<{ok: boolean}>;
  stopNativeAudio(): Promise<{ok: boolean}>;
  saveBackupJson(options: {
    filename: string;
    content: string;
    shareAfter?: boolean;
  }): Promise<{ok: boolean; savedPath?: string; shared?: boolean; error?: string}>;
  pickJsonFileNative(): Promise<{
    ok: boolean;
    name?: string;
    content?: string;
    cancelled?: boolean;
    error?: string;
  }>;
  readDeviceContacts(): Promise<{
    ok: boolean;
    permissionRequired?: boolean;
    count?: number;
    contactsJson?: string;
    error?: string;
  }>;
  saveLearnedPhonetics(options: {phoneticsJson: string}): Promise<{ok: boolean; count?: number}>;
  speakNativeBilingual(options: {text: string; gender: 'male' | 'female'; rate: number}): Promise<{ok: boolean}>;
  testNativeCallAnnouncement(options: {name: string; script: string; gender: 'male' | 'female'; voiceName?: string}): Promise<{ok: boolean}>;
  testNativeSmsAnnouncement(options: {sender: string; body: string; gender: 'male' | 'female'; voiceName?: string}): Promise<{ok: boolean}>;
  setDeviceIdentity(options: {
    deviceOwner: DeviceOwner;
    selfName: string;
    partnerName: string;
    assistantName: string;
  }): Promise<{ok: boolean}>;
  listenOncePersian(): Promise<{
    ok: boolean;
    transcript?: string;
    permissionRequired?: boolean;
    errorCode?: number;
    error?: string;
  }>;
  stopListening(): Promise<{ok: boolean}>;
  startWakeWordService(options: {assistantName: string}): Promise<{ok: boolean; permissionRequired?: boolean; message?: string}>;
  stopWakeWordService(): Promise<{ok: boolean}>;
  executeDeviceAction(options: {
    action: string;
    phone?: string;
    smsBody?: string;
    name?: string;
    url?: string;
    query?: string;
    hour?: number;
    minute?: number;
    seconds?: number;
  }): Promise<{
    ok: boolean;
    message?: string;
    recording?: boolean;
    savedPath?: string;
    permissionRequired?: boolean;
    needsPolicyAccess?: boolean;
    needsWriteSettings?: boolean;
  }>;
}

const RoozhayeNative = registerPlugin<RoozhayeNativePlugin>('RoozhayeNative');

export function isNativeAndroid(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

export function getVoiceGender(voiceName: string): 'male' | 'female' {
  const persona = VOICE_PERSONAS.find((v) => v.id === voiceName);
  return persona?.gender ?? 'female';
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export async function getNativeCapabilities(): Promise<NativeCapabilities> {
  if (!isNativeAndroid()) {
    return {
      isNative: false,
      phoneState: false,
      callLog: false,
      contacts: false,
      sms: false,
      notificationListener: false,
      notifications: typeof Notification !== 'undefined' && Notification.permission === 'granted',
      batteryIgnored: false,
      overlay: false,
      keepAliveRunning: false,
      exactAlarm: false,
    };
  }
  try {
    const caps = await RoozhayeNative.getNativeCapabilities();
    return {
      ...caps,
      notificationListener: Boolean(caps.notificationListener),
    };
  } catch {
    return {
      isNative: true,
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
    };
  }
}

export async function requestNativePermissionsAndMiuiSetup(): Promise<NativeCapabilities | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await RoozhayeNative.requestPermissionsAndMiuiSetup();
  } catch {
    return null;
  }
}

export async function requestSmsPermissionsOnlyNative(): Promise<NativeCapabilities | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await RoozhayeNative.requestSmsPermissionsOnly();
  } catch {
    return null;
  }
}

export async function openBatteryAndAutostartSettingsNative(): Promise<NativeCapabilities | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await RoozhayeNative.openBatteryAndAutostartSettings();
  } catch {
    return null;
  }
}

export async function openNotificationListenerSettings(): Promise<boolean> {
  if (!isNativeAndroid()) return false;
  try {
    const res = await RoozhayeNative.openNotificationListenerSettings();
    return res.ok;
  } catch {
    return false;
  }
}

export async function openAppInfoSettings(): Promise<boolean> {
  if (!isNativeAndroid()) return false;
  try {
    const res = await RoozhayeNative.openAppInfoSettings();
    return res.ok;
  } catch {
    return false;
  }
}

export async function openXiaomiOtherPermissions(): Promise<boolean> {
  if (!isNativeAndroid()) return false;
  try {
    const res = await RoozhayeNative.openXiaomiOtherPermissions();
    return res.ok;
  } catch {
    return false;
  }
}

export async function wasScheduleFiredNatively(scheduleId: string, todayKey: string): Promise<boolean> {
  if (!isNativeAndroid()) return false;
  try {
    const res = await RoozhayeNative.wasScheduleFiredNatively({scheduleId, todayKey});
    return Boolean(res.fired);
  } catch {
    return false;
  }
}

export async function markScheduleFiredNatively(scheduleId: string, todayKey: string): Promise<void> {
  if (!isNativeAndroid()) return;
  try {
    await RoozhayeNative.markScheduleFiredNatively({scheduleId, todayKey});
  } catch {
    // ignore
  }
}

export async function stopNativeAudio(): Promise<void> {
  if (!isNativeAndroid()) return;
  try {
    await RoozhayeNative.stopNativeAudio();
  } catch {
    // ignore
  }
}

export async function saveBackupJsonNative(
  filename: string,
  content: string,
  shareAfter = false
): Promise<{ok: boolean; savedPath?: string; shared?: boolean; error?: string}> {
  if (!isNativeAndroid()) return {ok: false};
  try {
    return await RoozhayeNative.saveBackupJson({filename, content, shareAfter});
  } catch (err) {
    return {ok: false, error: err instanceof Error ? err.message : 'خطا در ذخیره فایل'};
  }
}

export async function pickJsonFileNative(): Promise<{
  ok: boolean;
  name?: string;
  content?: string;
  cancelled?: boolean;
  error?: string;
}> {
  if (!isNativeAndroid()) return {ok: false};
  try {
    return await RoozhayeNative.pickJsonFileNative();
  } catch (err) {
    return {ok: false, error: err instanceof Error ? err.message : 'خطا در باز کردن فایل'};
  }
}

export async function setNativeKeepAliveService(enabled: boolean): Promise<boolean> {
  if (!isNativeAndroid()) return false;
  try {
    const res = await RoozhayeNative.setKeepAliveService({enabled});
    return res.running;
  } catch {
    return false;
  }
}

export async function syncServerBaseUrlToNative(url: string): Promise<void> {
  if (!isNativeAndroid() || !url.trim()) return;
  try {
    await RoozhayeNative.setServerBaseUrl({url: url.trim()});
  } catch {
    // ignore
  }
}

export async function precacheNativeWav(text: string, voiceName: string, buffer: ArrayBuffer): Promise<boolean> {
  if (!isNativeAndroid() || !text.trim() || buffer.byteLength <= 44) return false;
  try {
    const res = await RoozhayeNative.precacheNativeAudio({
      text: text.trim(),
      voiceName,
      audioBase64: arrayBufferToBase64(buffer),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function syncAnnounceTogglesToNative(options: {
  announceCalls: boolean;
  announceSms: boolean;
  announceSchedules?: boolean;
  autoOpenMorning: boolean;
  defaultVoice: string;
}): Promise<void> {
  if (!isNativeAndroid()) return;
  try {
    await RoozhayeNative.setAnnounceToggles({
      announceCalls: options.announceCalls,
      announceSms: options.announceSms,
      announceSchedules: options.announceSchedules ?? true,
      autoOpenMorning: options.autoOpenMorning,
      defaultGender: getVoiceGender(options.defaultVoice),
      defaultVoice: options.defaultVoice,
    });
  } catch {
    // ignore
  }
}

export async function syncCallersToNative(callers: CallerContact[]): Promise<void> {
  if (!isNativeAndroid()) return;
  try {
    const payload: NativeCallerPayload[] = callers.map((c) => ({
      id: c.id,
      name: c.name,
      latinAlias: c.latinAlias ?? '',
      persianPhonetic: c.persianPhonetic ?? '',
      template: c.template,
      repeatCount: c.repeatCount,
      voiceGender: getVoiceGender(c.voiceName),
      voiceName: c.voiceName,
    }));
    await RoozhayeNative.syncCallers({callersJson: JSON.stringify(payload)});
  } catch {
    // ignore if running in web or plugin unavailable
  }
}

export async function syncSchedulesToNative(
  schedules: ScheduledAnnouncement[],
  resolveText: (s: ScheduledAnnouncement) => string,
  autoOpenMorning = true
): Promise<void> {
  if (!isNativeAndroid()) return;
  try {
    const payload: NativeSchedulePayload[] = schedules.map((s) => ({
      id: s.id,
      title: s.title,
      time: s.time,
      enabled: s.enabled,
      days: s.days,
      voiceGender: getVoiceGender(s.voiceName),
      voiceName: s.voiceName,
      spokenText: resolveText(s),
      autoOpen: autoOpenMorning && s.topic === 'morning',
    }));
    await RoozhayeNative.syncSchedules({schedulesJson: JSON.stringify(payload)});
  } catch {
    // ignore
  }
}

export async function speakNativeBilingual(
  text: string,
  gender: 'male' | 'female',
  rate = 1
): Promise<boolean> {
  if (!isNativeAndroid()) return false;
  try {
    const res = await RoozhayeNative.speakNativeBilingual({text, gender, rate});
    return res.ok;
  } catch {
    return false;
  }
}

export async function testNativeCallAnnouncement(
  name: string,
  script: string,
  gender: 'male' | 'female',
  voiceName?: string
): Promise<boolean> {
  if (!isNativeAndroid()) return false;
  try {
    const res = await RoozhayeNative.testNativeCallAnnouncement({name, script, gender, voiceName});
    return res.ok;
  } catch {
    return false;
  }
}

export async function testNativeSmsAnnouncement(
  sender: string,
  body: string,
  gender: 'male' | 'female',
  voiceName?: string
): Promise<boolean> {
  if (!isNativeAndroid()) return false;
  try {
    const res = await RoozhayeNative.testNativeSmsAnnouncement({sender, body, gender, voiceName});
    return res.ok;
  } catch {
    return false;
  }
}

export async function readDeviceContactsNative(): Promise<{
  ok: boolean;
  permissionRequired?: boolean;
  count: number;
  contacts: SyncedPhoneContact[];
  error?: string;
}> {
  if (!isNativeAndroid()) {
    return {ok: false, count: 0, contacts: [], error: 'فقط در نسخه اندروید (APK)'};
  }
  try {
    const res = await RoozhayeNative.readDeviceContacts();
    if (!res.ok) {
      return {
        ok: false,
        permissionRequired: Boolean(res.permissionRequired),
        count: 0,
        contacts: [],
        error: res.error,
      };
    }
    const parsed = res.contactsJson
      ? (JSON.parse(res.contactsJson) as {name?: string; phone?: string; persianPhonetic?: string}[])
      : [];
    const contacts: SyncedPhoneContact[] = parsed
      .filter((item) => item && typeof item.name === 'string' && item.name.trim())
      .map((item) => ({
        name: String(item.name).trim(),
        phone: String(item.phone || '').trim(),
        persianPhonetic: String(item.persianPhonetic || item.name).trim(),
      }));
    return {
      ok: true,
      count: res.count ?? contacts.length,
      contacts,
    };
  } catch (err) {
    return {
      ok: false,
      count: 0,
      contacts: [],
      error: err instanceof Error ? err.message : 'خطا در خواندن دفترچه تلفن',
    };
  }
}

export async function saveLearnedPhoneticsNative(phonetics: Record<string, string>): Promise<boolean> {
  if (!isNativeAndroid()) return false;
  try {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(phonetics)) {
      const key = k.trim().toLowerCase();
      const val = v.trim();
      if (key && val) {
        clean[key] = val;
      }
    }
    const res = await RoozhayeNative.saveLearnedPhonetics({
      phoneticsJson: JSON.stringify(clean),
    });
    return Boolean(res.ok);
  } catch {
    return false;
  }
}

export async function setDeviceIdentityNative(options: {
  deviceOwner: DeviceOwner;
  selfName: string;
  partnerName: string;
  assistantName: string;
}): Promise<boolean> {
  if (!isNativeAndroid()) return false;
  try {
    const res = await RoozhayeNative.setDeviceIdentity(options);
    return Boolean(res.ok);
  } catch {
    return false;
  }
}

export async function listenOncePersianNative(): Promise<{
  ok: boolean;
  transcript?: string;
  permissionRequired?: boolean;
  errorCode?: number;
  error?: string;
}> {
  if (!isNativeAndroid()) {
    return {ok: false, error: 'Web Speech fallback'};
  }
  try {
    return await RoozhayeNative.listenOncePersian();
  } catch (err) {
    return {ok: false, error: err instanceof Error ? err.message : 'خطای میکروفون'};
  }
}

export async function startNativeWakeWordService(assistantName: string): Promise<{ok: boolean; permissionRequired?: boolean; message?: string}> {
  if (!isNativeAndroid()) return {ok: false};
  try {
    return await RoozhayeNative.startWakeWordService({assistantName});
  } catch (err) {
    return {ok: false, message: err instanceof Error ? err.message : 'شروع شنود پس‌زمینه ممکن نشد'};
  }
}

export async function stopNativeWakeWordService(): Promise<void> {
  if (!isNativeAndroid()) return;
  try {
    await RoozhayeNative.stopWakeWordService();
  } catch {
    // Native service may already be stopped.
  }
}

export async function stopListeningNative(): Promise<void> {
  if (!isNativeAndroid()) return;
  try {
    await RoozhayeNative.stopListening();
  } catch {
    // ignore
  }
}

export async function executeDeviceActionNative(options: {
  action: string;
  phone?: string;
  smsBody?: string;
  name?: string;
  url?: string;
  query?: string;
  hour?: number;
  minute?: number;
  seconds?: number;
}): Promise<{
  ok: boolean;
  message?: string;
  recording?: boolean;
  savedPath?: string;
  permissionRequired?: boolean;
  needsPolicyAccess?: boolean;
  needsWriteSettings?: boolean;
}> {
  if (!isNativeAndroid()) {
    if (options.action === 'open_url' && options.url) {
      return {ok: true, message: 'لینک آماده باز شدن در مرورگر است.'};
    }
    return {
      ok: false,
      message: 'این دستور سخت‌افزاری گوشی در نسخه اندروید (APK) اجرا می‌شود.',
    };
  }
  try {
    return await RoozhayeNative.executeDeviceAction(options);
  } catch (err) {
    return {ok: false, message: err instanceof Error ? err.message : 'خطا در اجرای دستور روی گوشی'};
  }
}

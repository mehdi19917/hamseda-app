import type {AppSettings, DeviceOwner, LocalVoiceControls} from '../types/app';

export const DEVICE_OWNER_STORAGE_KEY = 'rmz_device_owner_v1';
export const LOCAL_VOICE_CONTROLS_KEY = 'rmz_local_voice_controls_v1';

export const DEFAULT_LOCAL_VOICE_CONTROLS: LocalVoiceControls = {
  masterSpeakerEnabled: true,
  autoCallAnnounce: true,
  autoSmsAnnounce: true,
  autoScheduleAnnounce: true,
  autoAssistantSpeak: true,
};

export function readLocalVoiceControls(): LocalVoiceControls {
  try {
    const raw = localStorage.getItem(LOCAL_VOICE_CONTROLS_KEY);
    if (!raw) return {...DEFAULT_LOCAL_VOICE_CONTROLS};
    const parsed = JSON.parse(raw) as Partial<LocalVoiceControls>;
    return {
      masterSpeakerEnabled:
        parsed.masterSpeakerEnabled !== undefined ? Boolean(parsed.masterSpeakerEnabled) : true,
      autoCallAnnounce:
        parsed.autoCallAnnounce !== undefined ? Boolean(parsed.autoCallAnnounce) : true,
      autoSmsAnnounce:
        parsed.autoSmsAnnounce !== undefined ? Boolean(parsed.autoSmsAnnounce) : true,
      autoScheduleAnnounce:
        parsed.autoScheduleAnnounce !== undefined ? Boolean(parsed.autoScheduleAnnounce) : true,
      autoAssistantSpeak:
        parsed.autoAssistantSpeak !== undefined ? Boolean(parsed.autoAssistantSpeak) : true,
    };
  } catch {
    return {...DEFAULT_LOCAL_VOICE_CONTROLS};
  }
}

export function writeLocalVoiceControls(controls: LocalVoiceControls): void {
  try {
    localStorage.setItem(LOCAL_VOICE_CONTROLS_KEY, JSON.stringify(controls));
  } catch {
    // ignore storage errors
  }
}

export async function refreshAppShell(): Promise<void> {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.update().catch(() => {})));
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k).catch(() => false)));
    }
  } catch {
    // ignore cache cleanup failures
  }
  window.location.reload();
}

export function readDeviceOwner(): DeviceOwner {
  try {
    const raw = localStorage.getItem(DEVICE_OWNER_STORAGE_KEY);
    return raw === 'zari' ? 'zari' : 'man';
  } catch {
    return 'man';
  }
}

export function writeDeviceOwner(owner: DeviceOwner): void {
  try {
    localStorage.setItem(DEVICE_OWNER_STORAGE_KEY, owner);
  } catch {
    // ignore storage errors
  }
}

export function getSelfName(settings: Pick<AppSettings, 'myName' | 'partnerName'>, deviceOwner: DeviceOwner): string {
  const man = settings.myName?.trim() || 'من';
  const zari = settings.partnerName?.trim() || 'همراه';
  return deviceOwner === 'zari' ? zari : man;
}

export function getPartnerNameForDevice(
  settings: Pick<AppSettings, 'myName' | 'partnerName'>,
  deviceOwner: DeviceOwner
): string {
  const man = settings.myName?.trim() || 'من';
  const zari = settings.partnerName?.trim() || 'همراه';
  return deviceOwner === 'zari' ? man : zari;
}

/**
 * Returns the couple names ordered so the current phone's owner is always addressed FIRST.
 * The current device owner is always addressed first.
 */
export function getOrderedPairNames(
  settings: Pick<AppSettings, 'myName' | 'partnerName'>,
  deviceOwner: DeviceOwner
): string {
  const first = getSelfName(settings, deviceOwner);
  const second = getPartnerNameForDevice(settings, deviceOwner);
  return `${first} و ${second}`;
}

/**
 * Adapts shared/offline texts so the current device owner is addressed first.
 */
export function adaptTextForDevice(
  text: string,
  settings: Pick<AppSettings, 'myName' | 'partnerName'>,
  deviceOwner: DeviceOwner
): string {
  if (!text) return text;
  const man = settings.myName?.trim() || 'من';
  const zari = settings.partnerName?.trim() || 'همراه';
  if (deviceOwner !== 'zari') {
    return text.replace(/من و همراه/g, `${man} و ${zari}`);
  }
  return text
    .replace(new RegExp(`${man} و ${zari}`, 'g'), `${zari} و ${man}`)
    .replace(new RegExp(`برای ${zari} بفرستید`, 'g'), `برای ${man} بفرستید`)
    .replace(new RegExp(`به ${zari} ارسال کنید`, 'g'), `به ${man} ارسال کنید`)
    .replace(new RegExp(`لبخند ${zari}`, 'g'), `لبخند ${man}`)
    .replace(new RegExp(`کنار ${zari}`, 'g'), `کنار ${man}`)
    .replace(new RegExp(`زحمات امروز ${zari}`, 'g'), `زحمات امروز ${man}`)
    .replace(new RegExp(`${zari} جان،`, 'g'), `${man} جان،`)
    .replace(new RegExp(`حضور گرم ${zari}`, 'g'), `حضور گرم ${man}`)
    .replace(/من و همراه/g, `${zari} و ${man}`);
}

export function normalizeAssistantText(raw: string): string {
  return raw
    .trim()
    .replace(/[ي]/g, 'ی')
    .replace(/[ك]/g, 'ک')
    .replace(/[أإآ]/g, 'ا')
    .replace(/[\u200c\s]+/g, ' ')
    .toLowerCase();
}

export function extractCommandAfterWakeWord(
  transcript: string,
  assistantName: string
): {matched: boolean; onlyWakeWord: boolean; command: string} {
  const cleanName = normalizeAssistantText(assistantName || 'هم‌صدا');
  const norm = normalizeAssistantText(transcript);
  if (!norm) return {matched: false, onlyWakeWord: false, command: ''};

  const aliases = new Set<string>([cleanName]);
  if (cleanName === 'هم صدا' || cleanName === 'همصدا') {
    aliases.add('هم صدا');
    aliases.add('همصدا');
    aliases.add('هم‌صدا');
    aliases.add('hamseda');
  }
  if (cleanName === 'اوا' || cleanName === 'آوا') {
    aliases.add('اوا');
    aliases.add('آوا');
    aliases.add('ava');
  }

  for (const alias of aliases) {
    if (!alias) continue;
    if (norm === alias || norm === `سلام ${alias}` || norm === `جانم ${alias}` || norm === `هی ${alias}`) {
      return {matched: true, onlyWakeWord: true, command: ''};
    }
    const idx = norm.indexOf(alias);
    if (idx !== -1) {
      const after = norm
        .slice(idx + alias.length)
        .replace(/^[\s،,:؛.!؟-]+/, '')
        .trim();
      const before = norm.slice(0, idx).replace(/^(سلام|هی|بگو)\s+/i, '').trim();
      const combined = after || before;
      return {
        matched: true,
        onlyWakeWord: combined.length === 0,
        command: combined,
      };
    }
  }
  return {matched: false, onlyWakeWord: false, command: transcript.trim()};
}

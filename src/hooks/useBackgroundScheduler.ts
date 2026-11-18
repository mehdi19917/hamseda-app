import {useCallback, useEffect, useRef, useState} from 'react';
import {getTodayKey} from '../data/persianLibrary';
import {
  isNativeAndroid,
  markScheduleFiredNatively,
  wasScheduleFiredNatively,
} from '../services/nativeAndroidBridge';
import type {ScheduledAnnouncement} from '../types/app';

const dispatchedTodayKeys = new Set<string>();
const LS_LOCK_PREFIX = 'rmz_sched_lock_v1_';

function createSilentWavBlobUrl(): string {
  const sampleRate = 8000;
  const numSamples = sampleRate * 2; // 2 seconds of near-silence
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);
  const writeStr = (pos: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(pos + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, numSamples * 2, true);
  return URL.createObjectURL(new Blob([buffer], {type: 'audio/wav'}));
}

function matchesDayFilter(days: ScheduledAnnouncement['days'], date: Date): boolean {
  if (days === 'daily') return true;
  // In Iran: Friday (5) and Thursday (4) are weekend; Sat(6)..Wed(3) weekdays
  const day = date.getDay();
  const isWeekend = day === 4 || day === 5;
  return days === 'weekends' ? isWeekend : !isWeekend;
}

export function useBackgroundScheduler(params: {
  schedules: ScheduledAnnouncement[];
  keepAliveEnabled: boolean;
  onTriggerSchedule: (schedule: ScheduledAnnouncement, isManualTest?: boolean) => void | Promise<void>;
  onMarkTriggered: (scheduleId: string, dateKey: string) => void;
  onStatusToast: (msg: string) => void;
}) {
  const {schedules, keepAliveEnabled, onTriggerSchedule, onMarkTriggered, onStatusToast} = params;
  const [notifPermission, setNotifPermission] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'default'
  );
  const [keepAliveActive, setKeepAliveActive] = useState(false);

  const silentAudioRef = useRef<HTMLAudioElement | null>(null);
  const silentUrlRef = useRef<string | null>(null);

  const requestNotificationPermission = useCallback(async () => {
    if (typeof Notification === 'undefined') {
      onStatusToast('این مرورگر از اعلان‌های سیستم پشتیبانی نمی‌کند.');
      return 'denied' as NotificationPermission;
    }
    const perm = await Notification.requestPermission();
    setNotifPermission(perm);
    if (perm === 'granted') {
      onStatusToast('اعلان‌های گوشی فعال شدند. در زمان‌های تعیین‌شده پیام و صوت برایتان ارسال می‌شود.');
    } else {
      onStatusToast('دسترسی اعلان‌ها تایید نشد. می‌توانید از تنظیمات سایت در مرورگر اجازه دهید.');
    }
    return perm;
  }, [onStatusToast]);

  const showSystemNotification = useCallback(
    async (title: string, body: string, scheduleId: string) => {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      try {
        if ('serviceWorker' in navigator) {
          const reg = await navigator.serviceWorker.ready;
          await reg.showNotification(title, {
            body,
            icon: '/icon.svg',
            badge: '/icon.svg',
            dir: 'rtl',
            lang: 'fa',
            tag: `rmz-${scheduleId}`,
            data: {scheduleId},
          });
          return;
        }
        new Notification(title, {
          body,
          icon: '/icon.svg',
          dir: 'rtl',
          lang: 'fa',
        });
      } catch (err) {
        console.warn('Notification error:', err);
      }
    },
    []
  );

  // Manage silent MediaSession audio loop so mobile browsers keep JS timers alive in background
  // (Inside Native Android APK, KeepAliveForegroundService handles background execution natively.)
  useEffect(() => {
    if (!keepAliveEnabled || isNativeAndroid()) {
      if (silentAudioRef.current) {
        silentAudioRef.current.pause();
        silentAudioRef.current = null;
      }
      if (silentUrlRef.current) {
        URL.revokeObjectURL(silentUrlRef.current);
        silentUrlRef.current = null;
      }
      setKeepAliveActive(false);
      return;
    }

    const url = createSilentWavBlobUrl();
    silentUrlRef.current = url;
    const audio = new Audio(url);
    audio.loop = true;
    audio.volume = 0.01;
    silentAudioRef.current = audio;

    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: 'زمان‌بند هوشمند هم‌صدا',
        artist: 'فعال در پس‌زمینه برای اعلام پیام صبحگاهی و اهداف',
        album: 'هم‌صدا',
        artwork: [{src: '/icon.svg', sizes: 'any', type: 'image/svg+xml'}],
      });
    }

    audio
      .play()
      .then(() => setKeepAliveActive(true))
      .catch(() => {
        // Will activate on next user interaction if blocked initially
        setKeepAliveActive(false);
      });

    return () => {
      audio.pause();
      URL.revokeObjectURL(url);
      silentAudioRef.current = null;
      silentUrlRef.current = null;
    };
  }, [keepAliveEnabled]);

  // Listen to Service Worker notification clicks
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onSwMsg = (event: MessageEvent) => {
      if (event.data?.type === 'PLAY_SCHEDULE' && event.data?.scheduleId) {
        const found = schedules.find((s) => s.id === event.data.scheduleId);
        if (found) onTriggerSchedule(found, true);
      }
    };
    navigator.serviceWorker.addEventListener('message', onSwMsg);
    return () => navigator.serviceWorker.removeEventListener('message', onSwMsg);
  }, [schedules, onTriggerSchedule]);

  // Check URL ?playSchedule=... when opened from notification
  useEffect(() => {
    const paramsUrl = new URLSearchParams(window.location.search);
    const sid = paramsUrl.get('playSchedule');
    if (sid) {
      const found = schedules.find((s) => s.id === sid);
      if (found) {
        window.history.replaceState({}, '', '/');
        onTriggerSchedule(found, true);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Periodic scheduler tick (every 15 seconds) with native + synchronous dedup guard
  const isCheckingRef = useRef(false);
  useEffect(() => {
    const checkSchedules = async () => {
      if (isCheckingRef.current) return;
      isCheckingRef.current = true;
      try {
        const now = new Date();
        const todayKey = getTodayKey(now);
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        const currentHm = `${hh}:${mm}`;

        for (const item of schedules) {
          if (!item.enabled) continue;
          if (item.lastTriggeredDate === todayKey) continue;
          if (!matchesDayFilter(item.days, now)) continue;
          if (item.time !== currentHm) continue;

          const lockKey = `${item.id}::${todayKey}`;
          if (dispatchedTodayKeys.has(lockKey)) continue;

          try {
            if (localStorage.getItem(`${LS_LOCK_PREFIX}${lockKey}`) === todayKey) {
              dispatchedTodayKeys.add(lockKey);
              onMarkTriggered(item.id, todayKey);
              continue;
            }
          } catch {
            // ignore storage errors
          }

          if (isNativeAndroid()) {
            // Give Android AlarmManager (especially Android 12/MIUI inexact wakeups) 45 full seconds
            // to deliver ScheduleAlarmReceiver before WebView ever attempts a fallback.
            const firedNatively = await wasScheduleFiredNatively(item.id, todayKey);
            if (firedNatively) {
              dispatchedTodayKeys.add(lockKey);
              try {
                localStorage.setItem(`${LS_LOCK_PREFIX}${lockKey}`, todayKey);
              } catch {
                // ignore
              }
              onMarkTriggered(item.id, todayKey);
              continue;
            }
            if (now.getSeconds() < 45) continue;
            // Claim the native lock synchronously BEFORE WebView starts speaking so delayed OS alarms cannot overlap
            await markScheduleFiredNatively(item.id, todayKey);
          }

          dispatchedTodayKeys.add(lockKey);
          try {
            localStorage.setItem(`${LS_LOCK_PREFIX}${lockKey}`, todayKey);
          } catch {
            // ignore
          }
          onMarkTriggered(item.id, todayKey);
          await onTriggerSchedule(item, false);
        }
      } finally {
        isCheckingRef.current = false;
      }
    };

    void checkSchedules();
    const timer = window.setInterval(() => {
      void checkSchedules();
    }, 15000);
    return () => window.clearInterval(timer);
  }, [schedules, onMarkTriggered, onTriggerSchedule]);

  return {
    notifPermission,
    keepAliveActive,
    requestNotificationPermission,
    showSystemNotification,
  };
}

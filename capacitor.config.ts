import type {CapacitorConfig} from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.roozhaye.manozari',
  appName: 'هم‌صدا',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    allowNavigation: [
      'modified-transport-wv0ns.firebaseapp.com',
      '*.firebaseapp.com',
      'accounts.google.com',
      '*.google.com',
      '*.run.app',
    ],
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;

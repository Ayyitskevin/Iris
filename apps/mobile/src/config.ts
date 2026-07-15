import Constants from 'expo-constants';

/**
 * API base URL. Set EXPO_PUBLIC_API_URL for real devices (localhost won't resolve from
 * a phone). Falls back to the dev server on the machine running Metro.
 */
export const API_URL: string =
  process.env.EXPO_PUBLIC_API_URL ??
  (Constants.expoConfig?.extra?.apiUrl as string | undefined) ??
  'http://localhost:4000';

import { uiText, type UiLocale, type UiTextKey } from './i18n.js';

export type AppearancePreference = 'system' | 'light' | 'dark';

export const APPEARANCE_STORAGE_KEY = 'chatsplice.appearance.v1';

export function isAppearancePreference(value: string | null): value is AppearancePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function translator(currentLocale: UiLocale, appName?: string) {
  return (key: UiTextKey, values: Record<string, string | number> = {}): string =>
    uiText(currentLocale, key, appName === undefined ? values : { app: appName, ...values });
}

export type Translate = ReturnType<typeof translator>;

export function applyAppearance(preference: AppearancePreference, prefersDark: boolean): void {
  const resolved = preference === 'system' ? (prefersDark ? 'dark' : 'light') : preference;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}

const CHATGPT_HOSTS = ['chatgpt.com'];
const AUTH_HOSTS = [
  'auth.openai.com',
  'login.openai.com',
  'accounts.google.com',
  'appleid.apple.com',
  'login.microsoftonline.com',
];

function hostnameMatches(hostname: string, allowed: readonly string[]): boolean {
  return allowed.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

function parsedHttpsUrl(input: string): URL | undefined {
  try {
    const url = new URL(input);
    return url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

export function isAllowedChatGptNavigation(input: string): boolean {
  const url = parsedHttpsUrl(input);
  return url !== undefined && hostnameMatches(url.hostname, [...CHATGPT_HOSTS, ...AUTH_HOSTS]);
}

export function isRestorableChatGptUrl(input: string): boolean {
  const url = parsedHttpsUrl(input);
  return url !== undefined && url.hostname === 'chatgpt.com';
}

export function isAllowedAuthPopup(input: string): boolean {
  const url = parsedHttpsUrl(input);
  return url !== undefined && hostnameMatches(url.hostname, [...CHATGPT_HOSTS, ...AUTH_HOSTS]);
}

export function isSafeExternalUrl(input: string): boolean {
  return parsedHttpsUrl(input) !== undefined;
}

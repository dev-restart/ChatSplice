/** The common User-Agent API exposed by Electron Session and WebContents. */
interface BrowserIdentityTarget {
  getUserAgent(): string;
  setUserAgent(userAgent: string): void;
}

/**
 * ChatSplice embeds the web client, not the official ChatGPT desktop bridge.
 * Remove only our wrapper's product tokens so an Electron sniff cannot opt
 * this view into native-only UI. Keep the real OS, Chromium and WebKit versions;
 * do not manufacture a browser version or claim to be an OpenAI application.
 */
export function chatGptBrowserUserAgent(userAgent: string): string {
  // Fail unchanged for an unexpected non-Chromium identity rather than build
  // a partial or misleading browser identifier.
  if (!/(?:^|\s)Chrome\/\d+(?:\.\d+)*(?:\s|$)/.test(userAgent)) return userAgent;
  return userAgent
    .replace(/(^|\s)(?:Electron|ChatSplice|LocalChat|localchat-ade|chatgpt-ade)\/\S+/gi, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Call for the remote session before constructing its first view, and for
 * remote WebContents before loading. Never alter the local renderer session,
 * clear login storage, inject page globals or add a native bridge.
 */
export function configureChatGptBrowserIdentity(target: BrowserIdentityTarget): void {
  const current = target.getUserAgent();
  const browser = chatGptBrowserUserAgent(current);
  if (browser !== current) target.setUserAgent(browser);
}

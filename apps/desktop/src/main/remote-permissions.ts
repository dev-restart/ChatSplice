const CHATGPT_ORIGIN = 'https://chatgpt.com';

/**
 * Every remote permission is denied by default — defense in depth against a
 * compromised or injected script on the ChatGPT page (e.g. silent clipboard
 * hijacking). The one narrow exception: chatgpt.com may write to the OS
 * clipboard, so its own message "Copy" button works. `requestingOrigin` is
 * fed either a bare origin (session.setPermissionCheckHandler) or a full page
 * URL (webContents.getURL(), used by setPermissionRequestHandler) — parsing
 * it with `URL` normalizes both and fails closed on anything malformed, so a
 * lookalike host (chatgpt.com.evil.example) never matches. Clipboard READ,
 * camera, microphone, and every other permission stay denied for every
 * origin, including chatgpt.com itself. ChatSplice's own project-binding copy
 * is performed by Electron main and never needs a remote page permission.
 */
export const allowsRemotePermission: (permission: string, requestingOrigin: string) => boolean = (
  permission,
  requestingOrigin,
) => {
  if (permission !== 'clipboard-sanitized-write') return false;
  try {
    return new URL(requestingOrigin).origin === CHATGPT_ORIGIN;
  } catch {
    return false;
  }
};

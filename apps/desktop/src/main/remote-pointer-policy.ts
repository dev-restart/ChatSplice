import type { WebContents } from 'electron';

/**
 * Only ChatSplice's own titlebar may define native window-drag regions.
 * A web page's app-region: drag can otherwise swallow mouse clicks in Electron
 * even though the same button works in a normal browser. Do not override
 * pointer-events, disabled controls, layout, visibility or the page's handlers.
 */
export const CHATGPT_NO_DRAG_CSS = `
:root, :root *, :root::before, :root::after, :root *::before, :root *::after {
  -webkit-app-region: no-drag !important;
  app-region: no-drag !important;
}
`;

export function isChatGptPointerPolicyUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return url.origin === 'https://chatgpt.com' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

/** No DOM reads, preload, private endpoints or synthetic clicks on ChatGPT. */
export function installChatGptPointerPolicy(
  contents: Pick<WebContents, 'on' | 'getURL' | 'isDestroyed' | 'insertCSS'>,
): void {
  contents.on('dom-ready', () => {
    if (contents.isDestroyed() || !isChatGptPointerPolicyUrl(contents.getURL())) return;
    // User-origin !important also beats inline author-origin drag declarations.
    // The stylesheet belongs to this document; full navigations reinstall it.
    void contents.insertCSS(CHATGPT_NO_DRAG_CSS, { cssOrigin: 'user' }).catch(() => {
      // No URL, page content or login information is recorded on failure.
      if (!contents.isDestroyed()) {
        process.stderr.write('[ChatSplice] Remote pointer policy could not be applied.\n');
      }
    });
  });
}

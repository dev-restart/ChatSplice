import { DEFAULT_MCP_APP_NAME, LEGACY_MCP_APP_NAMES } from '@chatsplice/protocol';

const AUTOMATION_TIMEOUT_MS = 3_000;

/**
 * Exact labels the app pill / picker item may carry. The Korean UI shows the
 * localized "로컬 MCP" label only for the legacy default name; any other name
 * is matched verbatim so a differently named app is never picked by mistake.
 */
export function localMcpAppLabels(appName: string): string[] {
  return appName === LEGACY_MCP_APP_NAMES[0] ? [...LEGACY_MCP_APP_NAMES] : [appName];
}

/**
 * Owner-opted-in, per-project convenience only: re-selects the fixed
 * configured custom app in the current ChatGPT composer so the owner does
 * not have to pick it by hand on every message. It never grants a new
 * capability — the owner could already click this by hand — and it fails
 * closed: if the composer, its app-picker control, or the app menu
 * item cannot be located, it does nothing and reports why, the same way
 * {@link buildChatGptProjectAutomationScript} does for Project setup. It
 * reads no message text, conversation history, cookies, or storage.
 */
export function buildLocalMcpAutoAttachScript(appName: string = DEFAULT_MCP_APP_NAME): string {
  return `(() => {
    if (location.origin !== 'https://chatgpt.com') return 'not_chatgpt';
    if (document.visibilityState !== 'visible') return 'not_visible';
    const timeoutMs = ${AUTOMATION_TIMEOUT_MS};
    const openerLabels = [
      '파일 등 추가',
      '사진 및 파일 추가',
      'Add photos and files',
      'Add photos & files',
      'Add files',
      '도구 추가',
      'Add tools',
      '앱 추가',
      'Add apps',
      'Tools',
      'Apps',
    ];
    const localMcpLabels = ${JSON.stringify(localMcpAppLabels(appName))};
    const normalized = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
    const visible = (element) => {
      if (!(element instanceof HTMLElement) || element.isConnected === false) return false;
      const style = window.getComputedStyle(element);
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        element.getClientRects().length > 0
      );
    };
    const exactAttributeLabel = (element) =>
      normalized(element.getAttribute('aria-label') || element.getAttribute('title'));
    const scopedTextLabel = (element) =>
      normalized(exactAttributeLabel(element) || element.textContent);
    const blockedBoundary = (element) => {
      if (!(element instanceof HTMLElement)) return true;
      const tag = String(element.tagName || '').toLowerCase();
      if (tag === 'header' || tag === 'nav' || tag === 'aside') return true;
      const role = normalized(element.getAttribute('role')).toLowerCase();
      if (role === 'banner' || role === 'navigation') return true;
      const marker = normalized(
        element.getAttribute('id') ||
          element.getAttribute('data-testid') ||
          element.getAttribute('aria-label'),
      ).toLowerCase();
      return /sidebar|side-bar|navigation/.test(marker);
    };
    const hasBlockedAncestor = (element) => {
      let current = element;
      for (let depth = 0; current && depth < 10; depth += 1) {
        if (blockedBoundary(current)) return true;
        current = current.parentElement;
      }
      return false;
    };
    const composerRootOf = (input) => {
      if (!(input instanceof HTMLElement) || !input.isConnected || hasBlockedAncestor(input)) {
        return null;
      }
      const form = input.closest('form');
      if (form && !hasBlockedAncestor(form)) return form;
      let current = input.parentElement;
      for (let depth = 0; current && depth < 6; depth += 1) {
        const marker = normalized(
          current.getAttribute('data-testid') || current.getAttribute('aria-label'),
        );
        if (
          [
            'composer',
            'composer-container',
            'chat-input',
            'prompt-textarea',
            'Message composer',
            'Chat input',
            '메시지 입력',
            '채팅 입력',
          ].includes(marker) &&
          !hasBlockedAncestor(current)
        ) {
          return current;
        }
        current = current.parentElement;
      }
      return null;
    };
    const findComposerInput = () => {
      const knownInput = document.querySelector('#prompt-textarea');
      if (visible(knownInput) && composerRootOf(knownInput)) return knownInput;
      return Array.from(
        document.querySelectorAll('[contenteditable="true"][role="textbox"]'),
      ).find((element) => visible(element) && composerRootOf(element));
    };
    // Keep only interaction flags in this document, never a draft or message text.
    // Polls must not reattach between submission and the owner's next input.
    const activityKey = Symbol.for('chatsplice.local-mcp-composer-activity.v1');
    let activity = window[activityKey];
    if (!activity) {
      activity = { revision: 0, awaitingInput: false, composing: false, lastInputAt: 0 };
      window[activityKey] = activity;
      const targetsInput = (event) => {
        const input = findComposerInput();
        return input && event.target instanceof HTMLElement && input.contains(event.target);
      };
      const interaction = () => {
        activity.revision += 1;
        activity.lastInputAt = Date.now();
      };
      const submitted = () => {
        interaction();
        activity.awaitingInput = true;
      };
      document.addEventListener('beforeinput', (event) => {
        if (event.isTrusted && targetsInput(event)) interaction();
      }, true);
      document.addEventListener('input', (event) => {
        if (!event.isTrusted || !targetsInput(event)) return;
        interaction();
        activity.awaitingInput = false;
        activity.composing = event.isComposing === true;
      }, true);
      document.addEventListener('compositionstart', (event) => {
        if (!event.isTrusted || !targetsInput(event)) return;
        interaction();
        activity.composing = true;
      }, true);
      document.addEventListener('compositionend', (event) => {
        if (!event.isTrusted || !targetsInput(event)) return;
        interaction();
        activity.composing = false;
      }, true);
      document.addEventListener('keydown', (event) => {
        if (!event.isTrusted || !targetsInput(event)) return;
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !activity.composing) {
          submitted();
        }
      }, true);
      document.addEventListener('click', (event) => {
        if (!event.isTrusted) return;
        const input = findComposerInput();
        const root = input && composerRootOf(input);
        if (!root || !(event.target instanceof Element)) return;
        const button = event.target.closest('button') || event.target.closest('[role="button"]');
        if (!button || !root.contains(button)) return;
        if (button.getAttribute('data-testid') === 'send-button' ||
            ['Send prompt', 'Send message', '메시지 보내기', '프롬프트 보내기'].includes(exactAttributeLabel(button))) {
          submitted();
        }
      }, true);
      document.addEventListener('submit', (event) => {
        // A host-dispatched form submission also marks the draft as submitted.
        const input = findComposerInput();
        if (input && event.target === composerRootOf(input)) submitted();
      }, true);
    }
    const responseIsActive = (context) => {
      const blocked = context.root.getAttribute('aria-busy') === 'true' ||
        context.input.getAttribute('aria-busy') === 'true' ||
        context.input.getAttribute('disabled') !== null ||
        context.input.getAttribute('readonly') !== null ||
        context.input.getAttribute('contenteditable') === 'false';
      const stopping = Array.from(context.root.querySelectorAll('button, [role="button"]')).some(
        (element) => visible(element) &&
          (element.getAttribute('data-testid') === 'stop-button' ||
            ['Stop generating', 'Stop response', '생성 중지', '응답 중지'].includes(exactAttributeLabel(element))),
      );
      if (blocked || stopping) activity.awaitingInput = true;
      return blocked || stopping;
    };
    const inputIsActive = () => activity.composing || Date.now() - activity.lastInputAt < 750;
    const visibleOverlay = (element) => {
      if (!(element instanceof HTMLElement) || !visible(element)) return false;
      const tag = String(element.tagName || '').toLowerCase();
      const role = normalized(element.getAttribute('role')).toLowerCase();
      return tag === 'dialog' || ['menu', 'listbox', 'dialog'].includes(role);
    };
    const visibleOverlays = () =>
      Array.from(
        document.querySelectorAll(
          '[role="menu"], [role="listbox"], [role="dialog"], dialog',
        ),
      ).filter((element) => visibleOverlay(element));
    const contextOf = () => {
      if (document.visibilityState !== 'visible') return null;
      const input = findComposerInput();
      const root = input && composerRootOf(input);
      if (!input || !root || !visible(input) || !visible(root)) return null;
      return {
        input,
        root,
        href: location.href,
        initialOverlays: new Set(visibleOverlays()),
        menuOpened: false,
        inputRevision: activity.revision,
      };
    };
    const contextIsCurrent = (context) => {
      if (
        !context ||
        document.visibilityState !== 'visible' ||
        location.href !== context.href ||
        !context.input.isConnected ||
        !context.root.isConnected ||
        hasBlockedAncestor(context.input) ||
        hasBlockedAncestor(context.root) ||
        composerRootOf(context.input) !== context.root ||
        !visible(context.input) ||
        !visible(context.root)
      ) {
        return false;
      }
      if (responseIsActive(context) || activity.awaitingInput || inputIsActive() ||
          context.inputRevision !== activity.revision) return false;
      const overlays = visibleOverlays();
      if (overlays.some((element) => normalized(element.getAttribute('role')).toLowerCase() === 'dialog' || String(element.tagName || '').toLowerCase() === 'dialog')) {
        return false;
      }
      if (!context.menuOpened && overlays.length > 0) return false;
      return true;
    };
    const waitFor = async (find, context) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (!contextIsCurrent(context)) return null;
        const value = find();
        if (value) return value;
        await new Promise((resolve) => window.setTimeout(resolve, 100));
      }
      if (!contextIsCurrent(context)) return null;
      return find();
    };
    const click = (element, context, opensMenu = false) => {
      if (
        !contextIsCurrent(context) ||
        !(element instanceof HTMLElement) ||
        !visible(element) ||
        hasBlockedAncestor(element)
      ) {
        return false;
      }
      element.click();
      if (opensMenu) context.menuOpened = true;
      return contextIsCurrent(context);
    };
    const findComposerOpener = (context) =>
      Array.from(
        context.root.querySelectorAll('button, [role="button"], [aria-haspopup="menu"]'),
      ).find(
        (element) =>
          visible(element) &&
          !hasBlockedAncestor(element) &&
          openerLabels.includes(scopedTextLabel(element)),
      );
    const isLocalMcpChip = (element) => {
      if (
        !(element instanceof HTMLElement) ||
        String(element.tagName || '').toLowerCase() !== 'a' ||
        !visible(element) ||
        hasBlockedAncestor(element) ||
        !localMcpLabels.includes(normalized(element.textContent))
      ) {
        return false;
      }
      const href = normalized(element.getAttribute('href'));
      if (!href) return false;
      let parsed;
      try {
        parsed = new URL(href, location.origin);
      } catch {
        return false;
      }
      return (
        parsed.origin === location.origin &&
        /^\\/plugins\\/plugin_[^/?#]+$/.test(parsed.pathname) &&
        parsed.searchParams.get('plugin_detail_origin') === 'inline_selection_pill'
      );
    };
    const isAlreadyAttached = (context) =>
      Array.from(context.root.querySelectorAll('a[href]')).some((element) =>
        isLocalMcpChip(element),
      );
    const findLocalMcpItem = (menu) =>
      Array.from(
        menu.querySelectorAll(
          '[role="menuitem"], [role="menuitemcheckbox"], [role="option"], button, a',
        ),
      ).filter(
        (element) =>
          visible(element) &&
          !hasBlockedAncestor(element) &&
          localMcpLabels.includes(scopedTextLabel(element)),
      );
    const isMenu = (element) =>
      visible(element) &&
      !hasBlockedAncestor(element) &&
      ['menu', 'listbox'].includes(normalized(element.getAttribute('role')).toLowerCase());
    const isOwnedMenu = (menu, opener, context) => {
      if (context.root.contains(menu)) return true;
      const controlledId = normalized(opener.getAttribute('aria-controls'));
      if (controlledId && normalized(menu.getAttribute('id')) === controlledId) return true;
      const openerId = normalized(opener.getAttribute('id'));
      if (!openerId) return false;
      return normalized(menu.getAttribute('aria-labelledby'))
        .split(/\\s+/)
        .includes(openerId);
    };
    const visibleOwnedMenus = (opener, context) => {
      const controlledId = normalized(opener.getAttribute('aria-controls'));
      if (controlledId) {
        const controlled = document.getElementById(controlledId);
        if (controlled && isMenu(controlled) && !context.initialOverlays.has(controlled)) {
          return [controlled];
        }
      }
      return Array.from(
        document.querySelectorAll('[role="menu"], [role="listbox"]'),
      ).filter(
        (menu) =>
          isMenu(menu) &&
          !context.initialOverlays.has(menu) &&
          isOwnedMenu(menu, opener, context),
      );
    };
    const findOwnedMenu = (opener, context) => {
      const candidates = visibleOwnedMenus(opener, context);
      if (candidates.length === 1) return candidates[0];
      const direct = candidates.filter((menu) => findLocalMcpItem(menu).length === 1);
      return direct.length === 1 ? direct[0] : null;
    };

    return (async () => {
      const context = contextOf();
      if (!context) return 'composer_not_found';
      if (responseIsActive(context)) return 'busy';
      if (activity.awaitingInput) return 'awaiting_input';
      if (inputIsActive()) return 'user_input_active';
      if (context.initialOverlays.size > 0) return 'user_menu_open';
      if (isAlreadyAttached(context)) return 'already_attached';

      const opener = await waitFor(() => findComposerOpener(context), context);
      if (!opener) return contextIsCurrent(context) ? 'opener_not_found' : 'context_changed';
      if (!click(opener, context, true)) return 'context_changed';

      const menu = await waitFor(() => findOwnedMenu(opener, context), context);
      if (!menu) return contextIsCurrent(context) ? 'menu_not_found' : 'context_changed';

      const appItem = await waitFor(
        () => (findLocalMcpItem(menu).length === 1 ? findLocalMcpItem(menu)[0] : null),
        context,
      );
      if (!appItem) return contextIsCurrent(context) ? 'app_not_found' : 'context_changed';
      if (!click(appItem, context)) return 'context_changed';

      const attached = await waitFor(
        () => (isAlreadyAttached(context) ? context.root : null),
        context,
      );
      if (attached) return 'attached';
      return contextIsCurrent(context) ? 'attach_not_confirmed' : 'context_changed';
    })();
  })()`;
}

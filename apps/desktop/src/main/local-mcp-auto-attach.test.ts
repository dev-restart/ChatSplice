import { createContext, runInContext, type Context } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { buildLocalMcpAutoAttachScript, localMcpAppLabels } from './local-mcp-auto-attach.js';

type Attributes = Record<string, string>;

interface FixtureEvent {
  readonly target: FakeElement;
  readonly isTrusted: boolean;
  readonly key?: string;
  readonly shiftKey?: boolean;
  readonly isComposing?: boolean;
}

interface FixtureOptions {
  readonly attachOnAppClick?: boolean;
  readonly contentEditable?: boolean;
  readonly hidden?: boolean;
  readonly navigateOnOpen?: boolean;
  readonly replaceOnOpen?: boolean;
  readonly selected?: boolean;
  readonly unrelatedMenuOnOpen?: boolean;
  readonly userDialog?: boolean;
  readonly userMenu?: boolean;
}

class FakeElement {
  public readonly tagName: string;
  public parentElement: FakeElement | null = null;
  public readonly children: FakeElement[] = [];
  public isConnected = false;
  public textContent: string;
  public clickCount = 0;
  public display = 'block';
  public visibility = 'visible';
  public onClick: (() => void) | undefined;

  readonly #attributes = new Map<string, string>();

  public constructor(tagName: string, attributes: Attributes = {}, textContent = '') {
    this.tagName = tagName.toUpperCase();
    this.textContent = textContent;
    for (const [name, value] of Object.entries(attributes)) {
      this.setAttribute(name, value);
    }
  }

  public getAttribute(name: string): string | null {
    return this.#attributes.get(name) ?? null;
  }

  public setAttribute(name: string, value: string): void {
    this.#attributes.set(name, value);
  }

  public appendChild(child: FakeElement): FakeElement {
    child.parentElement = this;
    this.children.push(child);
    child.setConnected(this.isConnected);
    return child;
  }

  public removeChild(child: FakeElement): void {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
      child.parentElement = null;
      child.setConnected(false);
    }
  }

  public closest(selector: string): FakeElement | null {
    if (this.matchesSelector(selector)) return this;
    let parent = this.parentElement;
    while (parent) {
      if (parent.matchesSelector(selector)) return parent;
      parent = parent.parentElement;
    }
    return null;
  }

  public contains(element: FakeElement): boolean {
    if (this === element) return true;
    return this.children.some((child) => child.contains(element));
  }

  public querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  public querySelectorAll(selector: string): FakeElement[] {
    const selectors = selector
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    const result: FakeElement[] = [];
    const visit = (parent: FakeElement): void => {
      for (const child of parent.children) {
        if (!child.isConnected) continue;
        if (selectors.some((part) => child.matchesSelector(part))) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }

  public getClientRects(): Array<Record<string, never>> {
    if (!this.isConnected || this.display === 'none' || this.visibility === 'hidden') {
      return [];
    }
    return [{}];
  }

  public click(): void {
    this.clickCount += 1;
    this.onClick?.();
  }

  private setConnected(connected: boolean): void {
    this.isConnected = connected;
    for (const child of this.children) child.setConnected(connected);
  }

  private matchesSelector(selector: string): boolean {
    let remaining = selector.trim();
    const tagMatch = remaining.match(/^[a-z][a-z0-9-]*/i);
    if (tagMatch) {
      if (this.tagName.toLowerCase() !== tagMatch[0].toLowerCase()) return false;
      remaining = remaining.slice(tagMatch[0].length);
    }

    if (remaining.startsWith('#')) {
      const idMatch = remaining.match(/^#([a-z0-9_-]+)/i);
      if (!idMatch || this.getAttribute('id') !== idMatch[1]) return false;
      remaining = remaining.slice(idMatch[0].length);
    }

    const attributes = [...remaining.matchAll(/\[([a-z_:][-a-z0-9_:]*)(?:="([^"]*)")?\]/gi)];
    if (attributes.length === 0 && remaining.length > 0) return false;
    return attributes.every((match) => {
      const value = this.getAttribute(match[1] ?? '');
      return value !== null && (match[2] === undefined || value === match[2]);
    });
  }
}

class FakeDocument {
  public readonly body = new FakeElement('body');
  public visibilityState: 'hidden' | 'visible' = 'visible';
  public readonly listeners = new Map<string, Array<(event: FixtureEvent) => void>>();

  public constructor() {
    this.body.isConnected = true;
  }

  public getElementById(id: string): FakeElement | null {
    return this.querySelectorAll('[id="' + id + '"]')[0] ?? null;
  }

  public querySelector(selector: string): FakeElement | null {
    return this.body.querySelector(selector);
  }

  public querySelectorAll(selector: string): FakeElement[] {
    return this.body.querySelectorAll(selector);
  }

  public addEventListener(type: string, listener: (event: FixtureEvent) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  public signal(type: string, target: FakeElement, options: Partial<FixtureEvent> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ target, isTrusted: true, ...options });
    }
  }
}

interface Fixture {
  readonly appItem: FakeElement | null;
  readonly document: FakeDocument;
  readonly form: FakeElement;
  readonly headerMore: FakeElement;
  readonly input: FakeElement;
  readonly location: { origin: string; href: string };
  readonly opener: FakeElement;
  readonly unrelatedAppItem: FakeElement | null;
  readonly clock: { now: number };
}

function localMcpHref(): string {
  return '/plugins/plugin_fixture?plugin_detail_origin=inline_selection_pill';
}

function createFixture(options: FixtureOptions = {}): Fixture {
  const document = new FakeDocument();
  const location = {
    origin: 'https://chatgpt.com',
    href: 'https://chatgpt.com/c/fixture',
  };
  const form = new FakeElement('form');
  const input = options.contentEditable
    ? new FakeElement('div', {
        contenteditable: 'true',
        id: 'prompt-textarea',
        role: 'textbox',
      })
    : new FakeElement('textarea', { id: 'prompt-textarea' });
  const opener = new FakeElement('button', {
    'aria-haspopup': 'menu',
    'aria-label': '파일 등 추가',
  });
  form.appendChild(input);
  form.appendChild(opener);
  document.body.appendChild(form);

  const header = new FakeElement('header');
  const headerMore = new FakeElement('button', { 'aria-label': '더 보기' });
  headerMore.onClick = () => undefined;
  header.appendChild(headerMore);
  document.body.appendChild(header);

  if (options.selected) {
    (options.contentEditable ? input : form).appendChild(
      new FakeElement('a', { href: localMcpHref() }, '로컬 MCP'),
    );
  }

  let appItem: FakeElement | null = null;
  let unrelatedAppItem: FakeElement | null = null;
  opener.onClick = () => {
    if (options.navigateOnOpen) {
      location.href = 'https://chatgpt.com/c/next';
      return;
    }
    if (options.replaceOnOpen) {
      form.isConnected = false;
      input.isConnected = false;
      return;
    }
    if (options.unrelatedMenuOnOpen) {
      const unrelatedMenu = new FakeElement('div', { role: 'menu' });
      unrelatedAppItem = new FakeElement('button', { role: 'menuitem' }, '로컬 MCP');
      unrelatedMenu.appendChild(unrelatedAppItem);
      document.body.appendChild(unrelatedMenu);
      return;
    }

    const menu = new FakeElement('div', {
      id: 'composer-menu',
      role: 'menu',
    });
    opener.setAttribute('aria-controls', 'composer-menu');
    document.body.appendChild(menu);

    const addChip = (): void => {
      if (options.attachOnAppClick === false) return;
      form.appendChild(new FakeElement('a', { href: localMcpHref() }, '로컬 MCP'));
    };

    appItem = new FakeElement('button', { role: 'menuitem' }, '로컬 MCP');
    appItem.onClick = addChip;
    menu.appendChild(appItem);
  };

  if (options.userMenu) {
    document.body.appendChild(new FakeElement('div', { role: 'menu' }));
  }
  if (options.userDialog) {
    document.body.appendChild(new FakeElement('div', { role: 'dialog' }));
  }
  if (options.hidden) document.visibilityState = 'hidden';

  return {
    get appItem() {
      return appItem;
    },
    document,
    form,
    headerMore,
    input,
    location,
    opener,
    get unrelatedAppItem() {
      return unrelatedAppItem;
    },
    clock: { now: 10_000 },
  };
}

const scriptContexts = new WeakMap<Fixture, Context>();

async function runAutomation(fixture: Fixture, appName = 'Local MCP'): Promise<string> {
  const source = buildLocalMcpAutoAttachScript(appName).replace(
    'const timeoutMs = 3000;',
    'const timeoutMs = 40;',
  );
  let context = scriptContexts.get(fixture);
  if (!context) {
    context = createContext({
      Element: FakeElement,
      HTMLElement: {
        [Symbol.hasInstance]: (value: unknown) =>
          value instanceof FakeElement && !['SVG', 'PATH'].includes(value.tagName),
      },
      URL,
      Date: class extends Date {
        static override now(): number {
          // Also let bounded waits expire without requiring real-time sleeps.
          return fixture.clock.now++;
        }
      },
      document: fixture.document,
      location: fixture.location,
      window: {
        getComputedStyle: (element: FakeElement) => ({
          display: element.display,
          visibility: element.visibility,
        }),
        setTimeout: (callback: () => void) => {
          fixture.clock.now += 100;
          return setTimeout(callback, 0);
        },
      },
    });
    scriptContexts.set(fixture, context);
  }
  const result = await runInContext(source, context);
  return String(result);
}

describe('Local MCP auto-attach automation', () => {
  it('keeps the remote script scoped to explicit composer labels and plugin chips', () => {
    const source = buildLocalMcpAutoAttachScript();

    expect(source).toContain("'파일 등 추가'");
    expect(source).toContain("'Add photos and files'");
    expect(source).toContain('plugin_detail_origin');
    expect(source).toContain('contextIsCurrent');
    expect(source).toContain('user_menu_open');
    expect(source).toContain('attach_not_confirmed');
    expect(source).not.toContain("'More'");
    expect(source).not.toContain('fetch(');
    expect(source).not.toContain('document.cookie');
    expect(source).not.toContain('localStorage');
    expect(source).not.toContain('sessionStorage');
    expect(source).not.toContain('conversation');
    expect(source).not.toContain('textContent =');
    expect(source).not.toContain('innerText');
    expect(source).not.toContain('.value =');
  });

  it('matches only the configured app name, adding the localized alias for the legacy name', () => {
    expect(localMcpAppLabels('Local MCP')).toEqual(['Local MCP', '로컬 MCP']);
    expect(localMcpAppLabels('ChatSplice MCP')).toEqual(['ChatSplice MCP']);
    expect(buildLocalMcpAutoAttachScript('ChatSplice MCP')).not.toContain('로컬 MCP');
  });

  it('does not attach a legacy-named app when a different name is configured', async () => {
    const fixture = createFixture();

    await expect(runAutomation(fixture, 'ChatSplice MCP')).resolves.not.toBe('attached');
  });

  it('attaches through the Korean composer opener and confirms the Korean plugin anchor chip', async () => {
    const fixture = createFixture();

    await expect(runAutomation(fixture)).resolves.toBe('attached');
    expect(fixture.opener.clickCount).toBe(1);
    expect(fixture.headerMore.clickCount).toBe(0);
    expect(fixture.form.querySelectorAll('a[href]')).toHaveLength(1);
  });

  it('does not click the global header control when the composer has no recognized opener', async () => {
    const fixture = createFixture();
    fixture.opener.setAttribute('aria-label', '더 보기');

    await expect(runAutomation(fixture)).resolves.toBe('opener_not_found');
    expect(fixture.opener.clickCount).toBe(0);
    expect(fixture.headerMore.clickCount).toBe(0);
  });

  it('does not select an unrelated menu that appears after the composer opener', async () => {
    const fixture = createFixture({ unrelatedMenuOnOpen: true });

    await expect(runAutomation(fixture)).resolves.toBe('menu_not_found');
    expect(fixture.opener.clickCount).toBe(1);
    expect(fixture.headerMore.clickCount).toBe(0);
    expect(fixture.unrelatedAppItem?.clickCount ?? 0).toBe(0);
    expect(fixture.form.querySelectorAll('a[href]')).toHaveLength(0);
  });

  it('does nothing when the Korean plugin chip is already selected', async () => {
    const fixture = createFixture({ contentEditable: true, selected: true });

    await expect(runAutomation(fixture)).resolves.toBe('already_attached');
    expect(fixture.opener.clickCount).toBe(0);
    expect(fixture.headerMore.clickCount).toBe(0);
  });

  it('does not reopen the picker while a response is generating', async () => {
    const fixture = createFixture();
    fixture.form.appendChild(new FakeElement('button', { 'data-testid': 'stop-button' }));

    await expect(runAutomation(fixture)).resolves.toBe('busy');
    expect(fixture.opener.clickCount).toBe(0);
    expect(fixture.appItem?.clickCount ?? 0).toBe(0);
  });

  it('aborts app selection if generation starts after the picker opens', async () => {
    const fixture = createFixture();
    const open = fixture.opener.onClick;
    fixture.opener.onClick = () => {
      open?.();
      fixture.form.appendChild(new FakeElement('button', { 'data-testid': 'stop-button' }));
    };

    await expect(runAutomation(fixture)).resolves.toBe('context_changed');
    expect(fixture.opener.clickCount).toBe(1);
    expect(fixture.appItem?.clickCount).toBe(0);
  });

  it('stays idle after generation ends until new trusted input, without restoring text', async () => {
    const fixture = createFixture({ contentEditable: true });
    const stop = fixture.form.appendChild(
      new FakeElement('button', { 'data-testid': 'stop-button' }),
    );
    fixture.input.textContent = '';

    await expect(runAutomation(fixture)).resolves.toBe('busy');
    fixture.form.removeChild(stop);
    await expect(runAutomation(fixture)).resolves.toBe('awaiting_input');
    fixture.document.signal('input', fixture.input, { isTrusted: false });
    await expect(runAutomation(fixture)).resolves.toBe('awaiting_input');
    expect(fixture.input.textContent).toBe('');
    expect(fixture.opener.clickCount).toBe(0);

    fixture.input.textContent = '새로 작성한 요청';
    fixture.document.signal('input', fixture.input);
    await expect(runAutomation(fixture)).resolves.toBe('user_input_active');
    fixture.clock.now += 1_000;
    await expect(runAutomation(fixture)).resolves.toBe('attached');
    expect(fixture.input.textContent).toBe('새로 작성한 요청');
    expect(fixture.opener.clickCount).toBe(1);
    for (const listeners of fixture.document.listeners.values()) expect(listeners).toHaveLength(1);
  });

  it.each(['enter', 'send', 'svg-send', 'submit'])(
    'pauses on %s submission before a stop button has appeared, including URL changes',
    async (method) => {
      const fixture = createFixture({ selected: true });
      await expect(runAutomation(fixture)).resolves.toBe('already_attached');
      if (method === 'enter') {
        fixture.document.signal('keydown', fixture.input, { key: 'Enter' });
      } else if (method === 'send' || method === 'svg-send') {
        const send = fixture.form.appendChild(
          new FakeElement('button', { 'data-testid': 'send-button' }),
        );
        const target = method === 'svg-send' ? send.appendChild(new FakeElement('svg')) : send;
        fixture.document.signal('click', target);
      } else {
        fixture.document.signal('submit', fixture.form);
      }
      const chip = fixture.form.querySelector('a[href]');
      if (chip) fixture.form.removeChild(chip);
      fixture.location.href = 'https://chatgpt.com/c/new-chat-after-submit';
      fixture.clock.now += 1_000;

      await expect(runAutomation(fixture)).resolves.toBe('awaiting_input');
      expect(fixture.opener.clickCount).toBe(0);
    },
  );

  it.each(['beforeinput', 'compositionstart', 'submit'])(
    'aborts an open picker when %s occurs instead of applying stale attachment state',
    async (type) => {
      const fixture = createFixture({ contentEditable: true });
      const open = fixture.opener.onClick;
      fixture.opener.onClick = () => {
        open?.();
        fixture.document.signal(type, type === 'submit' ? fixture.form : fixture.input);
      };

      await expect(runAutomation(fixture)).resolves.toBe('context_changed');
      expect(fixture.appItem?.clickCount).toBe(0);
    },
  );

  it('does not treat IME confirmation or Shift+Enter as a submitted prompt', async () => {
    const fixture = createFixture({ selected: true, contentEditable: true });
    await expect(runAutomation(fixture)).resolves.toBe('already_attached');
    fixture.document.signal('compositionstart', fixture.input);
    fixture.document.signal('keydown', fixture.input, { key: 'Enter', isComposing: true });
    await expect(runAutomation(fixture)).resolves.toBe('user_input_active');
    fixture.document.signal('compositionend', fixture.input);
    fixture.document.signal('keydown', fixture.input, { key: 'Enter', shiftKey: true });
    fixture.clock.now += 1_000;

    await expect(runAutomation(fixture)).resolves.toBe('already_attached');
    expect(fixture.opener.clickCount).toBe(0);
  });

  it('resumes on new input after the host replaces a composer during IME composition', async () => {
    const fixture = createFixture({ selected: true, contentEditable: true });
    await expect(runAutomation(fixture)).resolves.toBe('already_attached');
    fixture.document.signal('compositionstart', fixture.input);
    fixture.form.removeChild(fixture.input);
    const replacement = fixture.form.appendChild(
      new FakeElement('div', { id: 'prompt-textarea', contenteditable: 'true', role: 'textbox' }),
    );
    fixture.document.signal('compositionend', fixture.input);
    fixture.clock.now += 1_000;
    await expect(runAutomation(fixture)).resolves.toBe('user_input_active');
    fixture.document.signal('input', replacement, { isComposing: false });
    fixture.clock.now += 1_000;

    await expect(runAutomation(fixture)).resolves.toBe('attached');
    expect(fixture.opener.clickCount).toBe(1);
  });

  it('never reads or writes the composer text while checking or attaching', async () => {
    const fixture = createFixture({ contentEditable: true });
    for (const property of ['value', 'textContent', 'innerHTML', 'innerText']) {
      Object.defineProperty(fixture.input, property, {
        get: () => {
          throw new Error('Composer text must not be read');
        },
        set: () => {
          throw new Error('Composer text must not be written');
        },
      });
    }

    await expect(runAutomation(fixture)).resolves.toBe('attached');
    expect(fixture.opener.clickCount).toBe(1);
  });

  it('fails closed without clicking when a user menu is already open', async () => {
    const fixture = createFixture({ userMenu: true });

    await expect(runAutomation(fixture)).resolves.toBe('user_menu_open');
    expect(fixture.opener.clickCount).toBe(0);
    expect(fixture.headerMore.clickCount).toBe(0);
  });

  it('fails closed without clicking when a user dialog is already open', async () => {
    const fixture = createFixture({ userDialog: true });

    await expect(runAutomation(fixture)).resolves.toBe('user_menu_open');
    expect(fixture.opener.clickCount).toBe(0);
    expect(fixture.headerMore.clickCount).toBe(0);
  });

  it('aborts when the page becomes hidden before automation starts', async () => {
    const fixture = createFixture({ hidden: true });

    await expect(runAutomation(fixture)).resolves.toBe('not_visible');
    expect(fixture.opener.clickCount).toBe(0);
    expect(fixture.headerMore.clickCount).toBe(0);
    expect(fixture.document.listeners.size).toBe(0);
  });

  it('does not install activity listeners on login or other origins', async () => {
    const fixture = createFixture();
    fixture.location.origin = 'https://accounts.google.com';
    fixture.location.href = 'https://accounts.google.com/login';

    await expect(runAutomation(fixture)).resolves.toBe('not_chatgpt');
    expect(fixture.document.listeners.size).toBe(0);
    expect(fixture.opener.clickCount).toBe(0);
  });

  it('aborts before app selection when navigation changes after opener click', async () => {
    const fixture = createFixture({ navigateOnOpen: true });

    await expect(runAutomation(fixture)).resolves.toBe('context_changed');
    expect(fixture.opener.clickCount).toBe(1);
    expect(fixture.appItem?.clickCount ?? 0).toBe(0);
  });

  it('aborts when the original composer is replaced after opener click', async () => {
    const fixture = createFixture({ replaceOnOpen: true });

    await expect(runAutomation(fixture)).resolves.toBe('context_changed');
    expect(fixture.opener.clickCount).toBe(1);
    expect(fixture.appItem?.clickCount ?? 0).toBe(0);
  });

  it('does not report attached when the UI never renders the plugin chip', async () => {
    const fixture = createFixture({ attachOnAppClick: false });

    await expect(runAutomation(fixture)).resolves.toBe('attach_not_confirmed');
    expect(fixture.opener.clickCount).toBe(1);
    expect(fixture.form.querySelectorAll('a[href]')).toHaveLength(0);
  });
});

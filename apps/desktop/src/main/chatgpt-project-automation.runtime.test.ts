import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

import {
  buildChatGptProjectAutomationScript,
  buildChatGptProjectCreateClickScript,
  buildChatGptProjectCreateModalProbeScript,
  buildChatGptProjectInstructionsUpdateScript,
} from './chatgpt-project-automation.js';

const workspaceId = `ws_${'a'.repeat(24)}`;
const binding = `wb_${'0'.repeat(64)}`;
const block = (id = workspaceId, key = binding, body = 'new rules') =>
  `--- BEGIN CHATSPLICE PROJECT INSTRUCTIONS v1 ---\n- workspace_id: ${id}\n- workspace_binding: ${key}\n${body}\n--- END CHATSPLICE PROJECT INSTRUCTIONS v1 ---`;
const input = { workspaceId, workspaceName: 'Fixture', bindingText: block() };

function fixture(
  options: {
    current?: string;
    save?: 'enabled' | 'disabled' | 'missing' | 'unpersisted' | 'pending';
    create?: boolean;
    busy?: boolean;
    busyDialog?: boolean;
    navigateOnSave?: boolean;
    currentUi?: boolean;
    pointerMenu?: boolean;
    interactOnCreate?: boolean;
    openerOnly?: boolean;
    nameAfterWait?: boolean;
    currentCreateUi?: boolean;
    interruptOnControlWait?: boolean;
    projectListOpener?: 'ko' | 'en' | 'ambiguous' | 'outside-main' | 'dialog' | 'disabled';
  } = {},
) {
  let persisted = options.current ?? block(workspaceId, binding, 'old rules');
  let open = options.busyDialog === true;
  let writes = 0;
  let clicks = 0;
  let now = 0;
  let openerClicks = 0;
  let menuOpen = false;
  let pointerOpens = 0;
  const interactionListeners = new Map<string, Set<(event: { isTrusted: boolean }) => void>>();
  class Element {
    textContent: string;
    labels: Element[] = [];
    constructor(readonly label = '') {
      this.textContent = label;
    }
    get isConnected() {
      return open;
    }
    getAttribute(name: string) {
      return name === 'aria-label' && !(options.currentUi && this.label === 'Project instructions')
        ? this.label
        : name === 'placeholder' && this.label === 'Project instructions'
          ? 'Example project guidance'
          : null;
    }
    getClientRects() {
      return [{}];
    }
    click() {}
    focus() {}
    blur() {}
    dispatchEvent() {
      return true;
    }
    closest() {
      return dialog;
    }
    querySelectorAll() {
      return [save, close];
    }
  }
  class Button extends Element {
    disabled = false;
  }
  class TextArea extends Element {
    draft = persisted;
    get value() {
      return this.draft;
    }
    set value(value: string) {
      this.draft = value;
      writes += 1;
    }
  }
  class Input extends TextArea {
    type = 'text';
  }
  const field = new TextArea('Project instructions');
  if (options.currentUi) field.labels = [new Element('지침')];
  const name = new Input('Project name');
  const dialog = new Element();
  const details = new Button(options.currentUi ? '프로젝트 액션' : 'Show project details');
  if (options.pointerMenu) {
    const getAttribute = details.getAttribute.bind(details);
    details.getAttribute = (name: string) =>
      name === 'aria-haspopup'
        ? 'menu'
        : name === 'aria-expanded'
          ? String(menuOpen)
          : getAttribute(name);
    details.dispatchEvent = (...args: unknown[]) => {
      if ((args[0] as { type: string })?.type === 'pointerdown') {
        menuOpen = true;
        pointerOpens += 1;
      }
      return true;
    };
  }
  const main = new Element();
  main.querySelectorAll = () => [details];
  const settings = new Button('Project settings');
  settings.click = () => {
    menuOpen = false;
    open = true;
    field.draft = persisted;
  };
  const create = new Button('Create');
  const opener = new Button(
    options.projectListOpener === 'en'
      ? 'Create'
      : options.projectListOpener || options.currentCreateUi
        ? '만들기'
        : 'New project',
  );
  if (options.projectListOpener === 'disabled') opener.disabled = true;
  opener.click = () => {
    openerClicks += 1;
  };
  if (options.projectListOpener) {
    main.querySelectorAll = () =>
      options.projectListOpener === 'outside-main'
        ? []
        : options.projectListOpener === 'ambiguous'
          ? [opener, new Button('만들기')]
          : [opener];
  }
  create.click = () => {
    if (options.interactOnCreate)
      for (const listener of interactionListeners.get('keydown') ?? [])
        listener({ isTrusted: true });
    location.pathname = '/g/project-fixture/project';
  };
  const close = new Button(options.currentUi ? '대화 상자 닫기' : 'Close project settings');
  close.click = () => {
    open = false;
  };
  const save = new Button('Save');
  save.disabled = options.save === 'disabled';
  save.click = () => {
    clicks += 1;
    if (options.save === 'pending') {
      save.disabled = true;
      return;
    }
    if (options.save !== 'unpersisted') persisted = field.draft;
    open = false;
    if (options.navigateOnSave) location.pathname = '/other-project';
  };
  dialog.querySelectorAll = () =>
    options.create && location.pathname === '/projects'
      ? [create]
      : options.save === 'missing'
        ? [close]
        : [save, close];
  const location = {
    origin: 'https://chatgpt.com',
    pathname: options.create ? '/projects' : '/g/project-fixture/project',
    get href() {
      return this.origin + this.pathname;
    },
  };
  const document = {
    activeElement: options.busy ? new TextArea('Message') : options.create ? name : null,
    visibilityState: 'visible',
    querySelector: (selector: string) =>
      selector.includes('project-name')
        ? options.currentCreateUi && !selector.includes('chatgpt-project-name')
          ? null
          : options.nameAfterWait && now === 0
            ? null
            : name
        : selector === 'main'
          ? main
          : null,
    querySelectorAll: (selector: string) =>
      options.projectListOpener
        ? selector.includes('[role="dialog"]')
          ? options.projectListOpener === 'dialog'
            ? [dialog]
            : []
          : [opener]
        : options.openerOnly
          ? now === 0
            ? []
            : [opener]
          : selector === '[role="dialog"], [role="menu"]'
            ? open
              ? [dialog]
              : []
            : selector.startsWith('textarea')
              ? open
                ? [field]
                : []
              : selector.includes('input')
                ? [name]
                : [
                    ...(options.currentCreateUi ? [opener] : []),
                    details,
                    ...(!options.pointerMenu || menuOpen ? [settings] : []),
                    create,
                    ...(open ? dialog.querySelectorAll() : []),
                  ],
    getElementById: () => null,
    addEventListener: (name: string, listener: (event: { isTrusted: boolean }) => void) => {
      const listeners = interactionListeners.get(name) ?? new Set();
      listeners.add(listener);
      interactionListeners.set(name, listeners);
    },
    removeEventListener: (name: string, listener: (event: { isTrusted: boolean }) => void) => {
      interactionListeners.get(name)?.delete(listener);
    },
  };
  const context = vm.createContext({
    document,
    location,
    HTMLElement: Element,
    HTMLTextAreaElement: TextArea,
    HTMLInputElement: Input,
    HTMLButtonElement: Button,
    window: {
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
      setTimeout: (callback: () => void, ms: number) => {
        now += ms;
        if (options.interruptOnControlWait)
          for (const listener of interactionListeners.get('keydown') ?? [])
            listener({ isTrusted: true });
        callback();
      },
    },
    InputEvent: class {},
    Event: class {},
    MouseEvent: class {},
    PointerEvent: class {
      constructor(readonly type: string) {}
    },
    Date: class extends Date {
      static override now() {
        return now;
      }
    },
    Promise,
  });
  return {
    context,
    details,
    field,
    persisted: () => persisted,
    writes: () => writes,
    clicks: () => clicks,
    openerClicks: () => openerClicks,
    pointerOpens: () => pointerOpens,
  };
}

async function update(options: Parameters<typeof fixture>[0] = {}, automatic = false) {
  const page = fixture(options);
  const result = (await vm.runInContext(
    buildChatGptProjectInstructionsUpdateScript({ ...input, automatic }).source,
    page.context,
  )) as { status: string; reason: string };
  return { ...page, result };
}

describe('Project instructions UI persistence and identity', () => {
  it('opens a pointerdown Project actions menu for both initial saving and read-back', async () => {
    const page = fixture({ current: '', currentUi: true, pointerMenu: true });
    const result = await vm.runInContext(
      buildChatGptProjectInstructionsUpdateScript({
        ...input,
        initializeEmpty: true,
        expectedProjectUrl: 'https://chatgpt.com/g/project-fixture/project',
      }).source,
      page.context,
    );
    expect(result.status).toBe('completed');
    expect(page.persisted()).toBe(block());
    expect(page.pointerOpens()).toBe(2);
  });

  it('does not dispatch pointer fallback on a disabled Project actions control', async () => {
    const page = fixture({ currentUi: true, pointerMenu: true });
    page.details.disabled = true;
    const result = await vm.runInContext(
      buildChatGptProjectInstructionsUpdateScript(input).source,
      page.context,
    );
    expect(result.status).toBe('needs_user');
    expect(page.pointerOpens()).toBe(0);
    expect(page.writes()).toBe(0);
  });

  it('does not dispatch pointer fallback after trusted input interrupts the menu wait', async () => {
    const page = fixture({ currentUi: true, pointerMenu: true, interruptOnControlWait: true });
    const result = await vm.runInContext(
      buildChatGptProjectInstructionsUpdateScript(input).source,
      page.context,
    );
    expect(result.status).toBe('needs_user');
    expect(page.pointerOpens()).toBe(0);
    expect(page.writes()).toBe(0);
  });
  it.each([false, true])(
    'does not mistake an already open instruction draft for saved settings (%s)',
    async (automatic) => {
      const page = await update({ busyDialog: true, current: block() }, automatic);
      expect(page.result.status).toBe('needs_user');
      expect(page.result.reason).toBe('automation_deferred');
      expect(page.writes()).toBe(0);
      expect(page.clicks()).toBe(0);
    },
  );
  it('submits creation without relying on the submitting document for instruction setup', async () => {
    const page = fixture({ create: true, current: '' });
    const result = await vm.runInContext(
      buildChatGptProjectAutomationScript({ ...input, createOnly: true }).source,
      page.context,
    );
    expect(result).toBe('submitted');
    expect(page.persisted()).toBe('');
    expect(page.clicks()).toBe(0);
  });

  it('initializes an empty instruction field only on the pinned Project', async () => {
    const page = fixture({ current: '', currentUi: true });
    const result = await vm.runInContext(
      buildChatGptProjectInstructionsUpdateScript({
        ...input,
        initializeEmpty: true,
        expectedProjectUrl: 'https://chatgpt.com/g/project-fixture/project',
      }).source,
      page.context,
    );
    expect(result.status).toBe('completed');
    expect(page.persisted()).toBe(block());
    expect(page.clicks()).toBe(1);
  });

  it.each(['missing', 'disabled', 'unpersisted', 'pending'] as const)(
    'does not confirm initial instructions while Save is %s',
    async (save) => {
      const page = fixture({ current: '', save });
      const result = await vm.runInContext(
        buildChatGptProjectInstructionsUpdateScript({
          ...input,
          initializeEmpty: true,
          expectedProjectUrl: 'https://chatgpt.com/g/project-fixture/project',
        }).source,
        page.context,
      );
      expect(result.status).toBe('needs_user');
      expect(page.persisted()).toBe('');
    },
  );

  it.each([
    {
      automatic: true,
      expectedProjectUrl: 'https://chatgpt.com/g/project-fixture/project',
      current: '',
    },
    { current: '' },
    { expectedProjectUrl: 'https://chatgpt.com/g/different/project', current: '' },
    {
      expectedProjectUrl: 'https://chatgpt.com/g/project-fixture/project',
      current: 'Custom instructions',
    },
  ])('does not initialize an unowned, busy or customized field (%j)', async (options) => {
    const page = fixture({ current: options.current });
    const result = await vm.runInContext(
      buildChatGptProjectInstructionsUpdateScript({ ...input, initializeEmpty: true, ...options })
        .source,
      page.context,
    );
    expect(result.status).toBe('needs_user');
    expect(page.writes()).toBe(0);
    expect(page.persisted()).toBe(options.current);
  });

  it('recognizes the current creation dialog name field without the legacy form', async () => {
    const page = fixture({ create: true, currentCreateUi: true });
    expect(
      await vm.runInContext(buildChatGptProjectCreateModalProbeScript(500), page.context),
    ).toBe(true);
  });

  it('creates and verifies instructions with the current creation dialog and Project actions header', async () => {
    const page = fixture({ create: true, current: '', currentCreateUi: true, currentUi: true });
    const result = await vm.runInContext(
      buildChatGptProjectAutomationScript(input).source,
      page.context,
    );
    expect(result.status).toBe('completed');
    expect(page.persisted()).toBe(block());
    expect(page.openerClicks()).toBe(0);
  });

  it.each(['ko', 'en'] as const)(
    'opens the current Projects index Create control (%s)',
    async (projectListOpener) => {
      const page = fixture({ create: true, projectListOpener });
      expect(await vm.runInContext(buildChatGptProjectCreateClickScript(), page.context)).toBe(
        'clicked',
      );
      expect(page.openerClicks()).toBe(1);
    },
  );

  it.each(['ambiguous', 'outside-main', 'dialog', 'disabled'] as const)(
    'does not use a generic Create control in an unsafe context (%s)',
    async (projectListOpener) => {
      const page = fixture({ create: true, projectListOpener });
      expect(await vm.runInContext(buildChatGptProjectCreateClickScript(), page.context)).toBe(
        'not_found',
      );
      expect(page.openerClicks()).toBe(0);
    },
  );

  it.each([false, true])(
    'guards trusted input while waiting for the new Project opener (%s)',
    async (interrupted) => {
      const page = fixture({ create: true, openerOnly: true, interruptOnControlWait: interrupted });
      const result = await vm.runInContext(buildChatGptProjectCreateClickScript(), page.context);
      expect(result).toBe(interrupted ? 'context_changed' : 'clicked');
      expect(page.openerClicks()).toBe(interrupted ? 0 : 1);
    },
  );

  it.each([false, true])(
    'guards trusted input while waiting for the creation modal (%s)',
    async (interrupted) => {
      const page = fixture({
        create: true,
        nameAfterWait: true,
        interruptOnControlWait: interrupted,
      });
      const result = await vm.runInContext(
        buildChatGptProjectCreateModalProbeScript(500),
        page.context,
      );
      expect(result).toBe(interrupted ? 'context_changed' : true);
    },
  );

  it.each([
    block(`ws_${'b'.repeat(24)}`),
    block(workspaceId, `wb_${'1'.repeat(64)}`),
    `${block()}\n${block()}`,
  ])('never writes a different or ambiguous binding', async (current) => {
    const page = await update({ current });
    expect(page.result.status).toBe('needs_user');
    expect(page.writes()).toBe(0);
    expect(page.persisted()).toBe(current);
  });

  it.each(['missing', 'disabled', 'unpersisted', 'pending'] as const)(
    'does not confirm an update when Save is %s',
    async (save) => {
      const page = await update({ save });
      expect(page.result.status).toBe('needs_user');
    },
  );

  it('does not confirm creation with a missing Save control', async () => {
    const page = fixture({ create: true, current: '', save: 'missing' });
    const result = await vm.runInContext(
      buildChatGptProjectAutomationScript(input).source,
      page.context,
    );
    expect(result.status).toBe('needs_user');
    expect(page.writes()).toBe(1);
  });

  it('confirms creation only after persisted settings are reopened', async () => {
    const page = fixture({ create: true, current: '' });
    const result = await vm.runInContext(
      buildChatGptProjectAutomationScript(input).source,
      page.context,
    );
    expect(result.status).toBe('completed');
    expect(page.persisted()).toBe(block());
  });

  it('stops creation before writing instructions when trusted input changes the creation context', async () => {
    const page = fixture({ create: true, current: '', interactOnCreate: true });
    const result = await vm.runInContext(
      buildChatGptProjectAutomationScript(input).source,
      page.context,
    );
    expect(result.status).toBe('needs_user');
    expect(page.writes()).toBe(0);
    expect(page.persisted()).toBe('');
  });

  it('reopens settings and preserves custom instructions around the managed block', async () => {
    const page = await update({
      current: `Before\n${block(workspaceId, binding, 'old rules')}\nAfter`,
    });
    expect(page.result.status).toBe('completed');
    expect(page.persisted()).toBe(`Before\n${block()}\nAfter`);
    expect(page.clicks()).toBe(1);
  });

  it('supports the current Project actions header and a labelled field with a generic placeholder', async () => {
    const page = await update({ currentUi: true });
    expect(page.result.status).toBe('completed');
    expect(page.persisted()).toBe(block());
    expect(page.clicks()).toBe(1);
  });

  it('defers automatic changes while the composer has focus', async () => {
    const page = await update({ busy: true }, true);
    expect(page.result.status).toBe('needs_user');
    expect(page.writes()).toBe(0);
  });

  it('does not confirm a save after navigation changes the target', async () => {
    const page = await update({ navigateOnSave: true });
    expect(page.result.status).toBe('needs_user');
  });
});

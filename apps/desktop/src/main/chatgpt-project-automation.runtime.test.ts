import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

import {
  buildChatGptProjectAutomationScript,
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
    save?: 'enabled' | 'disabled' | 'missing' | 'unpersisted';
    create?: boolean;
    busy?: boolean;
    navigateOnSave?: boolean;
    currentUi?: boolean;
  } = {},
) {
  let persisted = options.current ?? block(workspaceId, binding, 'old rules');
  let open = false;
  let writes = 0;
  let clicks = 0;
  let now = 0;
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
  const main = new Element();
  main.querySelectorAll = () => [details];
  const settings = new Button('Project settings');
  settings.click = () => {
    open = true;
    field.draft = persisted;
  };
  const create = new Button('Create');
  create.click = () => {
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
    if (options.save !== 'unpersisted') persisted = field.draft;
    open = false;
    if (options.navigateOnSave) location.pathname = '/other-project';
  };
  dialog.querySelectorAll = () => (options.save === 'missing' ? [close] : [save, close]);
  const location = {
    origin: 'https://chatgpt.com',
    pathname: options.create ? '/projects' : '/g/project-fixture/project',
  };
  const document = {
    activeElement: options.busy ? new TextArea('Message') : options.create ? name : null,
    visibilityState: 'visible',
    querySelector: (selector: string) =>
      selector.includes('project-name') ? name : selector === 'main' ? main : null,
    querySelectorAll: (selector: string) =>
      selector.startsWith('textarea')
        ? open
          ? [field]
          : []
        : selector.includes('input')
          ? [name]
          : [details, settings, create, ...(open ? dialog.querySelectorAll() : [])],
    getElementById: () => null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
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
        callback();
      },
    },
    InputEvent: class {},
    Event: class {},
    MouseEvent: class {},
    Date: class extends Date {
      static override now() {
        return now;
      }
    },
    Promise,
  });
  return { context, field, persisted: () => persisted, writes: () => writes, clicks: () => clicks };
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

  it.each(['missing', 'disabled', 'unpersisted'] as const)(
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

import {
  ChatGptProjectAutomationResultSchema,
  ProjectBindingResultSchema,
  WorkspaceSummarySchema,
} from '@chatsplice/protocol';
import type { ChatGptProjectAutomationResult } from '@chatsplice/protocol';

const PROJECTS_URL = 'https://chatgpt.com/projects';
const AUTOMATION_TIMEOUT_MS = 15_000;

export interface ChatGptProjectAutomationInput {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly bindingText: string;
  readonly automatic?: boolean;
}

export interface ChatGptProjectAutomationScript {
  readonly url: string;
  readonly source: string;
}

// Shared fixed settings UI logic. A field write is never treated as a saved setting.
const PROJECT_SETTINGS_SAVE_HELPERS = String.raw`
      let contextPath = location.origin + location.pathname;
      let interactionChanged = false;
      const onInteraction = (event) => { if (event.isTrusted) interactionChanged = true; };
      const contextIsCurrent = () => !interactionChanged && !window.__chatspliceProjectInstructionsCancelled &&
        document.visibilityState !== 'hidden' && location.origin + location.pathname === contextPath;
      const stopGuard = () => {
        for (const name of ['pointerdown', 'keydown', 'input', 'compositionstart']) {
          document.removeEventListener(name, onInteraction, true);
        }
      };
      const startGuard = () => {
        for (const name of ['pointerdown', 'keydown', 'input', 'compositionstart']) {
          document.addEventListener(name, onInteraction, true);
        }
      };
      const findProjectDetailsTrigger = () => {
        const known = findControl(['프로젝트 세부 정보 표시', '프로젝트 세부정보 표시',
          '프로젝트 세부 정보', 'Show project details', 'Project details']);
        if (known) return known;
        if (!location.pathname.endsWith('/project')) return null;
        const projectMain = document.querySelector('main');
        if (!(projectMain instanceof HTMLElement)) return null;
        const matches = Array.from(projectMain.querySelectorAll('button, [role="button"]')).filter(
          (element) => visible(element) && ['프로젝트 액션', 'Project actions'].includes(labelOf(element)),
        );
        return matches.length === 1 ? matches[0] : null;
      };
      const readInstructions = (element) => element instanceof HTMLTextAreaElement
        ? Reflect.get(element, 'value') : element.textContent ?? '';
      const enabled = (element) => element instanceof HTMLElement &&
        !(element instanceof HTMLButtonElement && element.disabled) &&
        element.getAttribute('aria-disabled') !== 'true';
      const closeSettings = async (dialog) => {
        if (!contextIsCurrent()) return false;
        if (!dialog.isConnected) return true;
        const close = findControl(['프로젝트 설정 닫기', 'Close project settings', '대화 상자 닫기', 'Close dialog', '닫기', 'Close'], dialog);
        if (!enabled(close)) return false;
        click(close);
        return Boolean(await waitFor(() => !dialog.isConnected || null, 2_000));
      };
      const saveAndVerify = async (instructions, expected) => {
        const settingsDialog = instructions.closest('[role="dialog"]');
        if (!(settingsDialog instanceof HTMLElement) || !contextIsCurrent()) return false;
        const save = await waitFor(() => {
          if (!contextIsCurrent() || !settingsDialog.isConnected) return null;
          const candidate = findControl(['저장', '지침 저장', 'Save', 'Save changes'], settingsDialog);
          return enabled(candidate) ? candidate : null;
        }, 3_000);
        if (!save || !contextIsCurrent()) return false;
        click(save);
        const acknowledged = await waitFor(() => !contextIsCurrent() ? null :
          !settingsDialog.isConnected || !enabled(save) || null, 3_000);
        if (!acknowledged || !await closeSettings(settingsDialog) || !contextIsCurrent()) return false;
        const details = findProjectDetailsTrigger();
        if (!enabled(details)) return false;
        click(details);
        const settings = await waitFor(() => contextIsCurrent() ?
          findControl(['프로젝트 설정', 'Project settings']) : null, 2_000);
        if (!enabled(settings) || !contextIsCurrent()) return false;
        click(settings);
        const reopened = await waitFor(() => contextIsCurrent() ? findProjectInstructionsInput() : null, 2_000);
        if (!(reopened instanceof HTMLElement) || !contextIsCurrent() || readInstructions(reopened) !== expected) return false;
        const reopenedDialog = reopened.closest('[role="dialog"]');
        return reopenedDialog instanceof HTMLElement && await closeSettings(reopenedDialog) && contextIsCurrent();
      };
`;

/**
 * Locates the fixed New Project control by its accessible name (aria-label/
 * role, not CSS classes — ChatGPT's class names are build-generated and
 * change on every deploy) and clicks it directly, the same way every later
 * step in {@link buildChatGptProjectAutomationScript} already does.
 */
export function buildChatGptProjectCreateClickScript(): string {
  return `(() => {
    const timeoutMs = ${AUTOMATION_TIMEOUT_MS};
    const normalized = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
    };
    const labelOf = (element) =>
      normalized(element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent);
    const findNewProjectControl = () =>
      Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"]')).find(
        (element) => visible(element) && ['새 프로젝트', '새 프로젝트 추가', 'New project', 'Add new project', 'Create project'].includes(labelOf(element)),
      );
    const waitFor = async (find) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const element = find();
        if (element) return element;
        await new Promise((resolve) => window.setTimeout(resolve, 100));
      }
      return null;
    };

    return (async () => {
      if (location.origin !== 'https://chatgpt.com' || !location.pathname.startsWith('/projects')) {
        return 'not_found';
      }
      const newProject = await waitFor(findNewProjectControl);
      if (!(newProject instanceof HTMLElement)) return 'not_found';
      newProject.click();
      return 'clicked';
    })();
  })()`;
}

/**
 * Checks only whether the Create Project modal's name field is now visible,
 * so the caller can confirm the native New Project click actually landed
 * before committing to the longer fill-and-submit script. Reads no page
 * content — a boolean is all it returns.
 */
export function buildChatGptProjectCreateModalProbeScript(waitMs: number): string {
  return `(() => {
    const timeoutMs = ${Math.max(0, Math.round(waitMs))};
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
    };
    const findProjectNameInput = () => {
      const fixedProjectNameInput = document.querySelector(
        'form[data-testid="create-new-project-form"] input#project-name',
      );
      return fixedProjectNameInput instanceof HTMLInputElement && visible(fixedProjectNameInput);
    };
    const waitFor = async (find) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (find()) return true;
        await new Promise((resolve) => window.setTimeout(resolve, 100));
      }
      return find();
    };
    return waitFor(findProjectNameInput);
  })()`;
}

/**
 * Builds a fixed Project creation script that ChatSplice can execute in a remote
 * ChatGPT page. The renderer never receives either this script or the binding.
 *
 * The script does not read conversation data, cookies, tokens, history, or
 * project lists. It only locates the fixed Project creation/settings controls,
 * writes the supplied binding, and returns a small status code.
 */
export function buildChatGptProjectAutomationScript(
  input: ChatGptProjectAutomationInput,
): ChatGptProjectAutomationScript {
  WorkspaceSummarySchema.shape.workspace_id.parse(input.workspaceId);
  const workspaceName = WorkspaceSummarySchema.shape.display_name.parse(input.workspaceName);
  const bindingText = ProjectBindingResultSchema.parse({
    binding_text: input.bindingText,
  }).binding_text;
  const payload = JSON.stringify({ workspaceName, bindingText });

  return {
    url: PROJECTS_URL,
    source: `(() => {
      const payload = ${payload};
      const timeoutMs = ${AUTOMATION_TIMEOUT_MS};
      const normalized = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
      };
      const labelOf = (element) =>
        normalized(element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent);
      const matches = (element, labels) => labels.some((label) => labelOf(element) === label);
      const findControl = (labels, root = document) =>
        Array.from(root.querySelectorAll('button, [role="button"], [role="menuitem"]')).find(
          (element) => visible(element) && matches(element, labels),
        );
      const labelledText = (element) => {
        const labelledBy = element.getAttribute('aria-labelledby');
        if (!labelledBy) return '';
        return normalized(
          labelledBy
            .split(/\\s+/)
            .map((id) => document.getElementById(id)?.textContent)
            .join(' '),
        );
      };
      const inputLabelOf = (element) =>
        normalized(
          element.getAttribute('aria-label') ||
            labelledText(element) ||
            Array.from(element.labels ?? []).map((candidate) => candidate.textContent).join(' ') ||
            element.getAttribute('placeholder'),
        );
      const findProjectNameInput = () => {
        const fixedProjectNameInput = document.querySelector(
          'form[data-testid="create-new-project-form"] input#project-name',
        );
        if (fixedProjectNameInput instanceof HTMLInputElement && visible(fixedProjectNameInput)) {
          return fixedProjectNameInput;
        }

        return (() => {
          const active = document.activeElement;
          if (
            active instanceof HTMLInputElement &&
            visible(active) &&
            active.type !== 'search' &&
            active.type !== 'hidden'
          ) {
            return active;
          }
          return Array.from(document.querySelectorAll('input')).find((element) => {
            if (!visible(element) || element.type === 'search' || element.type === 'hidden') return false;
            const label = inputLabelOf(element);
            return ['프로젝트 이름', 'Project name'].includes(label);
          });
        })();
      };
      const findProjectInstructionsInput = () =>
        Array.from(document.querySelectorAll('textarea, [contenteditable="true"]')).find(
          (element) =>
            visible(element) &&
            ['지침', '프로젝트 지침', 'Instructions', 'Project instructions'].includes(inputLabelOf(element)),
        );
      const waitFor = async (find, waitMs = timeoutMs) => {
        const deadline = Date.now() + waitMs;
        while (Date.now() < deadline) {
          const element = find();
          if (element) return element;
          await new Promise((resolve) => window.setTimeout(resolve, 100));
        }
        return null;
      };
      const click = (element) => {
        if (element instanceof HTMLElement) {
          element.click();
          return;
        }
        element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      };
      ${PROJECT_SETTINGS_SAVE_HELPERS}
      const result = (status, reason, message) => { stopGuard(); return { status, reason, message }; };

      return (async () => {
        if (location.origin !== 'https://chatgpt.com' || !location.pathname.startsWith('/projects')) {
          return result('needs_user', 'chatgpt_ui_changed', 'ChatGPT Projects 화면을 열지 못했습니다.');
        }

        const projectNameInput = await waitFor(findProjectNameInput);
        if (!(projectNameInput instanceof HTMLInputElement)) {
          return result('needs_user', 'chatgpt_ui_changed', 'ChatGPT의 새 Project 생성 창이 열리지 않았습니다.');
        }
        const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        inputSetter?.call(projectNameInput, payload.workspaceName);
        projectNameInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: payload.workspaceName }));
        projectNameInput.dispatchEvent(new Event('change', { bubbles: true }));

        const create = await waitFor(() =>
          findControl(['프로젝트 만들기', '새 프로젝트 만들기', '만들기', 'Create project', 'Create']),
        );
        if (!create || create instanceof HTMLButtonElement && create.disabled) {
          return result('needs_user', 'chatgpt_ui_changed', 'ChatGPT의 새 Project 만들기 버튼을 찾지 못했습니다.');
        }
        click(create);

        const details = await waitFor(findProjectDetailsTrigger);
        if (!details) {
          return result('needs_user', 'project_setup_failed', '새 ChatGPT Project를 열지 못했습니다.');
        }
        click(details);

        const settings = await waitFor(() =>
          findControl(['프로젝트 설정', 'Project settings']),
        );
        if (!settings) {
          return result('needs_user', 'chatgpt_ui_changed', 'Project settings 메뉴를 찾지 못했습니다.');
        }
        click(settings);

        const instructions = await waitFor(findProjectInstructionsInput);
        if (!(instructions instanceof HTMLElement)) {
          return result('needs_user', 'chatgpt_ui_changed', 'Project instructions 입력칸을 찾지 못했습니다.');
        }
        if (location.pathname.startsWith('/projects')) {
          return result('needs_user', 'project_setup_failed', '새 Project 화면으로 이동했는지 확인하지 못했습니다.');
        }
        const settingsDialog = instructions.closest('[role="dialog"]');
        if (!(settingsDialog instanceof HTMLElement)) {
          return result('needs_user', 'chatgpt_ui_changed', 'Project settings 대화상자를 확인하지 못했습니다.');
        }
        contextPath = location.origin + location.pathname;
        startGuard();

        if (instructions instanceof HTMLTextAreaElement) {
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
          setter?.call(instructions, payload.bindingText);
          instructions.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: payload.bindingText }));
          instructions.dispatchEvent(new Event('change', { bubbles: true }));
          instructions.blur();
        } else {
          instructions.focus();
          document.execCommand('selectAll', false);
          document.execCommand('insertText', false, payload.bindingText);
          instructions.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: payload.bindingText }));
          instructions.dispatchEvent(new Event('change', { bubbles: true }));
          instructions.blur();
        }

        if (!await saveAndVerify(instructions, payload.bindingText)) {
          return result('needs_user', 'project_setup_failed', 'Project instructions 저장을 재확인하지 못했습니다. 열린 설정을 확인하세요.');
        }
        return result('completed', 'created_and_bound', 'ChatGPT Project를 만들고 지침 저장을 재확인했습니다.');
      })();
    })()`,
  };
}

export interface ChatGptProjectInstructionsUpdateScript {
  readonly source: string;
}

/**
 * Builds the script for refreshing instructions on a Project ChatSplice has
 * already bound. Unlike creation, this runs on whatever ChatGPT page the
 * caller has already navigated the tab to — it never picks the destination
 * itself. It only ever replaces the exact text between the ChatSplice
 * BEGIN/END markers it already wrote. It recognizes the previous LocalChat
 * markers once so an existing Project can migrate in place; if all supported
 * markers are missing (a hand-edited field), it aborts without touching it so a
 * human can merge it once, matching the manual instructions shown elsewhere.
 */
export function buildChatGptProjectInstructionsUpdateScript(
  input: ChatGptProjectAutomationInput,
): ChatGptProjectInstructionsUpdateScript {
  WorkspaceSummarySchema.shape.workspace_id.parse(input.workspaceId);
  const bindingText = ProjectBindingResultSchema.parse({
    binding_text: input.bindingText,
  }).binding_text;
  const payload = JSON.stringify({
    bindingText,
    workspaceId: input.workspaceId,
    automatic: input.automatic === true,
  });

  return {
    source: `(() => {
      const payload = ${payload};
      const timeoutMs = ${AUTOMATION_TIMEOUT_MS};
      const MARKER_PAIRS = [
        {
          begin: '--- BEGIN CHATSPLICE PROJECT INSTRUCTIONS',
          end: '--- END CHATSPLICE PROJECT INSTRUCTIONS',
        },
        {
          begin: '--- BEGIN LOCALCHAT PROJECT INSTRUCTIONS',
          end: '--- END LOCALCHAT PROJECT INSTRUCTIONS',
        },
      ];
      const normalized = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
      };
      const labelOf = (element) =>
        normalized(element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent);
      const matches = (element, labels) => labels.some((label) => labelOf(element) === label);
      const findControl = (labels, root = document) =>
        Array.from(root.querySelectorAll('button, [role="button"], [role="menuitem"]')).find(
          (element) => visible(element) && matches(element, labels),
        );
      const labelledText = (element) => {
        const labelledBy = element.getAttribute('aria-labelledby');
        if (!labelledBy) return '';
        return normalized(
          labelledBy
            .split(/\\s+/)
            .map((id) => document.getElementById(id)?.textContent)
            .join(' '),
        );
      };
      const inputLabelOf = (element) =>
        normalized(
          element.getAttribute('aria-label') ||
            labelledText(element) ||
            Array.from(element.labels ?? []).map((candidate) => candidate.textContent).join(' ') ||
            element.getAttribute('placeholder'),
        );
      const findProjectInstructionsInput = () =>
        Array.from(document.querySelectorAll('textarea, [contenteditable="true"]')).find(
          (element) =>
            visible(element) &&
            ['지침', '프로젝트 지침', 'Instructions', 'Project instructions'].includes(inputLabelOf(element)),
        );
      const waitFor = async (find, waitMs = timeoutMs) => {
        const deadline = Date.now() + waitMs;
        while (Date.now() < deadline) {
          const element = find();
          if (element) return element;
          await new Promise((resolve) => window.setTimeout(resolve, 100));
        }
        return null;
      };
      const click = (element) => {
        if (element instanceof HTMLElement) {
          element.click();
          return;
        }
        element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      };
      ${PROJECT_SETTINGS_SAVE_HELPERS}
      const result = (status, reason, message) => { stopGuard(); return { status, reason, message }; };

      return (async () => {
        if (location.origin !== 'https://chatgpt.com') {
          return result('needs_user', 'chatgpt_ui_changed', 'ChatGPT Project 화면을 열지 못했습니다.');
        }

        const active = document.activeElement;
        if (payload.automatic && (document.visibilityState === 'hidden' ||
          active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ||
          active instanceof HTMLElement && active.getAttribute('contenteditable') === 'true' ||
          Array.from(document.querySelectorAll('[role="dialog"], [role="menu"]')).some(visible))) {
          return result('needs_user', 'automation_deferred', '입력 또는 다른 화면이 활성화되어 자동 갱신을 미뤘습니다.');
        }
        startGuard();
        const detailsTrigger = await waitFor(() => contextIsCurrent() ? findProjectDetailsTrigger() : null, payload.automatic ? 1_000 : timeoutMs);
        if (!detailsTrigger || !contextIsCurrent()) {
          return result('needs_user', 'chatgpt_ui_changed', 'ChatGPT Project 옵션 버튼을 찾지 못했습니다.');
        }
        click(detailsTrigger);

        const settings = await waitFor(() => contextIsCurrent() ? findControl(['프로젝트 설정', 'Project settings']) : null);
        if (!settings || !contextIsCurrent()) {
          return result('needs_user', 'chatgpt_ui_changed', 'Project settings 메뉴를 찾지 못했습니다.');
        }
        click(settings);

        const instructions = await waitFor(() => contextIsCurrent() ? findProjectInstructionsInput() : null);
        if (!(instructions instanceof HTMLElement)) {
          return result('needs_user', 'chatgpt_ui_changed', 'Project instructions 입력칸을 찾지 못했습니다.');
        }
        const settingsDialog = instructions.closest('[role="dialog"]');
        if (!(settingsDialog instanceof HTMLElement) || !contextIsCurrent()) {
          return result('needs_user', 'chatgpt_ui_changed', 'Project settings 대화상자를 확인하지 못했습니다.');
        }
        const current = readInstructions(instructions);
        const markerPair = MARKER_PAIRS.find(({ begin, end }) => {
          const candidateBegin = current.indexOf(begin);
          return candidateBegin !== -1 && current.indexOf(end, candidateBegin + begin.length) !== -1;
        });
        if (!markerPair) {
          return result(
            'needs_user',
            'needs_manual_merge',
            '기존 ChatSplice 표시를 찾지 못해 자동으로 교체하지 못했습니다.',
          );
        }
        const beginIndex = current.indexOf(markerPair.begin);
        const endIndex = current.indexOf(markerPair.end, beginIndex + markerPair.begin.length);
        const endLineBreak = current.indexOf('\\n', endIndex);
        const replaceEnd = endLineBreak === -1 ? current.length : endLineBreak;
        const managed = current.slice(beginIndex, replaceEnd);
        const identity = (text, key) => text.split('\\n').filter((line) => line.startsWith('- ' + key + ': '));
        const sameIdentity = ['workspace_id', 'workspace_binding'].every((key) => {
          const existing = identity(managed, key);
          const expected = identity(payload.bindingText, key);
          return existing.length === 1 && expected.length === 1 && existing[0] === expected[0];
        });
        const uniqueMarkers = MARKER_PAIRS.every(({ begin, end }) =>
          current.split(begin).length - 1 === (begin === markerPair.begin ? 1 : 0) &&
          current.split(end).length - 1 === (end === markerPair.end ? 1 : 0));
        if (!sameIdentity || !uniqueMarkers) {
          await closeSettings(settingsDialog);
          return result('needs_user', 'needs_manual_merge', '다른 프로젝트의 binding 또는 중복된 지침을 발견해 교체를 중단했습니다.');
        }
        const nextValue = current.slice(0, beginIndex) + payload.bindingText + current.slice(replaceEnd);

        if (nextValue === current) {
          await closeSettings(settingsDialog);
          return result('completed', 'instructions_current', 'Project instructions가 이미 최신 상태입니다.');
        }

        if (instructions instanceof HTMLTextAreaElement) {
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
          setter?.call(instructions, nextValue);
          instructions.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: nextValue }));
          instructions.dispatchEvent(new Event('change', { bubbles: true }));
          instructions.blur();
        } else {
          instructions.focus();
          document.execCommand('selectAll', false);
          document.execCommand('insertText', false, nextValue);
          instructions.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: nextValue }));
          instructions.dispatchEvent(new Event('change', { bubbles: true }));
          instructions.blur();
        }

        if (!await saveAndVerify(instructions, nextValue)) {
          return result('needs_user', 'chatgpt_ui_changed', 'Project instructions 저장을 재확인하지 못했습니다. 열린 설정을 확인하세요.');
        }
        return result('completed', 'instructions_updated', 'Project instructions를 최신 상태로 갱신했습니다.');
      })();
    })()`,
  };
}

export function parseChatGptProjectAutomationResult(
  value: unknown,
): ChatGptProjectAutomationResult {
  return ChatGptProjectAutomationResultSchema.parse(value);
}

<script lang="ts">
  import type { WorkspaceDetail, WorkspaceReference } from '@chatsplice/protocol';
  import { uiText, type UiLocale } from './i18n.js';
  import {
    workspaceFolderAccess,
    workspaceFolderPath,
    workspaceFolderNeedsReapproval,
    type WorkspaceFolderAccessMode,
  } from './workspace-folders-view.js';

  export let workspaceId: string;
  export let locale: UiLocale;
  export let workspaces: WorkspaceDetail[];
  export let references: WorkspaceReference[];
  export let pending = false;
  export let error = '';
  export let onAdd: (mode: WorkspaceFolderAccessMode) => Promise<void>;
  export let onSetAccess: (
    reference: WorkspaceReference,
    mode: WorkspaceFolderAccessMode,
  ) => Promise<void>;
  export let onRemove: (reference: WorkspaceReference) => Promise<void>;

  let newFolderAccess: WorkspaceFolderAccessMode = 'read_write';
  $: titleId = `workspace-folders-${workspaceId}`;
  $: t = (key: Parameters<typeof uiText>[1]) => uiText(locale, key);

  function folderName(reference: WorkspaceReference): string {
    return (
      workspaces.find((workspace) => workspace.workspace_id === reference.reference_workspace_id)
        ?.display_name ?? t('workspaceFolderMissing')
    );
  }

  function changeAccess(reference: WorkspaceReference, event: Event): void {
    const select = event.currentTarget as HTMLSelectElement;
    const next = select.value === 'read_write' ? 'read_write' : 'read_only';
    // Keep the displayed grant authoritative while its update is pending or rejected.
    select.value = workspaceFolderAccess(reference);
    void onSetAccess(reference, next);
  }
</script>

<section
  class="modal-section workspace-folders"
  data-testid="workspace-folders"
  aria-labelledby={titleId}
  aria-busy={pending}
>
  <div class="folder-section-heading">
    <div>
      <h3 id={titleId}>{t('workspaceFoldersTitle')}</h3>
      <p>{t('workspaceFoldersHelp')}</p>
    </div>
  </div>

  <div class="folder-add-row">
    <label class="folder-new-access">
      <span>{t('workspaceFolderNewAccess')}</span>
      <select bind:value={newFolderAccess} disabled={pending}>
        <option value="read_only">{t('workspaceFolderReadOnly')}</option>
        <option value="read_write">{t('workspaceFolderReadWrite')}</option>
      </select>
    </label>
    <button
      type="button"
      class="secondary-button folder-add-button"
      disabled={pending}
      onclick={() => void onAdd(newFolderAccess)}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"
        ><path d="M3 7h6l2 2h10v10H3zM14 12v5m-2.5-2.5h5" /></svg
      >
      {t('workspaceFolderAdd')}
    </button>
  </div>

  {#if references.length === 0}
    <p class="folder-empty">{t('workspaceFoldersEmpty')}</p>
  {:else}
    <ul class="folder-list">
      {#each references as reference (reference.reference_workspace_id)}
        {@const path = workspaceFolderPath(reference, workspaces)}
        {@const needsReapproval = workspaceFolderNeedsReapproval(reference, workspaces)}
        <li class="folder-row" data-reference-id={reference.reference_workspace_id}>
          <div class="folder-copy">
            <strong>{folderName(reference)}</strong>
            <code title={path}>{path || t('workspaceFolderMissing')}</code>
            {#if needsReapproval}
              <p class="folder-path-changed">{t('workspaceFolderPathChanged')}</p>
              <button
                type="button"
                class="folder-reapply"
                disabled={pending}
                onclick={() => void onSetAccess(reference, 'read_write')}
              >
                {t('workspaceFolderReapplyAccess')}
              </button>
            {/if}
          </div>
          <div class="folder-row-actions">
            <select
              aria-label={`${folderName(reference)} ${t('workspaceFolderAccess')}`}
              value={workspaceFolderAccess(reference)}
              disabled={pending}
              onchange={(event) => changeAccess(reference, event)}
            >
              <option value="read_only">{t('workspaceFolderReadOnly')}</option>
              <option value="read_write">{t('workspaceFolderReadWrite')}</option>
            </select>
            <button
              type="button"
              class="folder-disconnect"
              disabled={pending}
              onclick={() => void onRemove(reference)}
            >
              {t('workspaceFolderDisconnect')}
            </button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}

  {#if pending}<p class="folder-pending" role="status">{t('workspaceFolderPending')}</p>{/if}
  {#if error}<p class="folder-error" role="alert">{error}</p>{/if}
</section>

<style>
  .workspace-folders {
    min-width: 0;
  }
  .folder-section-heading h3 {
    margin: 0;
  }
  .folder-section-heading p {
    margin: 6px 0 0;
    color: var(--color-text-muted);
    line-height: 1.65;
    word-break: keep-all;
  }
  .folder-add-row {
    display: flex;
    align-items: flex-end;
    gap: 10px;
    margin-top: 16px;
  }
  .folder-new-access {
    display: grid;
    gap: 6px;
    color: var(--color-text-muted);
    font-size: 12px;
  }
  select {
    min-height: 36px;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-surface);
    color: var(--color-text);
    padding: 6px 28px 6px 10px;
    font: inherit;
    font-size: 13px;
  }
  button {
    font: inherit;
  }
  .folder-add-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    min-height: 36px;
    white-space: nowrap;
  }
  .folder-add-button svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .folder-empty {
    margin: 14px 0 0;
    padding: 14px;
    border: 1px dashed var(--color-border);
    border-radius: 8px;
    color: var(--color-text-muted);
    font-size: 13px;
  }
  .folder-list {
    display: grid;
    gap: 8px;
    margin: 14px 0 0;
    padding: 0;
    list-style: none;
  }
  .folder-row {
    display: flex;
    align-items: center;
    gap: 14px;
    min-width: 0;
    padding: 12px;
    border: 1px solid var(--color-border);
    border-radius: 9px;
    background: var(--color-surface);
  }
  .folder-copy {
    display: grid;
    gap: 5px;
    flex: 1;
    min-width: 0;
  }
  .folder-copy strong {
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  .folder-copy code {
    color: var(--color-text-muted);
    font-size: 11px;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .folder-path-changed {
    margin: 3px 0 0;
    color: var(--color-text-muted);
    font-size: 12px;
    line-height: 1.5;
    word-break: keep-all;
  }
  .folder-reapply {
    justify-self: start;
    max-width: 100%;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: transparent;
    color: var(--color-text);
    padding: 6px 8px;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  .folder-row-actions {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    gap: 10px;
  }
  .folder-row-actions select {
    max-width: 150px;
  }
  .folder-disconnect {
    border: 0;
    background: transparent;
    color: var(--color-text-muted);
    padding: 8px 4px;
    font-size: 12px;
    white-space: nowrap;
    cursor: pointer;
  }
  .folder-disconnect:hover:not(:disabled) {
    color: var(--color-text);
  }
  select:focus-visible,
  button:focus-visible {
    outline: 2px solid var(--color-focus);
    outline-offset: 2px;
  }
  select:disabled,
  button:disabled {
    opacity: 0.55;
    cursor: wait;
  }
  .folder-pending {
    margin: 10px 0 0;
    color: var(--color-text-muted);
    font-size: 12px;
  }
  .folder-error {
    margin: 10px 0 0;
    border-left: 3px solid var(--color-warn);
    padding: 8px 10px;
    color: var(--color-text);
    font-size: 13px;
    line-height: 1.5;
    word-break: keep-all;
  }
  @media (max-width: 620px) {
    .folder-row {
      align-items: stretch;
      flex-direction: column;
      gap: 10px;
    }
    .folder-row-actions {
      justify-content: space-between;
    }
  }
</style>

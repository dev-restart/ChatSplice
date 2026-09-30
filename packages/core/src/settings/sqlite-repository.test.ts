import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SqliteSettingsRepository } from './sqlite-repository.js';

describe('SqliteSettingsRepository', () => {
  it('persists non-secret tunnel configuration without a runtime credential', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-settings-'));
    const databasePath = join(temporaryDirectory, 'state.sqlite');
    const configuration = {
      tunnel_id: 'tunnel_0123456789abcdef',
      organization_id: 'org-0123456789abcdef',
      executable_path: '/Applications/ChatSplice.app/tunnel-client',
      automatic_start: true,
    };

    const firstRepository = new SqliteSettingsRepository(databasePath);
    firstRepository.setTunnelConfiguration(configuration);
    firstRepository.close();

    const secondRepository = new SqliteSettingsRepository(databasePath);
    try {
      expect(secondRepository.getTunnelConfiguration()).toEqual(configuration);
      expect(JSON.stringify(secondRepository.getTunnelConfiguration())).not.toContain('api_key');
    } finally {
      secondRepository.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('persists only minimal opaque ChatGPT browser tab navigation state', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-tabs-'));
    const databasePath = join(temporaryDirectory, 'state.sqlite');
    const timestamp = new Date().toISOString();
    const state = {
      tabs: [
        {
          chatgpt_tab_id: 'tab_0123456789abcdef01234567',
          workspace_id: 'ws_0123456789abcdef01234567',
          project_instructions_confirmed: true,
          label: 'Milestone 1 확인',
          url: 'https://chatgpt.com/c/example-navigation-token',
          created_at: timestamp,
          updated_at: timestamp,
        },
      ],
      active_tab_id: 'tab_0123456789abcdef01234567',
    };

    const firstRepository = new SqliteSettingsRepository(databasePath);
    firstRepository.setChatGptTabState(state);
    firstRepository.close();

    const secondRepository = new SqliteSettingsRepository(databasePath);
    try {
      expect(secondRepository.getChatGptTabState()).toEqual(state);
      expect(JSON.stringify(secondRepository.getChatGptTabState())).not.toContain(
        'conversation_body',
      );
    } finally {
      secondRepository.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('persists one-way workspace references and removes both directions with a workspace', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-references-'));
    const databasePath = join(temporaryDirectory, 'state.sqlite');
    const firstReference = {
      source_workspace_id: 'ws_0123456789abcdef01234567',
      reference_workspace_id: 'ws_abcdef0123456789abcdef01',
      created_at: new Date().toISOString(),
    };
    const secondReference = {
      source_workspace_id: firstReference.reference_workspace_id,
      reference_workspace_id: firstReference.source_workspace_id,
      created_at: new Date().toISOString(),
    };

    const firstRepository = new SqliteSettingsRepository(databasePath);
    firstRepository.addWorkspaceReference(firstReference);
    firstRepository.addWorkspaceReference(secondReference);
    firstRepository.close();

    const secondRepository = new SqliteSettingsRepository(databasePath);
    try {
      expect(secondRepository.getWorkspaceReferences()).toEqual({
        references: [secondReference, firstReference].sort((left, right) =>
          left.source_workspace_id.localeCompare(right.source_workspace_id),
        ),
        count: 2,
      });
      expect(
        secondRepository.removeWorkspaceReferences(firstReference.source_workspace_id),
      ).toEqual({ references: [], count: 0 });
    } finally {
      secondRepository.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('defaults read-only mode to off and persists the owner toggle across reopen', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-read-only-'));
    const databasePath = join(temporaryDirectory, 'state.sqlite');

    const firstRepository = new SqliteSettingsRepository(databasePath);
    try {
      expect(firstRepository.getReadOnlyMode()).toBe(false);
      expect(firstRepository.setReadOnlyMode(true)).toBe(true);
      expect(firstRepository.getReadOnlyMode()).toBe(true);
    } finally {
      firstRepository.close();
    }

    const secondRepository = new SqliteSettingsRepository(databasePath);
    try {
      expect(secondRepository.getReadOnlyMode()).toBe(true);
      expect(secondRepository.setReadOnlyMode(false)).toBe(false);
      expect(secondRepository.getReadOnlyMode()).toBe(false);
    } finally {
      secondRepository.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('defaults auto-attach to off per workspace and persists the owner toggle across reopen', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'chatsplice-auto-attach-'));
    const databasePath = join(temporaryDirectory, 'state.sqlite');
    const firstWorkspaceId = 'ws_0123456789abcdef01234567';
    const secondWorkspaceId = 'ws_abcdef0123456789abcdef01';

    const firstRepository = new SqliteSettingsRepository(databasePath);
    try {
      expect(firstRepository.getAutoAttachWorkspaceIds()).toEqual([]);
      expect(firstRepository.setAutoAttach(firstWorkspaceId, true)).toEqual([firstWorkspaceId]);
      expect(firstRepository.setAutoAttach(secondWorkspaceId, true)).toEqual(
        [firstWorkspaceId, secondWorkspaceId].sort(),
      );
    } finally {
      firstRepository.close();
    }

    const secondRepository = new SqliteSettingsRepository(databasePath);
    try {
      expect(secondRepository.getAutoAttachWorkspaceIds()).toEqual(
        [firstWorkspaceId, secondWorkspaceId].sort(),
      );
      expect(secondRepository.removeAutoAttach(firstWorkspaceId)).toEqual([secondWorkspaceId]);
      expect(secondRepository.getAutoAttachWorkspaceIds()).toEqual([secondWorkspaceId]);
    } finally {
      secondRepository.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

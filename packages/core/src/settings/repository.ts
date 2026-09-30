import type {
  ChatGptTabState,
  TunnelConfiguration,
  WorkspaceReference,
  WorkspaceReferenceListResult,
  WorkspaceReferenceMutationInput,
} from '@chatsplice/protocol';

export interface SettingsRepository {
  getTunnelConfiguration(): TunnelConfiguration | undefined;
  setTunnelConfiguration(configuration: TunnelConfiguration): TunnelConfiguration;
  getChatGptTabState(): ChatGptTabState | undefined;
  setChatGptTabState(state: ChatGptTabState): ChatGptTabState;
  getWorkspaceReferences(): WorkspaceReferenceListResult;
  addWorkspaceReference(reference: WorkspaceReference): WorkspaceReference;
  removeWorkspaceReference(input: WorkspaceReferenceMutationInput): WorkspaceReferenceListResult;
  removeWorkspaceReferences(workspaceId: string): WorkspaceReferenceListResult;
  getReadOnlyMode(): boolean;
  setReadOnlyMode(enabled: boolean): boolean;
  getAutoAttachWorkspaceIds(): string[];
  setAutoAttach(workspaceId: string, enabled: boolean): string[];
  removeAutoAttach(workspaceId: string): string[];
  getMcpAppName(): string | undefined;
  setMcpAppName(name: string): string;
  close(): void;
}

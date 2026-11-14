import type { WorkspaceDetail, WorkspaceKind, WorkspaceSummary } from '@chatsplice/protocol';

export interface WorkspaceRecord extends WorkspaceSummary {
  readonly rootPath: string;
}

export interface CreateWorkspaceRecord {
  readonly workspaceId: string;
  readonly displayName: string;
  readonly rootPath: string;
  readonly kind: WorkspaceKind;
  readonly createdAt: string;
}

export interface WorkspaceRepository {
  create(input: CreateWorkspaceRecord): WorkspaceRecord;
  rename(workspaceId: string, displayName: string): WorkspaceRecord | undefined;
  updateRootPath(workspaceId: string, rootPath: string): WorkspaceRecord | undefined;
  remove(workspaceId: string): boolean;
  findById(workspaceId: string): WorkspaceRecord | undefined;
  findByRoot(rootPath: string): WorkspaceRecord | undefined;
  list(): WorkspaceRecord[];
  close(): void;
}

export function toWorkspaceSummary(record: WorkspaceRecord): WorkspaceSummary {
  return {
    workspace_id: record.workspace_id,
    display_name: record.display_name,
    kind: record.kind,
    created_at: record.created_at,
  };
}

export function toWorkspaceDetail(record: WorkspaceRecord): WorkspaceDetail {
  return {
    ...toWorkspaceSummary(record),
    root_path: record.rootPath,
  };
}

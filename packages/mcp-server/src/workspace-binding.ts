import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  WorkspaceBindingSchema,
  WorkspaceSummarySchema,
  type WorkspaceBinding,
} from '@chatsplice/protocol';

const BINDING_DOMAIN = 'chatsplice-workspace-binding-v1';

export function workspaceBindingFor(secret: string, workspaceId: string): WorkspaceBinding {
  const validatedWorkspaceId = WorkspaceSummarySchema.shape.workspace_id.parse(workspaceId);
  const digest = createHmac('sha256', secret)
    .update(BINDING_DOMAIN)
    .update('\0')
    .update(validatedWorkspaceId)
    .digest('hex');
  return WorkspaceBindingSchema.parse(`wb_${digest}`);
}

export function workspaceBindingMatches(
  secret: string,
  workspaceId: string,
  candidate: string,
): boolean {
  const validatedCandidate = WorkspaceBindingSchema.safeParse(candidate);
  if (!validatedCandidate.success) {
    return false;
  }
  const expected = Buffer.from(workspaceBindingFor(secret, workspaceId));
  const received = Buffer.from(validatedCandidate.data);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

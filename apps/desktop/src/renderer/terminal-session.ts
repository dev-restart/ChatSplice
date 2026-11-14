import type { TerminalSessionSnapshot, TerminalSessionSummary } from '@chatsplice/protocol';

export const TERMINAL_POLL_INTERVAL_MS = 700;

export function snapshotToSummary(snapshot: TerminalSessionSnapshot): TerminalSessionSummary {
  return {
    terminal_id: snapshot.terminal_id,
    label: snapshot.label,
    workspace_id: snapshot.workspace_id,
    state: snapshot.state,
    cols: snapshot.cols,
    rows: snapshot.rows,
    sequence: snapshot.sequence,
  };
}

export function terminalSessionLabel(
  session: TerminalSessionSummary,
  workspaceName: string,
  index: number,
): string {
  if (workspaceName !== '') return `${workspaceName} ${index + 1}`;
  const explicit = session.label.trim();
  if (explicit !== '') return explicit;
  return `Terminal ${index + 1}`;
}

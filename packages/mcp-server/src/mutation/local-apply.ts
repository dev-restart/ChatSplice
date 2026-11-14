import {
  deleteWorkspaceFile,
  editWorkspaceFile,
  errorMessage,
  makeWorkspaceDirectory,
  renameWorkspaceFile,
  runWorkspaceGit,
  runWorkspaceProjectTask,
  writeWorkspaceFile,
} from '@chatsplice/core';
import type { WorkspaceService } from '@chatsplice/core';
import {
  LocalApplyBundleSchema,
  LocalApplyResultSchema,
  type LocalApplyBundle,
  type LocalApplyResult,
  type LocalApplyStepResult,
  type WorkspaceBinding,
} from '@chatsplice/protocol';

import type { DirectEditActivityStore } from './direct-edit-activity-store.js';

function boundedMessage(error: unknown): string {
  const message = errorMessage(error).trim();
  return (message === '' ? '로컬 패치 적용에 실패했습니다.' : message).slice(0, 500);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

async function applyLocalBundleUnlocked(
  workspaceService: WorkspaceService,
  directEditActivityStore: DirectEditActivityStore,
  workspaceBinding: WorkspaceBinding,
  input: LocalApplyBundle,
): Promise<LocalApplyResult> {
  const bundle = LocalApplyBundleSchema.parse(input);
  const workspace = workspaceService.getRecord(bundle.workspace_id);
  if (workspace.kind !== 'user') {
    return LocalApplyResultSchema.parse({
      state: 'failed',
      workspace_id: workspace.workspace_id,
      workspace_name: workspace.display_name,
      applied_steps: [],
      changed_paths: [],
      failed_step: 0,
      message: '로컬 패치는 등록된 사용자 프로젝트에만 적용할 수 있습니다.',
    });
  }

  const appliedSteps: LocalApplyStepResult[] = [];
  const changedPaths: string[] = [];

  for (const [index, operation] of bundle.operations.entries()) {
    const paths =
      operation.tool === 'fs.rename'
        ? [operation.source_path, operation.destination_path]
        : [operation.path];
    const activity = directEditActivityStore.beginActivity({
      workspace_id: workspace.workspace_id,
      workspace_name: workspace.display_name,
      source: 'local_apply',
      tool: operation.tool,
      paths,
      summary: 'ChatGPT 패치 적용 중',
    });

    try {
      let step: LocalApplyStepResult;
      switch (operation.tool) {
        case 'fs.edit': {
          const result = await editWorkspaceFile(workspaceService, {
            workspace_id: bundle.workspace_id,
            workspace_binding: workspaceBinding,
            path: operation.path,
            expected_sha256: operation.expected_sha256,
            edits: operation.edits,
          });
          step = {
            tool: operation.tool,
            paths: [result.path],
            summary: `${result.replacements}회 exact replacement`,
            sha256: result.sha256,
          };
          changedPaths.push(result.path);
          break;
        }
        case 'fs.write': {
          const result = await writeWorkspaceFile(
            workspaceService,
            operation.mode === 'create'
              ? {
                  workspace_id: bundle.workspace_id,
                  workspace_binding: workspaceBinding,
                  path: operation.path,
                  mode: operation.mode,
                  content: operation.content,
                }
              : {
                  workspace_id: bundle.workspace_id,
                  workspace_binding: workspaceBinding,
                  path: operation.path,
                  mode: operation.mode,
                  expected_sha256: operation.expected_sha256,
                  content: operation.content,
                },
          );
          step = {
            tool: operation.tool,
            paths: [result.path],
            sha256: result.sha256,
            summary:
              result.mode === 'create'
                ? `${result.bytes_written} bytes 파일 생성`
                : `${result.bytes_written} bytes 전체 교체`,
          };
          changedPaths.push(result.path);
          break;
        }
        case 'fs.mkdir': {
          const result = await makeWorkspaceDirectory(workspaceService, {
            workspace_id: bundle.workspace_id,
            workspace_binding: workspaceBinding,
            path: operation.path,
          });
          step = { tool: operation.tool, paths: [result.path], summary: '디렉터리 생성' };
          changedPaths.push(result.path);
          break;
        }
        case 'fs.rename': {
          const result = await renameWorkspaceFile(workspaceService, {
            workspace_id: bundle.workspace_id,
            workspace_binding: workspaceBinding,
            source_path: operation.source_path,
            destination_path: operation.destination_path,
            expected_sha256: operation.expected_sha256,
          });
          step = {
            tool: operation.tool,
            paths: [result.source_path, result.destination_path],
            sha256: result.sha256,
            summary: '파일 이름/위치 변경',
          };
          changedPaths.push(result.source_path, result.destination_path);
          break;
        }
        case 'fs.delete': {
          const result = await deleteWorkspaceFile(workspaceService, {
            workspace_id: bundle.workspace_id,
            workspace_binding: workspaceBinding,
            path: operation.path,
            expected_sha256: operation.expected_sha256,
          });
          step = { tool: operation.tool, paths: [result.path], summary: '파일 영구 삭제' };
          changedPaths.push(result.path);
          break;
        }
      }

      appliedSteps.push(step);
      directEditActivityStore.completeActivity(activity.activity_id, step);
    } catch (error) {
      const message = boundedMessage(error);
      directEditActivityStore.failActivity(activity.activity_id, {
        paths,
        summary: `ChatGPT 패치 실패 · ${message}`.slice(0, 240),
      });
      return LocalApplyResultSchema.parse({
        state: 'failed',
        workspace_id: workspace.workspace_id,
        workspace_name: workspace.display_name,
        applied_steps: appliedSteps,
        changed_paths: unique(changedPaths),
        failed_step: index,
        message,
      });
    }
  }

  for (const [checkIndex, check] of bundle.checks.entries()) {
    const activity = directEditActivityStore.beginActivity({
      workspace_id: workspace.workspace_id,
      workspace_name: workspace.display_name,
      source: 'local_apply',
      tool: 'project.run',
      paths: ['package.json'],
      summary: `${check.task} 검사 실행 중`,
    });
    try {
      const result = await runWorkspaceProjectTask(workspaceService, {
        workspace_id: bundle.workspace_id,
        workspace_binding: workspaceBinding,
        task: check.task,
        timeout_ms: check.timeout_ms,
      });
      const passed = result.exit_code === 0 && !result.timed_out;
      const step: LocalApplyStepResult = {
        tool: 'project.run',
        paths: ['package.json'],
        summary: `${result.task} ${passed ? '통과' : '실패'}`,
        execution: executionEvidence(result),
      };
      appliedSteps.push(step);
      if (passed) {
        directEditActivityStore.completeActivity(activity.activity_id, step);
      } else {
        directEditActivityStore.failActivity(activity.activity_id, step);
        return LocalApplyResultSchema.parse({
          state: 'failed',
          workspace_id: workspace.workspace_id,
          workspace_name: workspace.display_name,
          applied_steps: appliedSteps,
          changed_paths: unique(changedPaths),
          failed_step: bundle.operations.length + checkIndex,
          message: `${result.task} 검사가 통과하지 않았습니다.`,
        });
      }
    } catch (error) {
      const message = boundedMessage(error);
      directEditActivityStore.failActivity(activity.activity_id, {
        paths: ['package.json'],
        summary: `${check.task} 검사 실패`,
      });
      return LocalApplyResultSchema.parse({
        state: 'failed',
        workspace_id: workspace.workspace_id,
        workspace_name: workspace.display_name,
        applied_steps: appliedSteps,
        changed_paths: unique(changedPaths),
        failed_step: bundle.operations.length + checkIndex,
        message,
      });
    }
  }

  for (const [gitIndex, gitCommand] of bundle.git.entries()) {
    const activity = directEditActivityStore.beginActivity({
      workspace_id: workspace.workspace_id,
      workspace_name: workspace.display_name,
      source: 'local_apply',
      tool: 'project.git',
      paths: ['.git'],
      summary: `git ${gitCommand.command} 실행 중`,
    });
    try {
      const result = await runWorkspaceGit(workspaceService, {
        workspace_id: bundle.workspace_id,
        workspace_binding: workspaceBinding,
        git: gitCommand,
        timeout_ms: 60_000,
      });
      const passed = result.exit_code === 0 && !result.timed_out;
      const step: LocalApplyStepResult = {
        tool: 'project.git',
        paths: ['.git'],
        summary: `git ${result.command} ${passed ? '완료' : '실패'}`,
        execution: executionEvidence(result),
      };
      appliedSteps.push(step);
      if (passed) {
        directEditActivityStore.completeActivity(activity.activity_id, step);
      } else {
        directEditActivityStore.failActivity(activity.activity_id, step);
        return LocalApplyResultSchema.parse({
          state: 'failed',
          workspace_id: workspace.workspace_id,
          workspace_name: workspace.display_name,
          applied_steps: appliedSteps,
          changed_paths: unique(changedPaths),
          failed_step: bundle.operations.length + bundle.checks.length + gitIndex,
          message: `git ${result.command} 명령이 실패했습니다.`,
        });
      }
    } catch (error) {
      const message = boundedMessage(error);
      directEditActivityStore.failActivity(activity.activity_id, {
        paths: ['.git'],
        summary: `git ${gitCommand.command} 실패`,
      });
      return LocalApplyResultSchema.parse({
        state: 'failed',
        workspace_id: workspace.workspace_id,
        workspace_name: workspace.display_name,
        applied_steps: appliedSteps,
        changed_paths: unique(changedPaths),
        failed_step: bundle.operations.length + bundle.checks.length + gitIndex,
        message,
      });
    }
  }

  return LocalApplyResultSchema.parse({
    state: 'succeeded',
    workspace_id: workspace.workspace_id,
    workspace_name: workspace.display_name,
    applied_steps: appliedSteps,
    changed_paths: unique(changedPaths),
    failed_step: null,
    message: `${bundle.operations.length}개 변경, ${bundle.checks.length}개 검증, ${bundle.git.length}개 git 명령을 처리했습니다.`,
  });
}

function executionEvidence(result: {
  exit_code: number | null;
  timed_out: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
  duration_ms: number;
}): NonNullable<LocalApplyStepResult['execution']> {
  return {
    exit_code: result.exit_code,
    timed_out: result.timed_out,
    stdout: result.stdout.slice(0, 16_384),
    stderr: result.stderr.slice(0, 16_384),
    truncated: result.truncated || result.stdout.length > 16_384 || result.stderr.length > 16_384,
    duration_ms: result.duration_ms,
  };
}

export function applyLocalBundle(
  workspaceService: WorkspaceService,
  activities: DirectEditActivityStore,
  binding: WorkspaceBinding,
  input: LocalApplyBundle,
): Promise<LocalApplyResult> {
  return workspaceService.withOperation(input.workspace_id, () =>
    applyLocalBundleUnlocked(workspaceService, activities, binding, input),
  );
}

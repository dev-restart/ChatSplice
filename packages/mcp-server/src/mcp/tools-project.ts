// Registers project.run, project.exec/await_exec/cancel_exec and fixed-shape project.git.
import { ChatSpliceError, runWorkspaceGit, runWorkspaceProjectTask } from '@chatsplice/core';
import {
  ProjectGitInputSchema,
  ProjectGitResultSchema,
  ProjectExecAwaitInputSchema,
  ProjectExecCancelInputSchema,
  ProjectExecInputSchema,
  ProjectExecJobSchema,
  ProjectExecSummarySchema,
  ProjectRunInputSchema,
  ProjectRunResultSchema,
} from '@chatsplice/protocol';

import { workspaceBindingMatches } from '../workspace-binding.js';
import { toolError } from './tool-error.js';
import type { McpToolContext } from './tool-context.js';

export function registerProjectTools(ctx: McpToolContext): void {
  const {
    server,
    workspaceService,
    bindingSecret,
    assertSourceBinding,
    assertMutationsAllowed,
    directEditActivityStore,
    executionService,
  } = ctx;

  server.registerTool(
    'project.run',
    {
      title: 'Run a Bounded Project Check',
      description:
        'Run exactly one existing root package.json script named test, lint, typecheck, check, or build for the explicitly bound user workspace. This is not a general shell: no command string, arguments, alternate cwd, Git, network, or arbitrary executable is accepted. On macOS it runs through sandbox-exec with network denied, environment secrets removed, writes confined to the workspace/private runtime, a hard timeout, and bounded stdout/stderr. A non-zero exit is returned as structured evidence so ChatGPT can inspect and repair with the direct MCP file tools.',
      inputSchema: ProjectRunInputSchema,
      outputSchema: ProjectRunResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      let activityId: string | undefined;
      try {
        assertMutationsAllowed();
        if (!workspaceBindingMatches(bindingSecret, input.workspace_id, input.workspace_binding)) {
          throw new ChatSpliceError(
            'WORKSPACE_BINDING_REQUIRED',
            'The workspace binding is missing or does not match workspace_id.',
          );
        }
        const workspace = workspaceService.getRecord(input.workspace_id);
        const activity = directEditActivityStore.beginActivity({
          workspace_id: workspace.workspace_id,
          workspace_name: workspace.display_name,
          tool: 'project.run',
          paths: ['package.json'],
          summary: `${input.task} 검사 실행 중`,
        });
        activityId = activity.activity_id;
        const output = await runWorkspaceProjectTask(workspaceService, input);
        const summary = `${output.task} ${output.exit_code === 0 && !output.timed_out ? '통과' : '실패'}`;
        if (output.exit_code === 0 && !output.timed_out) {
          directEditActivityStore.completeActivity(activity.activity_id, {
            paths: ['package.json'],
            summary,
          });
        } else {
          directEditActivityStore.failActivity(activity.activity_id, {
            paths: ['package.json'],
            summary,
          });
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        if (activityId !== undefined) {
          directEditActivityStore.failActivity(activityId, { summary: `${input.task} 검사 실패` });
        }
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'project.exec',
    {
      title: 'Start Model-free Project Execution',
      description:
        'Start one bounded model-free project operation for the explicitly bound user workspace. Use node_script for an existing package script, cargo for check/test/build/fmt/clippy, or install for the declared Node/Rust ecosystem. Install mode defaults to locked dependency restoration; mode resolve only regenerates the lockfile from the manifest, then requires a separate locked install. Node installation supports npm/pnpm with hooks disabled. This returns a job summary immediately; call project.await_exec with the same exact workspace binding until it reaches a terminal state. It never starts another model or agent session and accepts no shell string, absolute path, environment variable, or arbitrary executable.',
      inputSchema: ProjectExecInputSchema,
      outputSchema: ProjectExecSummarySchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        assertSourceBinding(input.workspace_id, input.workspace_binding);
        const output = executionService.submit(input);
        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'project.await_exec',
    {
      title: 'Wait for Project Execution',
      description:
        'Wait for one previously submitted project.exec job using the exact workspace binding. The bounded wait is at most 30 seconds and returns the current full job, including capped output logs, exit_code, timeout, and truncation evidence. It never starts or retries a job.',
      inputSchema: ProjectExecAwaitInputSchema,
      outputSchema: ProjectExecJobSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        assertSourceBinding(input.workspace_id, input.workspace_binding);
        const output = await executionService.awaitJob(input);
        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'project.cancel_exec',
    {
      title: 'Cancel Project Execution',
      description:
        'Request cancellation of one exact project.exec job for the explicitly bound workspace. Cancellation is allowed while ChatSplice read-only mode is enabled, and the job becomes cancelled only after queued reservation cleanup or the running process cleanup completes. It never starts a replacement job.',
      inputSchema: ProjectExecCancelInputSchema,
      outputSchema: ProjectExecJobSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        assertSourceBinding(input.workspace_id, input.workspace_binding);
        const output = executionService.cancel(input.workspace_id, input.job_id);
        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'project.git',
    {
      title: 'Run a Bounded Git Command',
      description:
        'Run one bounded git command for the explicitly bound user workspace: status, branch, log, diff, add, commit, push, pull, or fetch. This is not a shell and takes no command or argument string — each command is a fixed structured shape and the argv is assembled from validated refs and workspace-relative paths only. Local commands stay offline; push, pull, and fetch intentionally use the network and may use the current SSH agent or a trusted macOS Keychain credential helper. Other global Git config and credential helpers are not inherited. commit requires a message; add requires all=true or explicit paths. Inspect the structured exit_code and stdout/stderr, and never report a non-zero result as success. Use fs.* to change files first, then project.git to stage/commit/push.',
      inputSchema: ProjectGitInputSchema,
      outputSchema: ProjectGitResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      let activityId: string | undefined;
      try {
        assertMutationsAllowed();
        if (!workspaceBindingMatches(bindingSecret, input.workspace_id, input.workspace_binding)) {
          throw new ChatSpliceError(
            'WORKSPACE_BINDING_REQUIRED',
            'The workspace binding is missing or does not match workspace_id.',
          );
        }
        const workspace = workspaceService.getRecord(input.workspace_id);
        const activity = directEditActivityStore.beginActivity({
          workspace_id: workspace.workspace_id,
          workspace_name: workspace.display_name,
          tool: 'project.git',
          paths: ['.git'],
          summary: `git ${input.git.command} 실행 중`,
        });
        activityId = activity.activity_id;
        const output = await runWorkspaceGit(workspaceService, input);
        const passed = output.exit_code === 0 && !output.timed_out;
        const summary = `git ${output.command} ${passed ? '완료' : '실패'}`;
        if (passed) {
          directEditActivityStore.completeActivity(activity.activity_id, {
            paths: ['.git'],
            summary,
          });
        } else {
          directEditActivityStore.failActivity(activity.activity_id, {
            paths: ['.git'],
            summary,
          });
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        if (activityId !== undefined) {
          directEditActivityStore.failActivity(activityId, {
            summary: `git ${input.git.command} 실패`,
          });
        }
        return toolError(error);
      }
    },
  );
}

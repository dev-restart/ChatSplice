// Registers project.run, project.exec/await_exec/cancel_exec and fixed-shape project.git.
import { ChatSpliceError, runWorkspaceGit, runWorkspaceProjectTask } from '@chatsplice/core';
import {
  EXECUTION_CONTRACT_VERSION,
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
        'Run exactly one existing root package.json script named test, lint, typecheck, check, or build for the explicitly bound user workspace. This accepts no arbitrary command, arguments, alternate cwd, Git or network option. On macOS it uses sandbox-exec with external network denied, local loopback and project/job Unix sockets permitted, environment secrets removed, writes confined to the workspace/private runtime and project dependency cache, a hard timeout, and bounded stdout/stderr. Command profiles support sandbox-owned PTYs and descriptor access to permitted roots; temporary link fixtures use the private TMPDIR. A non-zero exit is returned as structured evidence for repair with the direct MCP file tools.',
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
          content: [{ type: 'text', text: JSON.stringify(output) }],
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
      description: `Execution contract ${EXECUTION_CONTRACT_VERSION}. Start model-free local development work for the exactly bound workspace. fs.reference_list discovers folders the owner has linked, their paths and read/write modes. Optional reference_workspace_id chooses an approved additional folder as cwd root; keep the original source workspace_id/binding. Commands require read_write on that target. Command sandboxes also include the main project and all currently linked folders with their actual read/write modes, revalidated and reserved together. A read-only folder never becomes writable merely because it is linked. Folder targets do not apply to browser/readiness or main-project criterion verification. Use environment to inspect fixed manifest/lockfile entries, package manager/scripts, executable presence and the managed Chromium cache at relative cwd. It installs nothing, runs no project scripts or version commands, and returns environment_result through await_exec; a found executable/cache does not prove versions, permissions or launch success. Inspect required actions explicitly before install. Use shell with command for Node.js, Python/uv/pip, Rust, Go, Elixir/Mix and shell development, dependency installation and project runtime configuration; HTML/CSS use the project server and browser. Registered Node scripts, Cargo checks and root checks share installed child-runtime read paths and private dependency caches with shell. Structured checks can read Git repository metadata. Their selected Node/Rust tools remain pinned while project .venv Python commands take precedence over a global Python. Environment inspection includes Go/Elixir manifests and executables; presence does not prove a working runtime. Shell network defaults to enabled; network local permits loopback and Unix sockets beneath the project/private job runtime. Shell writes stay within the canonical project, owner-approved writable folders, private runtime and project dependency cache; host credentials and ChatGPT sessions are not inherited. Optional stdin supplies finite non-interactive input. Set background:true on shell or node_script for a dev server: it keeps running while files and checks proceed, uses a separate twelve-process pool, and is stopped by cancel_exec, timeout or app shutdown. Use node_script for declared scripts, cargo for checks, or install for locked/resolve Node/Rust dependencies. If the managed Cargo cache has missing or corrupt package files, explicitly request install with ecosystem:rust, mode:locked and repair_cache:true. This fetches the existing lockfile into a fresh dependency cache and selects it only after successful completion; failed, timed-out or cancelled fetches preserve the prior selection. It retains installed development tools and existing cache generations used by running jobs. Await the repair result before rerunning checks; normal install does not automatically repair a damaged extraction. Cargo checks keep dependency downloads offline while permitting local loopback listeners and requests. Final command execution supports sandbox-owned PTYs, descriptor traversal to permitted roots, and hardlinks from the private runtime; use TMPDIR for temporary fixtures. Bind preview servers explicitly to 127.0.0.1 or ::1. Capability errors are separate from failing assertions or model refusal. On macOS a setuid /bin/ps can be denied at spawn even for its own PID; adding a path read permission does not fix that restriction. Process-ownership code should use the native libproc PID/UID/parent/start-time API and verify the actual owned child. Optional ps failure need not stop unrelated work, but an unavailable required check is not a pass. Use browser with action setup to install managed Chromium, open with a loopback HTTP(S) URL and optional width/height, then snapshot, click/fill/press with an exact selector, scroll or close. Use assert with expectation kind visible/hidden/text/value/url and optional timeout_ms (100-10000) to verify outcomes; text uses contains unless exact:true. Failed actions/assertions return exit_code:1 with page evidence when capture is possible. Startup failures distinguish missing browser, denied environment, timeout and other launch failures; do not reinstall for every error. After a closed or crashed preview, open can recreate its isolated session. Tool refresh does not restart an older app/daemon. Browser jobs return page text, labeled controls, HTTP/console errors and a screenshot through await_exec, using up to twelve isolated project sessions. The desktop permits eight foreground jobs and 64 queued/running jobs; request IDs are scoped to each workspace. This returns a job_id immediately. Await foreground work until terminal; poll background jobs with timeout_ms:0 and use readiness with a loopback URL and expected_status (200-299) before testing. Readiness uses HEAD, no redirects or response body, with attempts (1-10), interval_ms (100-5000) and request_timeout_ms (100-10000). It returns readiness_result through await_exec and observes the whole execution timeout/cancellation. A ready endpoint does not prove process ownership; do not automatically retry shell, install, mutation or Git. Never infer success from submission. No secondary model is invoked.`,
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
          content: [{ type: 'text', text: JSON.stringify(output) }],
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
        const screenshot = executionService.getScreenshot(input.workspace_id, input.job_id);
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(output) },
            ...(screenshot === undefined ? [] : [screenshot]),
          ],
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
          content: [{ type: 'text', text: JSON.stringify(output) }],
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
          content: [{ type: 'text', text: JSON.stringify(output) }],
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

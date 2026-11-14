import { describe, expect, it } from 'vitest';
import { ProjectExecInputSchema } from '@chatsplice/protocol';

import { ProjectExecutionService } from './service.js';

const workspaceId = 'ws_0123456789abcdef01234567';
const binding = `wb_${'a'.repeat(64)}`;

// Exercise the real job store with a deterministic backend; no real browser.
describe('failed browser job evidence retention', () => {
  it.each([false, true])('retains failed evidence only without timeout: %s', async (timedOut) => {
    const operation = async (_ids: readonly string[], run: () => Promise<unknown>) => run();
    const workspace = {
      getRecord: () => ({
        workspace_id: workspaceId,
        kind: 'user',
        display_name: 'Fixture',
        rootPath: '/fixture',
      }),
      withOperations: operation,
      withConcurrentOperations: operation,
    };
    const service = new ProjectExecutionService(workspace as never, {
      backend: async () => ({
        exit_code: 1,
        duration_ms: 5,
        timed_out: timedOut,
        browser_result: {
          url: 'http://127.0.0.1:5173/',
          title: 'Fixture',
          text: 'Save failed',
          controls: [],
          console: [],
          width: 1280,
          height: 800,
          screenshot_available: true,
        },
        image: { data: Buffer.from('fixture-image'), mimeType: 'image/jpeg' },
      }),
    });
    try {
      const job = service.submit(
        ProjectExecInputSchema.parse({
          workspace_id: workspaceId,
          workspace_binding: binding,
          request_id: 'failure-evidence-test',
          operation: { kind: 'browser', action: { kind: 'snapshot' } },
        }),
      );
      const result = await service.awaitJob({
        workspace_id: workspaceId,
        workspace_binding: binding,
        job_id: job.job_id,
        timeout_ms: 1000,
      });
      expect(result.state).toBe(timedOut ? 'timed_out' : 'failed');
      expect(result.exit_code).toBe(1);
      if (timedOut) {
        expect(result.browser_result).toBeUndefined();
        expect(service.getScreenshot(workspaceId, job.job_id)).toBeUndefined();
      } else {
        expect(result.browser_result?.text).toBe('Save failed');
        expect(result.browser_result?.screenshot_available).toBe(true);
        expect(service.getScreenshot(workspaceId, job.job_id)?.type).toBe('image');
        expect(() => service.getScreenshot('ws_aaaaaaaaaaaaaaaaaaaaaaaa', job.job_id)).toThrow();
      }
    } finally {
      await service.shutdown();
    }
  });
});

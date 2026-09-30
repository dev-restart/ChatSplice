import { describe, expect, it } from 'vitest';

import { DirectEditActivityStore } from './direct-edit-activity-store.js';

describe('DirectEditActivityStore', () => {
  it('publishes a running MCP activity before completing it', () => {
    const store = new DirectEditActivityStore();
    const running = store.beginActivity({
      workspace_id: 'ws_0123456789abcdef01234567',
      workspace_name: 'Fixture',
      tool: 'fs.edit',
      paths: ['README.md'],
      summary: '파일 수정 처리 중',
    });

    expect(running).toMatchObject({
      workspace_id: 'ws_0123456789abcdef01234567',
      tool: 'fs.edit',
      paths: ['README.md'],
      state: 'running',
      completed_at: null,
    });
    expect(store.listActivities()[0]).toMatchObject({
      activity_id: running.activity_id,
      state: 'running',
    });

    const completed = store.completeActivity(running.activity_id, {
      paths: ['README.md'],
      summary: '1회 exact replacement',
    });

    expect(completed).toMatchObject({
      activity_id: running.activity_id,
      state: 'succeeded',
      summary: '1회 exact replacement',
    });
    expect(completed?.completed_at).not.toBeNull();
    expect(store.listActivities()[0]).toMatchObject({
      activity_id: running.activity_id,
      state: 'succeeded',
    });
  });

  it('publishes a failed terminal state for a direct MCP error', () => {
    const store = new DirectEditActivityStore();
    const running = store.beginActivity({
      workspace_id: 'ws_0123456789abcdef01234567',
      workspace_name: 'Fixture',
      tool: 'fs.write',
      paths: ['src/index.ts'],
      summary: '파일 생성 처리 중',
    });

    const failed = store.failActivity(running.activity_id, {
      summary: '파일 쓰기 실패',
    });

    expect(failed).toMatchObject({
      activity_id: running.activity_id,
      state: 'failed',
      summary: '파일 쓰기 실패',
    });
    expect(failed?.completed_at).not.toBeNull();
    expect(store.listActivities()[0]).toMatchObject({ state: 'failed' });
  });

  it('keeps a bounded recent activity flow for one workspace', () => {
    const store = new DirectEditActivityStore();
    for (let index = 0; index < 104; index += 1) {
      store.recordActivity({
        workspace_id: 'ws_0123456789abcdef01234567',
        workspace_name: 'Fixture',
        tool: 'fs.read',
        paths: [`src/${index}.ts`],
        summary: '파일 읽음',
      });
    }

    const activities = store.listActivities();
    expect(activities).toHaveLength(100);
    expect(activities[0]).toMatchObject({ paths: ['src/103.ts'], state: 'succeeded' });
    expect(activities.at(-1)).toMatchObject({ paths: ['src/4.ts'], state: 'succeeded' });
  });
});

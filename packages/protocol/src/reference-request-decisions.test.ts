import { describe, expect, it } from 'vitest';

import { ReferenceRequestDecisionInputSchema } from './schemas.js';

const REQUEST_ID = `refreq_${'1'.repeat(24)}`;

describe('owner folder decision input', () => {
  it.each(['read_only', 'read_write'] as const)(
    'accepts the owner-selected %s mode on approval',
    (accessMode) => {
      expect(
        ReferenceRequestDecisionInputSchema.parse({
          request_id: REQUEST_ID,
          approved: true,
          access_mode: accessMode,
        }),
      ).toEqual({ request_id: REQUEST_ID, approved: true, access_mode: accessMode });
    },
  );

  it('keeps omitted permission absent for older owner clients', () => {
    expect(
      ReferenceRequestDecisionInputSchema.parse({ request_id: REQUEST_ID, approved: true }),
    ).toEqual({ request_id: REQUEST_ID, approved: true });
  });

  it('accepts denial without introducing a permission', () => {
    expect(
      ReferenceRequestDecisionInputSchema.parse({ request_id: REQUEST_ID, approved: false }),
    ).toEqual({ request_id: REQUEST_ID, approved: false });
  });

  it.each(['read_only', 'read_write'] as const)(
    'rejects a denied decision carrying %s',
    (accessMode) => {
      expect(
        ReferenceRequestDecisionInputSchema.safeParse({
          request_id: REQUEST_ID,
          approved: false,
          access_mode: accessMode,
        }).success,
      ).toBe(false);
    },
  );

  it('rejects attempts to change the request scope or supply an unsupported mode', () => {
    for (const extra of [
      { path: '/different-folder' },
      { workspace_id: `ws_${'2'.repeat(24)}` },
      { access_mode: 'full_access' },
    ]) {
      expect(
        ReferenceRequestDecisionInputSchema.safeParse({
          request_id: REQUEST_ID,
          approved: true,
          ...extra,
        }).success,
      ).toBe(false);
    }
  });
});

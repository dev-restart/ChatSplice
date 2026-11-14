import * as z from 'zod/v4';

/** Only the literal loopback authorities are accepted, without URL credentials. */
export function isLocalReadinessUrl(value: string): boolean {
  if (!/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?(?:[/?]|$)/.test(value)) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      url.username === '' &&
      url.password === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

export const ProjectReadinessOperationSchema = z
  .object({
    kind: z.literal('readiness'),
    url: z
      .string()
      .min(1)
      .max(4096)
      .refine(isLocalReadinessUrl, 'Readiness URLs must use literal loopback HTTP(S).'),
    expected_status: z.number().int().min(200).max(299).default(200),
    attempts: z.number().int().min(1).max(10).default(1),
    interval_ms: z.number().int().min(100).max(5000).default(500),
    request_timeout_ms: z.number().int().min(100).max(10_000).default(1000),
  })
  .strict();
export type ProjectReadinessOperation = z.infer<typeof ProjectReadinessOperationSchema>;

export const ProjectReadinessFailureSchema = z.enum([
  'unexpected_status',
  'connection_error',
  'request_timeout',
]);
export type ProjectReadinessFailure = z.infer<typeof ProjectReadinessFailureSchema>;

export const ProjectReadinessAttemptSchema = z
  .object({
    attempt: z.number().int().min(1).max(10),
    status_code: z.number().int().min(100).max(599).nullable(),
    duration_ms: z.number().int().nonnegative(),
    failure: ProjectReadinessFailureSchema.nullable(),
  })
  .strict();
export type ProjectReadinessAttempt = z.infer<typeof ProjectReadinessAttemptSchema>;

export const ProjectReadinessResultSchema = z
  .object({
    url: z.string().max(4096).refine(isLocalReadinessUrl),
    method: z.literal('HEAD'),
    expected_status: z.number().int().min(200).max(299),
    ready: z.boolean(),
    attempts_used: z.number().int().min(1).max(10),
    status_code: z.number().int().min(100).max(599).nullable(),
    duration_ms: z.number().int().nonnegative(),
    failure: ProjectReadinessFailureSchema.nullable(),
    attempts: z.array(ProjectReadinessAttemptSchema).min(1).max(10),
  })
  .strict();
export type ProjectReadinessResult = z.infer<typeof ProjectReadinessResultSchema>;

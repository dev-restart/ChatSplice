import * as z from 'zod/v4';

export const ProjectEnvironmentOperationSchema = z
  .object({ kind: z.literal('environment') })
  .strict();
export const EnvironmentEntryStateSchema = z.enum([
  'present',
  'missing',
  'unreadable',
  'invalid',
  'too_large',
]);
export const ProjectEnvironmentResultSchema = z
  .object({
    cwd: z.string().min(1).max(4096),
    inspected_at: z.string(),
    files: z
      .array(
        z
          .object({
            path: z.string().max(4096),
            state: EnvironmentEntryStateSchema,
          })
          .strict(),
      )
      .max(19),
    node: z
      .object({
        package_manager: z.enum(['pnpm', 'npm', 'yarn', 'bun']).nullable(),
        selection: z.enum(['declared', 'lockfile', 'default', 'not_applicable']),
        lockfile_path: z.string().max(4096).nullable(),
        scripts: z.array(z.string().max(80)).max(32),
        scripts_truncated: z.boolean(),
      })
      .strict(),
    tools: z
      .array(
        z
          .object({
            name: z.enum([
              'node',
              'npm',
              'pnpm',
              'yarn',
              'bun',
              'cargo',
              'rustc',
              'python3',
              'uv',
              'python',
              'pip3',
              'go',
              'elixir',
              'erl',
              'mix',
              'sh',
              'bash',
            ]),
            state: z.enum(['found', 'missing', 'unreadable']),
          })
          .strict(),
      )
      .max(17),
    path_scan_truncated: z.boolean(),
    browser: z
      .object({
        state: z.enum(['cache_present', 'missing', 'unreadable', 'not_checked']),
        launch_verified: z.literal(false),
      })
      .strict(),
    issues: z
      .array(
        z.enum([
          'manifest_invalid',
          'lockfile_missing',
          'package_manager_missing',
          'runtime_missing',
          'browser_missing',
          'browser_unreadable',
        ]),
      )
      .max(8),
  })
  .strict();
export type ProjectEnvironmentResult = z.infer<typeof ProjectEnvironmentResultSchema>;

import * as z from 'zod/v4';

export function isLocalPreviewUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

const Selector = z.string().min(1).max(1000);
export const ProjectBrowserExpectationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('visible'), selector: Selector }).strict(),
  z.object({ kind: z.literal('hidden'), selector: Selector }).strict(),
  z
    .object({
      kind: z.literal('text'),
      selector: Selector,
      text: z.string().max(4000),
      exact: z.boolean().optional(),
    })
    .strict(),
  z.object({ kind: z.literal('value'), selector: Selector, value: z.string().max(4000) }).strict(),
  z
    .object({
      kind: z.literal('url'),
      url: z.string().max(4096).refine(isLocalPreviewUrl, 'Expected URL must remain local.'),
    })
    .strict(),
]);
export type ProjectBrowserExpectation = z.infer<typeof ProjectBrowserExpectationSchema>;

export const ProjectBrowserActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('setup') }).strict(),
  z
    .object({
      kind: z.literal('open'),
      url: z
        .string()
        .max(4096)
        .refine(isLocalPreviewUrl, 'Preview URLs must use loopback HTTP(S).'),
      width: z.number().int().min(320).max(1920).optional(),
      height: z.number().int().min(200).max(1440).optional(),
    })
    .strict(),
  z.object({ kind: z.literal('snapshot') }).strict(),
  z
    .object({
      kind: z.literal('assert'),
      expectation: ProjectBrowserExpectationSchema,
      timeout_ms: z.number().int().min(100).max(10000).optional(),
    })
    .strict(),
  z.object({ kind: z.literal('click'), selector: Selector }).strict(),
  z.object({ kind: z.literal('fill'), selector: Selector, value: z.string().max(16_384) }).strict(),
  z
    .object({ kind: z.literal('press'), selector: Selector, key: z.string().min(1).max(100) })
    .strict(),
  z
    .object({
      kind: z.literal('scroll'),
      x: z.number().int().min(-10000).max(10000),
      y: z.number().int().min(-10000).max(10000),
    })
    .strict(),
  z.object({ kind: z.literal('close') }).strict(),
]);
export type ProjectBrowserAction = z.infer<typeof ProjectBrowserActionSchema>;

export const ProjectBrowserSnapshotSchema = z
  .object({
    url: z.string().max(4096),
    title: z.string().max(1000),
    text: z.string().max(24_000),
    controls: z
      .array(
        z
          .object({
            selector: z.string().max(1000),
            tag: z.string().max(30),
            text: z.string().max(300),
          })
          .strict(),
      )
      .max(100),
    console: z.array(z.string().max(1000)).max(100),
    screenshot_available: z.boolean(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();
export type ProjectBrowserSnapshot = z.infer<typeof ProjectBrowserSnapshotSchema>;

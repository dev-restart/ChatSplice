import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LOCAL_NETWORK_SANDBOX_PROFILE } from './development-sandbox.js';
import { safeEnvironment } from './pi-sandbox.js';

// Pure configuration guards; real sandbox execution is tested separately.
describe('model-free execution environment', () => {
  it('keeps zsh heredoc temporary files in the same private runtime as TMPDIR', () => {
    const runtime = '/private/tmp/fixture-runtime';
    const env = safeEnvironment(
      runtime,
      { path: '/bin/zsh', root: '/bin' },
      undefined,
      undefined,
      '/private/tmp/cargo-fixture',
      '/private/tmp/corepack-fixture',
      false,
      false,
    );
    expect(env.TMPDIR).toBe(runtime);
    expect(env.TMPPREFIX).toBe(join(runtime, 'zsh'));
    expect(env.HOME).toBe(runtime);
    expect(env.COREPACK_ENABLE_NETWORK).toBe('0');
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('uses shared Corepack resolution and a private manager shim for root checks', () => {
    const source = readFileSync(new URL('./run-task.ts', import.meta.url), 'utf8');
    expect(source).toContain('const corepackCache = await resolveCorepackCache();');
    expect(source).not.toContain("join(userHome, '.cache', 'node', 'corepack', 'v1')");
    expect(source).toContain('await preparePackageManagerShim(');
    expect(source).toContain("await resolveTrustedPathFromPath('node', canonicalRoot)");
    expect(source).toContain('join(shimDirectory, manager),');
    expect(source).toContain('LOCAL_NETWORK_SANDBOX_PROFILE,');
    expect(LOCAL_NETWORK_SANDBOX_PROFILE.startsWith('(deny network*)')).toBe(true);
    expect(source).toContain('WORKSPACE_ENV=');
    expect(source).toContain('await rm(runtimeDirectory, { recursive: true, force: true });');
  });
});

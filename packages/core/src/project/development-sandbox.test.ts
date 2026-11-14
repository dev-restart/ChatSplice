import { describe, expect, it } from 'vitest';

import {
  ancestorDirectoryReadProfile,
  developmentSandboxProfile,
  developmentToolReadRoots,
  structuredGitReadOnlyProfile,
  LOCAL_NETWORK_SANDBOX_PROFILE,
} from './development-sandbox.js';
import { additionalFolderSandboxPolicy, safeEnvironment, sandboxProfile } from './pi-sandbox.js';
import { shellSandboxProfile } from './shell-sandbox.js';

describe('development command capabilities', () => {
  it('allows exact ancestor directories for workspace and private temporary paths', () => {
    const profile = ancestorDirectoryReadProfile([
      '/Users/developer/project',
      '/private/var/folders/fixture/T/job',
      '/private/var/folders/fixture/T/cargo-cache',
    ]);
    for (const directory of [
      '/',
      '/Users',
      '/Users/developer',
      '/private',
      '/private/var',
      '/private/var/folders',
      '/private/var/folders/fixture',
      '/private/var/folders/fixture/T',
    ]) {
      expect(profile.split(`(literal ${JSON.stringify(directory)})`)).toHaveLength(2);
    }
    expect(profile).toContain('(vnode-type DIRECTORY)');
    expect(profile).not.toContain('subpath');
    expect(profile).not.toContain('file-map-executable');
    expect(profile).not.toContain('file-write');
  });

  it('escapes unusual directory labels and emits no rules for an empty root set', () => {
    expect(ancestorDirectoryReadProfile([])).toBe('');
    expect(ancestorDirectoryReadProfile(['/Users/a"b/project'])).toContain(
      '(literal "/Users/a\\"b")',
    );
  });

  it.each(['relative/project', '/private/invalid\npath', `/${'x'.repeat(4096)}`])(
    'rejects an invalid ancestor root %j before constructing an execution profile',
    (root) => {
      expect(() => ancestorDirectoryReadProfile([root])).toThrow('absolute');
    },
  );

  it('bounds accumulated ancestor rules instead of submitting an oversized profile', () => {
    const roots = Array.from({ length: 100 }, (_, index) => `/${index}/${'x'.repeat(1000)}/job`);
    expect(() => ancestorDirectoryReadProfile(roots)).toThrow('exceed the limit');
  });

  it('places command capabilities before protected-path denials for both command profiles', () => {
    for (const base of [sandboxProfile(false, true), shellSandboxProfile(false)]) {
      const profile = developmentSandboxProfile(base, ['/workspace', '/private/tmp/job']);
      const protectedPaths = profile.indexOf(
        '(deny file-read-data file-map-executable file-write*',
      );
      const hostsRead = profile.indexOf('(allow file-read-data (literal "/private/etc/hosts"))');
      expect(hostsRead).toBeGreaterThan(
        profile.indexOf('(deny file-read-data file-map-executable)'),
      );
      expect(hostsRead).toBeLessThan(protectedPaths);
      expect(profile.indexOf('(allow pseudo-tty)')).toBeLessThan(protectedPaths);
      expect(profile.indexOf('(vnode-type DIRECTORY)')).toBeLessThan(protectedPaths);
      expect(profile).toContain('(extension "com.apple.sandbox.pty")');
      expect(profile).toContain('(regex #"^/dev/ttys[0-9]+$")');
      expect(profile).toContain('(deny file-link)');
      expect(profile).toContain('(allow file-link (subpath (param "RUNTIME")))');
      expect(profile.match(/\(allow file-link/gu)).toHaveLength(1);
      expect(profile).toContain('(subpath (param "USER_SSH"))');
      expect(profile).toContain(LOCAL_NETWORK_SANDBOX_PROFILE);
      expect(profile).not.toContain('(allow network*)');
      expect(profile).not.toContain('mDNSResponder');
      expect(profile).not.toContain('resolv.conf');
    }
  });

  it('scopes local Unix IPC to the project and private runtime', () => {
    for (const root of ['WORKSPACE', 'RUNTIME']) {
      expect(LOCAL_NETWORK_SANDBOX_PROFILE).toContain(
        `(allow network-bind (local unix-socket (subpath (param "${root}"))))`,
      );
      expect(LOCAL_NETWORK_SANDBOX_PROFILE).toContain(
        `(allow network-outbound (remote unix-socket (subpath (param "${root}"))))`,
      );
    }
    expect(LOCAL_NETWORK_SANDBOX_PROFILE).not.toContain('(local unix-socket))');
    expect(LOCAL_NETWORK_SANDBOX_PROFILE).not.toContain('(remote unix-socket))');
    expect(LOCAL_NETWORK_SANDBOX_PROFILE).not.toContain('USER_SSH');
    expect(LOCAL_NETWORK_SANDBOX_PROFILE).not.toContain('USER_CHATSPLICE');
    expect(sandboxProfile(false, false)).not.toContain('unix-socket');
  });

  it('shares installed Python/Node/Rust/Go/Elixir runtime reads without granting runtime writes', () => {
    for (const base of [sandboxProfile(false, true), shellSandboxProfile(false)]) {
      const profile = developmentSandboxProfile(base, ['/workspace', '/private/tmp/job']);
      const boundary = profile.indexOf('(deny file-read-data file-map-executable file-write*');
      for (const root of developmentToolReadRoots()) {
        const readRule = `(subpath ${JSON.stringify(root)})`;
        expect(profile.lastIndexOf(readRule)).toBeGreaterThan(
          profile.indexOf('(deny file-read-data file-map-executable)'),
        );
        expect(profile.lastIndexOf(readRule)).toBeLessThan(boundary);
      }
      expect(profile).not.toContain('(allow file-write* (subpath "/opt/homebrew"))');
      expect(profile).not.toContain('(allow file-write* (subpath "/usr/local"))');
    }
  });

  it('keeps every repository and additional-folder protection after overlapping read/write grants', () => {
    const folders = [
      { rootPath: '/Users/developer/sdk/project/nested', accessMode: 'read_write' as const },
      { rootPath: '/Users/developer/sdk', accessMode: 'read_write' as const },
    ];
    const { profile: base } = additionalFolderSandboxPolicy(
      sandboxProfile(false, true),
      folders,
      false,
    );
    const profile = developmentSandboxProfile(base, ['/Users/developer/sdk/project']);
    const lastReadGrant = profile.lastIndexOf('(allow file-read-data file-map-executable');
    const lastWriteGrant = profile.lastIndexOf('(allow file-write*');
    for (const parameter of ['WORKSPACE', 'FOLDER_0', 'FOLDER_1']) {
      const guard = profile.indexOf(structuredGitReadOnlyProfile(parameter));
      expect(guard).toBeGreaterThan(lastReadGrant);
      expect(guard).toBeGreaterThan(lastWriteGrant);
    }
    for (const parameter of ['FOLDER_0', 'FOLDER_1']) {
      const protectedFolder = `(regex (string-append "^" (regex-quote (param "${parameter}")) #"/([^/]+/)*([.][sS][sS][hH]`;
      expect(profile.indexOf(protectedFolder)).toBeGreaterThan(lastWriteGrant);
    }
    expect(profile).not.toContain('(subpath (param "WORKSPACE_GIT"))');
  });

  it('refuses a base profile that has no protected-path boundary', () => {
    expect(() => developmentSandboxProfile('(version 1)\n(allow default)', ['/workspace'])).toThrow(
      'incomplete',
    );
  });

  it('keeps metadata and rustup inspection profiles free of command-only capabilities', () => {
    const profile = sandboxProfile(false, false);
    expect(profile).toContain('(deny file-link)');
    expect(profile).toContain('(deny network*)');
    expect(profile).not.toContain('(allow file-link');
    expect(profile).not.toContain('(allow pseudo-tty)');
    expect(profile).not.toContain('com.apple.sandbox.pty');
    expect(profile).not.toContain('(allow network-');
    expect(profile).not.toContain('/private/etc/hosts');
  });

  it('points all conventional temporary-directory variables at the private runtime', () => {
    const runtime = '/private/tmp/job';
    const environment = safeEnvironment(
      runtime,
      { path: '/toolchain/bin/cargo', root: '/toolchain' },
      undefined,
      undefined,
      '/private/tmp/cargo-cache',
      '/private/tmp/corepack-cache',
      true,
      false,
    );
    expect(environment.TMPDIR).toBe(runtime);
    expect(environment.TMP).toBe(runtime);
    expect(environment.TEMP).toBe(runtime);
    expect(environment.HOME).toBe(runtime);
    expect(environment.CARGO_NET_OFFLINE).toBe('true');
  });
});

import { join } from 'node:path';

import type { ProjectExecInput } from '@chatsplice/protocol';

import {
  fileIsRegular,
  hasCargoLockfile,
  hasLockfile,
  readManifest,
  rejectCargoConfiguration,
  rejectPnpmRuntimeConfiguration,
  resolvePackageManager,
  resolveTrustedCargo,
  resolveTrustedPathFromPath,
  badRequest,
  MAX_MANIFEST_BYTES,
} from './pi-trusted.js';
import { preparePackageManagerShim } from './pi-sandbox.js';
import type { PreparedOperation } from './pi-types.js';

export async function prepareOperation(
  input: ProjectExecInput,
  canonicalRoot: string,
  cwd: string,
  runtimeDirectory: string,
  cargoHome: string,
  corepackCache: string,
): Promise<PreparedOperation> {
  const operation = input.operation;
  if (
    operation.kind === 'cargo' ||
    (operation.kind === 'install' && operation.ecosystem === 'rust')
  ) {
    await rejectCargoConfiguration(cwd, canonicalRoot);
  }
  if (operation.kind === 'node_script') {
    const manifest = await readManifest(join(cwd, 'package.json'));
    if (typeof manifest.scripts?.[operation.script] !== 'string') {
      badRequest(`package.json does not define the requested ${operation.script} script.`);
    }
    const manager = await resolvePackageManager(cwd, canonicalRoot, manifest.packageManager);
    const executable = await resolveTrustedPathFromPath(manager, canonicalRoot);
    const nodeRuntime = await resolveTrustedPathFromPath('node', canonicalRoot);
    const shimDirectory = await preparePackageManagerShim(
      runtimeDirectory,
      manager,
      executable,
      nodeRuntime,
    );
    return {
      command: `${manager} run ${operation.script}`,
      args: ['run', operation.script],
      usedNetwork: false,
      executable,
      nodeRuntime,
      shimDirectory,
      workspaceRoot: canonicalRoot,
      cargoHome,
      corepackCache,
      runtimeDirectory,
    };
  }
  if (operation.kind === 'install') {
    if (operation.ecosystem === 'node') {
      const manifest = await readManifest(join(cwd, 'package.json'));
      const manager = await resolvePackageManager(cwd, canonicalRoot, manifest.packageManager);
      if (manager !== 'npm' && manager !== 'pnpm') {
        badRequest('Node install supports only npm and pnpm lockfiles.');
      }
      if (manager === 'pnpm') {
        await rejectPnpmRuntimeConfiguration(cwd, canonicalRoot, manifest);
      }
      if (!(await hasLockfile(cwd, canonicalRoot, manager))) {
        if ((operation.mode ?? 'locked') === 'locked') {
          badRequest(`Node install requires an existing ${manager} lockfile.`);
        }
      }
      const executable = await resolveTrustedPathFromPath(manager, canonicalRoot);
      const nodeRuntime = await resolveTrustedPathFromPath('node', canonicalRoot);
      const shimDirectory = await preparePackageManagerShim(
        runtimeDirectory,
        manager,
        executable,
        nodeRuntime,
      );
      const command =
        operation.mode === 'resolve'
          ? manager === 'npm'
            ? 'npm install --package-lock-only --ignore-scripts'
            : 'pnpm install --lockfile-only --ignore-scripts --ignore-pnpmfile --manage-package-manager-versions=false'
          : manager === 'npm'
            ? 'npm ci --ignore-scripts'
            : 'pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile --manage-package-manager-versions=false';
      return {
        command,
        args:
          operation.mode === 'resolve'
            ? manager === 'npm'
              ? ['install', '--package-lock-only', '--ignore-scripts']
              : [
                  'install',
                  '--lockfile-only',
                  '--ignore-scripts',
                  '--ignore-pnpmfile',
                  '--manage-package-manager-versions=false',
                ]
            : manager === 'npm'
              ? ['ci', '--ignore-scripts']
              : [
                  'install',
                  '--frozen-lockfile',
                  '--ignore-scripts',
                  '--ignore-pnpmfile',
                  '--manage-package-manager-versions=false',
                ],
        usedNetwork: true,
        executable,
        nodeRuntime,
        shimDirectory,
        workspaceRoot: canonicalRoot,
        cargoHome,
        corepackCache,
        runtimeDirectory,
      };
    }
    await fileIsRegular(join(cwd, 'Cargo.toml'), 'Cargo.toml', MAX_MANIFEST_BYTES);
    const executable = await resolveTrustedCargo(canonicalRoot);
    const hasLock = await hasCargoLockfile(cwd, canonicalRoot);
    if (operation.mode !== 'resolve' && !hasLock) {
      badRequest('Rust install requires an existing Cargo.lock file.');
    }
    return {
      command: operation.mode === 'resolve' ? 'cargo generate-lockfile' : 'cargo fetch --locked',
      args: operation.mode === 'resolve' ? ['generate-lockfile'] : ['fetch', '--locked'],
      usedNetwork: true,
      executable,
      workspaceRoot: canonicalRoot,
      cargoHome,
      corepackCache,
      runtimeDirectory,
    };
  }
  await fileIsRegular(join(cwd, 'Cargo.toml'), 'Cargo.toml', MAX_MANIFEST_BYTES);
  const executable = await resolveTrustedCargo(canonicalRoot);
  const cargoLock = await hasCargoLockfile(cwd, canonicalRoot);
  const lockedSuffix = cargoLock ? ' --locked' : '';
  const command =
    operation.task === 'fmt'
      ? 'cargo fmt --all -- --check'
      : `cargo ${operation.task} --offline${lockedSuffix}`;
  return {
    command,
    args:
      operation.task === 'fmt'
        ? ['fmt', '--all', '--', '--check']
        : [operation.task, '--offline', ...(cargoLock ? ['--locked'] : [])],
    usedNetwork: false,
    executable,
    workspaceRoot: canonicalRoot,
    cargoHome,
    corepackCache,
    runtimeDirectory,
  };
}

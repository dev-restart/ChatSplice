import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const validationRoot = join(repositoryRoot, 'node_modules/.cache/chatsplice-folders-check');
const aliases = {
  '@chatsplice/protocol': join(repositoryRoot, 'packages/protocol/src/index.ts'),
  '@chatsplice/core': join(repositoryRoot, 'packages/core/src/index.ts'),
};
const projects = {
  protocol: 'packages/protocol',
  core: 'packages/core',
  mcp: 'packages/mcp-server',
  desktop: 'apps/desktop',
};
await mkdir(validationRoot, { recursive: true });

function run(args, cwd = repositoryRoot) {
  const result = spawnSync('pnpm', args, { cwd, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

async function configuration(name, original, emit = false) {
  const project = projects[name];
  const configPath = join(validationRoot, `${name}-${emit ? 'build' : 'check'}.json`);
  const typeRoots = [
    join(repositoryRoot, project, 'node_modules/@types'),
    join(repositoryRoot, 'node_modules/@types'),
    join(repositoryRoot, project, 'node_modules'),
    join(repositoryRoot, 'node_modules'),
  ];
  await writeFile(
    configPath,
    JSON.stringify(
      {
        extends: join(repositoryRoot, project, original),
        compilerOptions: {
          rootDir: repositoryRoot,
          paths: Object.fromEntries(Object.entries(aliases).map(([key, path]) => [key, [path]])),
          typeRoots,
          ...(emit ? { outDir: join(validationRoot, 'compiled', name) } : { noEmit: true }),
        },
      },
      null,
      2,
    ),
  );
  return configPath;
}

const unitConfig = join(validationRoot, 'vitest.config.mjs');
await writeFile(
  unitConfig,
  `export default ${JSON.stringify({
    resolve: { alias: aliases },
    test: { environment: 'node', include: ['src/**/*.test.ts'] },
  })};\n`,
);
const rendererConfig = join(validationRoot, 'vite.config.mjs');
const rendererDirectory = join(validationRoot, 'renderer');
await writeFile(
  rendererConfig,
  [
    `import original from ${JSON.stringify(join(repositoryRoot, 'apps/desktop/vite.config.ts'))};`,
    `export default { ...original, resolve: { ...original.resolve, alias: ${JSON.stringify(aliases)} }, build: { ...original.build, outDir: ${JSON.stringify(rendererDirectory)}, emptyOutDir: true } };`,
  ].join('\n'),
);

const mode = process.argv[2] ?? 'types';
if (mode === 'setup') {
  console.log(JSON.stringify({ validationRoot, unitConfig, rendererConfig, rendererDirectory }));
} else if (mode === 'unit') {
  const name = process.argv[3];
  if (!(name in projects)) throw new Error('Choose protocol, core, mcp or desktop.');
  process.exitCode = run(
    ['exec', 'vitest', 'run', '--config', unitConfig, ...process.argv.slice(4)],
    join(repositoryRoot, projects[name]),
  );
} else if (mode === 'renderer') {
  process.exitCode = run(
    ['exec', 'vite', 'build', '--config', rendererConfig],
    join(repositoryRoot, projects.desktop),
  );
  if (process.exitCode === 0) console.log(`CHATSPLICE_RENDERER_DIR=${rendererDirectory}`);
} else if (mode === 'types' || mode === 'build') {
  const results = [];
  for (const [name, project] of Object.entries(projects)) {
    const original =
      name === 'desktop'
        ? mode === 'build'
          ? 'tsconfig.main.build.json'
          : 'tsconfig.main.json'
        : mode === 'build'
          ? 'tsconfig.build.json'
          : 'tsconfig.json';
    const config = await configuration(name, original, mode === 'build');
    const code = run(['exec', 'tsc', '-p', config], join(repositoryRoot, project));
    results.push({ project: name, exit_code: code });
  }
  if (mode === 'types') {
    const rendererTsconfig = await configuration('desktop', 'tsconfig.renderer.json');
    const code = run(
      ['exec', 'svelte-check', '--tsconfig', rendererTsconfig],
      join(repositoryRoot, projects.desktop),
    );
    results.push({ project: 'renderer', exit_code: code });
  }
  console.log(JSON.stringify({ mode, results, output_directory: validationRoot }));
  process.exitCode = results.some((result) => result.exit_code !== 0) ? 1 : 0;
} else {
  throw new Error('Use setup, types, build, renderer or unit <project> [vitest arguments].');
}

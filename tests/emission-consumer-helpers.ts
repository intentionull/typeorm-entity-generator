import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ObjectLiteral } from 'typeorm';
import type { PlannedFile } from '../src/emit/model.js';

export async function compileConsumer(files: PlannedFile[], typeChecks?: string) {
  const root = await mkdtemp(join(tmpdir(), 'typeorm-consumer-'));
  const cleanup = () => rm(root, { recursive: true, force: true });
  try {
    await symlink(resolve('node_modules'), join(root, 'node_modules'), 'dir');
    await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    await writeFile(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2023',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          noUnusedLocals: true,
          noUnusedParameters: true,
          verbatimModuleSyntax: true,
          skipLibCheck: false,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          types: ['node'],
          declaration: true,
          noEmitOnError: true,
          outDir: 'dist',
        },
        include: ['*.ts'],
      }),
    );
    for (const file of files) await writeFile(join(root, file.path), file.content);
    if (typeChecks !== undefined) await writeFile(join(root, 'type-checks.ts'), typeChecks);
    const compilation = spawnSync(
      resolve('node_modules/.bin/tsc'),
      ['-p', join(root, 'tsconfig.json')],
      { encoding: 'utf8', timeout: 30_000 },
    );
    assert.equal(
      compilation.status,
      0,
      `${compilation.error ?? ''}\n${compilation.stdout}\n${compilation.stderr}`,
    );
    const registryUrl = pathToFileURL(join(root, 'dist/index.js')).href;
    const execution = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', `await import(${JSON.stringify(registryUrl)});`],
      { encoding: 'utf8', timeout: 30_000 },
    );
    assert.equal(
      execution.status,
      0,
      `${execution.error ?? ''}\n${execution.stdout}\n${execution.stderr}`,
    );
    const registry: { entities: (new () => ObjectLiteral)[] } = await import(registryUrl);
    assert.ok(Array.isArray(registry.entities));
    return { ...registry, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

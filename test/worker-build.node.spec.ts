// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect, test} from 'vitest';

test('renderer worker bundles before layer artifacts exist', () => {
    const repositoryDirectory = fileURLToPath(new URL('../', import.meta.url));
    const rendererPackage: {scripts: Record<string, string>} = JSON.parse(readFileSync(
        join(repositoryDirectory, 'modules/tangram-renderer/package.json'), 'utf8'));
    const bundleCommand = rendererPackage.scripts['build:loaders-gl-worker'];
    const commandPrefix = 'yarn --cwd ../.. ocular-bundle ';
    expect(bundleCommand.startsWith(commandPrefix)).toBe(true);
    const bundleArguments = bundleCommand.slice(commandPrefix.length).split(' ');
    const ocularPackageDirectory = dirname(fileURLToPath(import.meta.resolve('@vis.gl/dev-tools')));
    const bundleScript = join(ocularPackageDirectory, '../scripts/bundle.js');
    const workspaceDirectory = mkdtempSync(join(tmpdir(), 'tangram-worker-build-'));
    try {
        writeFileSync(join(workspaceDirectory, 'package.json'), JSON.stringify({
            name: 'worker-build-fixture', private: true, type: 'module'
        }));
        writeFileSync(join(workspaceDirectory, '.ocularrc.js'), readFileSync(
            join(repositoryDirectory, '.ocularrc.js')));
        const rendererDirectory = join(workspaceDirectory, 'modules/tangram-renderer');
        const layersDirectory = join(workspaceDirectory, 'modules/tangram-layers');
        mkdirSync(join(rendererDirectory, 'dist'), {recursive: true});
        mkdirSync(join(rendererDirectory, 'src/experimental'), {recursive: true});
        mkdirSync(layersDirectory, {recursive: true});
        writeFileSync(join(rendererDirectory, 'package.json'), JSON.stringify({
            name: '@vis.gl/tangram-renderer'
        }));
        writeFileSync(join(layersDirectory, 'package.json'), JSON.stringify({
            name: '@vis.gl/tangram-layers'
        }));
        // Keep the fixture tiny: this checks the real CLI/configuration path,
        // while package builds validate the actual loaders.gl implementation.
        writeFileSync(join(rendererDirectory, 'src/experimental/loaders-gl-worker.ts'),
            "self.registerMvtDecoder('fixture', (data: Uint8Array) => data);");
        expect(existsSync(join(layersDirectory, 'dist'))).toBe(false);
        execFileSync(process.execPath, [bundleScript, ...bundleArguments], {
            cwd: workspaceDirectory, stdio: 'pipe', timeout: 30_000
        });
        const workerOutput = readFileSync(join(rendererDirectory, 'dist/loaders-gl-worker.js'), 'utf8');
        expect(workerOutput).toContain('registerMvtDecoder');
        expect(workerOutput).toContain('TangramLoadersGL');
        expect(existsSync(join(rendererDirectory, 'dist/loaders-gl-worker.js.map'))).toBe(true);
        expect(existsSync(join(layersDirectory, 'dist'))).toBe(false);
    } finally {
        rmSync(workspaceDirectory, {recursive: true, force: true});
    }
});

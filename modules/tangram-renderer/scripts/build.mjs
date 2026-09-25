// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {mkdir} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import esbuild from 'esbuild';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = resolve(packageDirectory, 'src');
const outputDirectory = resolve(packageDirectory, 'dist');
const workerEntry = resolve(sourceDirectory, 'scene/scene_worker.ts');
const targets = ['chrome110', 'firefox110', 'safari15'];
const licenseBanner = `// Tangram\n// SPDX-License-Identifier: MIT\n// Copyright (c) 2013-2016 Brett Camper and Mapzen`;

/** Builds the worker as source text and embeds it in each renderer bundle. */
function createWorkerPlugin(minified) {
  let workerSource = '';
  let workerInputs = [];

  return {
    name: 'tangram-worker-source',
    setup(build) {
      build.onStart(async () => {
        const result = await esbuild.build({
          entryPoints: [workerEntry],
          bundle: true,
          write: false,
          metafile: true,
          format: 'iife',
          platform: 'browser',
          target: targets,
          loader: {'.glsl': 'text'},
          minify: minified,
          sourcemap: false
        });
        workerSource = result.outputFiles[0].text;
        workerInputs = Object.keys(result.metafile.inputs).map(input => resolve(packageDirectory, input));
      });

      build.onResolve({filter: /^tangram-worker$/}, () => ({path: 'tangram-worker', namespace: 'tangram-worker'}));
      build.onLoad({filter: /.*/, namespace: 'tangram-worker'}, () => ({
        contents: workerSource,
        loader: 'text',
        watchFiles: workerInputs
      }));
    }
  };
}

/** Returns the generated renderer entry that assigns its embedded worker URL. */
function createEntry(format) {
  const exportAssignment = format === 'esm' ? 'export default Tangram;' : '';
  return `
    import Tangram from ${JSON.stringify(resolve(sourceDirectory, 'index.ts'))};
    import workerSource from 'tangram-worker';
    Tangram.workerURL = URL.createObjectURL(new Blob([workerSource], {type: 'text/javascript'}));
    globalThis.Tangram = Tangram;
    ${exportAssignment}
  `;
}

/** Builds a browser artifact in either ESM or classic-script format. */
function getRendererBuildOptions(format, minified) {
  const extension = format === 'esm' ? 'mjs' : 'js';
  const outputName = `tangram.${minified ? 'min' : 'debug'}.${extension}`;
  return {
    stdin: {
      contents: createEntry(format),
      resolveDir: packageDirectory,
      sourcefile: `src/tangram-entry.${extension}`,
      loader: 'ts'
    },
    outfile: resolve(outputDirectory, outputName),
    bundle: true,
    format,
    platform: 'browser',
    target: targets,
    loader: {'.glsl': 'text'},
    banner: {js: licenseBanner},
    sourcemap: minified ? false : 'external',
    sourcesContent: false,
    minify: minified,
    plugins: [createWorkerPlugin(minified)],
    logLevel: 'info'
  };
}

/** Builds one renderer bundle variant. */
async function buildRenderer(format, minified) {
  await esbuild.build(getRendererBuildOptions(format, minified));
}

/** Creates a watch context for one renderer bundle variant. */
async function watchRenderer(format, minified) {
  const context = await esbuild.context(getRendererBuildOptions(format, minified));
  await context.watch();
  console.log(`Watching ${format} ${minified ? 'minified' : 'debug'} renderer bundle`);
}

/** Builds the worker fixture used by browser tests. */
async function buildTestWorker() {
  await mkdir(resolve(packageDirectory, 'build'), {recursive: true});
  await esbuild.build({
    entryPoints: [workerEntry],
    outfile: resolve(packageDirectory, 'build/worker.test.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: targets,
    loader: {'.glsl': 'text'},
    sourcemap: 'inline',
    logLevel: 'info'
  });
}

await mkdir(outputDirectory, {recursive: true});

if (process.argv.includes('--test-worker')) {
  await buildTestWorker();
} else {
  const buildAll = async () => {
    await buildRenderer('iife', false);
    await buildRenderer('iife', true);
    await buildRenderer('esm', false);
    await buildRenderer('esm', true);
  };

  if (process.argv.includes('--watch')) {
    await Promise.all([
      watchRenderer('iife', false),
      watchRenderer('iife', true),
      watchRenderer('esm', false),
      watchRenderer('esm', true)
    ]);
  } else {
    await buildRenderer('iife', false);
    await buildRenderer('iife', true);
    await buildRenderer('esm', false);
    await buildRenderer('esm', true);
  }
}

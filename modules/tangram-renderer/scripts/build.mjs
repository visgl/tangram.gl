// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {createReadStream} from 'node:fs';
import {mkdir, realpath, rm, stat} from 'node:fs/promises';
import {createServer} from 'node:http';
import {dirname, extname, resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import esbuild from 'esbuild';
import {getOcularConfig} from '@vis.gl/dev-tools';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = resolve(packageDirectory, 'src');
const outputDirectory = resolve(packageDirectory, 'dist');
const repositoryDirectory = resolve(packageDirectory, '../..');
const workerEntry = resolve(sourceDirectory, 'scene/scene_worker.ts');
const ocularConfig = await getOcularConfig({root: repositoryDirectory});
const targets = ocularConfig.bundle.target;
const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repositoryDirectory, encoding: 'utf8'}).trim();
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
        if (Object.keys(result.metafile.inputs).some(input => /node_modules\/@math\.gl\/projection\//.test(input))) {
          throw new Error('Normal scene worker unexpectedly includes optional math.gl projection kernels');
        }
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
function createEntry() {
  const exportAssignment = `
    export default Tangram;
    export {calculatePlanarGroundBounds, convertLumaLight, mapTangramLight, WebMercatorGlobeVisibilityAdapter, WebMercatorVisibilityAdapter}
      from ${JSON.stringify(resolve(sourceDirectory, 'index.ts'))};
  `;
  return `
    import Tangram from ${JSON.stringify(resolve(sourceDirectory, 'index.ts'))};
    import workerSource from 'tangram-worker';
    Tangram.workerURL = URL.createObjectURL(new Blob([workerSource], {type: 'text/javascript'}));
    Tangram.debug.ESM = true;
    Tangram.debug.SHA = ${JSON.stringify(gitSha)};
    globalThis.Tangram = Tangram;
    ${exportAssignment}
  `;
}

/** Serves repository files for the renderer and deck example watch workflow. */
async function startRepositoryServer() {
  const mimeTypes = {
    '.css': 'text/css',
    '.html': 'text/html',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.map': 'application/json',
    '.mjs': 'text/javascript',
    '.pbf': 'application/x-protobuf',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.wasm': 'application/wasm'
  };
  const server = createServer(async (request, response) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    } catch {
      response.writeHead(400).end('Bad request');
      return;
    }

    const filePath = resolve(repositoryDirectory, `.${pathname}`);
    if (filePath !== repositoryDirectory && !filePath.startsWith(`${repositoryDirectory}/`)) {
      response.writeHead(403).end('Forbidden');
      return;
    }

    try {
      const fileInfo = await stat(filePath);
      const resolvedFilePath = fileInfo.isDirectory() ? resolve(filePath, 'index.html') : filePath;
      const canonicalFilePath = await realpath(resolvedFilePath);
      if (canonicalFilePath !== repositoryDirectory && !canonicalFilePath.startsWith(`${repositoryDirectory}/`)) {
        response.writeHead(403).end('Forbidden');
        return;
      }
      response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': mimeTypes[extname(canonicalFilePath)] ?? 'application/octet-stream'
      });
      createReadStream(canonicalFilePath).pipe(response);
    } catch {
      response.writeHead(404).end('Not found');
    }
  });

  const port = Number(process.env.PORT ?? 8000);
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  console.log(`Serving repository at http://localhost:${port}/`);
  return server;
}

/** Builds the debug or minified browser ES module. */
function getRendererBuildOptions(minified) {
  const outputName = `tangram.${minified ? 'min' : 'debug'}.mjs`;
  return {
    stdin: {
      contents: createEntry(),
      resolveDir: packageDirectory,
      sourcefile: 'src/tangram-entry.mjs',
      loader: 'ts'
    },
    outfile: resolve(outputDirectory, outputName),
    bundle: true,
    format: 'esm',
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
async function buildRenderer(minified) {
  await esbuild.build(getRendererBuildOptions(minified));
}

/** Returns options shared by one-shot and watch builds of the host-only entry. */
function getCoreBuildOptions() {
  const options = getRendererBuildOptions(false);
  return {
    ...options,
    stdin: {
      ...options.stdin,
      contents: `
        import {setWorkerURL} from ${JSON.stringify(resolve(sourceDirectory, 'scene/worker_url.ts'))};
        import workerSource from 'tangram-worker';
        setWorkerURL(URL.createObjectURL(new Blob([workerSource], {type: 'text/javascript'})));
        export {Renderer, HostFrame, LumaDeviceRenderer, calculatePlanarGroundBounds, convertLumaLight, mapTangramLight, WebMercatorGlobeVisibilityAdapter, WebMercatorVisibilityAdapter,
          PROJECTION_CONSTANTS, projectGeographicPosition, projectGeographicVector, unprojectGlobePosition, getGeographicProjectionProcedure, normalizeProjectedBasemapOptions, getProjectedRoadUnit, countProjectedTileCoordinates, getTileGeographicBounds, getProjectedCoordinateOptions, PROJECTED_COMMON_SCALE, ProjectionBatchExecutor}
          from ${JSON.stringify(resolve(sourceDirectory, 'core.ts'))};
      `
    },
    outfile: resolve(outputDirectory, 'core.js'),
    metafile: true
  };
}

/** Builds the camera-free host entry and rejects accidental classic/deck dependencies. */
async function buildCore() {
  const result = await esbuild.build(getCoreBuildOptions());
  for (const input of Object.keys(result.metafile.inputs)) {
    // This package is an independent CPU test oracle, not a production projection dependency.
    if (/node_modules\/@math\.gl\/(geospatial|projection)\//.test(input)) {
      throw new Error(`Core entry includes the development-only projection oracle: ${input}`);
    }
    if (/scene\/(camera|classic_scene)\.ts$/.test(input) || /node_modules\/(@deck\.gl|leaflet)\//.test(input)) {
      throw new Error(`Core entry includes a forbidden dependency: ${input}`);
    }
  }
}

/** Keeps the host-only entry fresh alongside the full browser ES modules. */
async function watchCore() {
  const context = await esbuild.context(getCoreBuildOptions());
  await context.watch();
}

/** Creates a watch context for one renderer bundle variant. */
async function watchRenderer(minified) {
  const context = await esbuild.context(getRendererBuildOptions(minified));
  await context.watch();
  console.log(`Watching ESM ${minified ? 'minified' : 'debug'} renderer bundle`);
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
  // Remove obsolete outputs from incremental builds as well as clean builds.
  // These private-package artifacts have no application or website consumers.
  for (const obsoleteOutput of ['tangram.debug.js', 'tangram.debug.js.map', 'tangram.min.js']) {
    await rm(resolve(outputDirectory, obsoleteOutput), {force: true});
  }

  if (process.argv.includes('--watch')) {
    await startRepositoryServer();
    await Promise.all([
      watchRenderer(false),
      watchRenderer(true),
      watchCore()
    ]);
  } else {
    await buildRenderer(false);
    await buildRenderer(true);
    await buildCore();
  }
}

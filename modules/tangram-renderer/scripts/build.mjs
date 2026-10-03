// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {createReadStream} from 'node:fs';
import {mkdir, realpath, stat} from 'node:fs/promises';
import {createServer} from 'node:http';
import {dirname, extname, resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import esbuild from 'esbuild';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = resolve(packageDirectory, 'src');
const outputDirectory = resolve(packageDirectory, 'dist');
const repositoryDirectory = resolve(packageDirectory, '../..');
const workerEntry = resolve(sourceDirectory, 'scene/scene_worker.ts');
const targets = ['chrome110', 'firefox110', 'safari15'];
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
  const exportAssignment = format === 'esm' ? `
    export default Tangram;
    export {calculatePlanarGroundBounds, convertLumaLight, mapTangramLight, WebMercatorGlobeVisibilityAdapter, WebMercatorVisibilityAdapter}
      from ${JSON.stringify(resolve(sourceDirectory, 'index.ts'))};
  ` : '';
  const isEsm = format === 'esm';
  return `
    import Tangram from ${JSON.stringify(resolve(sourceDirectory, 'index.ts'))};
    import workerSource from 'tangram-worker';
    Tangram.workerURL = URL.createObjectURL(new Blob([workerSource], {type: 'text/javascript'}));
    Tangram.debug.ESM = ${isEsm};
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

/** Returns options shared by one-shot and watch builds of the host-only entry. */
function getCoreBuildOptions() {
  const options = getRendererBuildOptions('esm', false);
  return {
    ...options,
    stdin: {
      ...options.stdin,
      contents: `
        import {setWorkerURL} from ${JSON.stringify(resolve(sourceDirectory, 'scene/worker_url.ts'))};
        import workerSource from 'tangram-worker';
        setWorkerURL(URL.createObjectURL(new Blob([workerSource], {type: 'text/javascript'})));
        export {Renderer, HostFrame, LumaDeviceRenderer, calculatePlanarGroundBounds, convertLumaLight, mapTangramLight, WebMercatorGlobeVisibilityAdapter, WebMercatorVisibilityAdapter}
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
    if (/scene\/(camera|classic_scene)\.ts$/.test(input) || /node_modules\/(@deck\.gl|leaflet)\//.test(input)) {
      throw new Error(`Core entry includes a forbidden dependency: ${input}`);
    }
  }
}

/** Keeps the host-only entry fresh alongside the legacy browser bundles. */
async function watchCore() {
  const context = await esbuild.context(getCoreBuildOptions());
  await context.watch();
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
    await startRepositoryServer();
    await Promise.all([
      watchRenderer('iife', false),
      watchRenderer('iife', true),
      watchRenderer('esm', false),
      watchRenderer('esm', true),
      watchCore()
    ]);
  } else {
    await buildRenderer('iife', false);
    await buildRenderer('iife', true);
    await buildRenderer('esm', false);
    await buildRenderer('esm', true);
    await buildCore();
  }
}

// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * The shared basemap conformance harness of deck.gl-community (`dev/basemap-conformance`), read
 * from a checkout at a pinned commit. Report only: nothing here is part of `yarn test`.
 *
 *   node scripts/basemap-conformance.mjs checkout    clone or update the pinned checkout
 *   node scripts/basemap-conformance.mjs reference   render deck.gl-community's MapLibre reference
 *   node scripts/basemap-conformance.mjs score       run the shared scorer on the saved renders
 *   node scripts/basemap-conformance.mjs clean       delete the saved renders and the report
 *
 * BASEMAP_CONFORMANCE_CHECKOUT uses an existing deck.gl-community checkout instead of the one in
 * `.basemap-conformance/`. CONFORMANCE_OUTPUT moves the output directory.
 */

import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, rmSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

/** Where the checkout comes from. */
export const DECK_GL_COMMUNITY_REPOSITORY = 'https://github.com/visgl/deck.gl-community.git';

/**
 * The deck.gl-community commit of the harness: the head of deck.gl-community #975 (the shared
 * corpus, fixtures and scorer). Move it to the merge commit when #975 lands, and when the corpus
 * or the scorer changes.
 */
export const DECK_GL_COMMUNITY_COMMIT = '15b64b396fb65c2e3d9fb83b7c82d7742178c4ee';

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Git-ignored directory of the default checkout and the output. */
export const CONFORMANCE_DIRECTORY = join(REPOSITORY_ROOT, '.basemap-conformance');

/**
 * Paths of the harness for an environment.
 * @param {Record<string, string | undefined>} [environment]
 */
export function getConformancePaths(environment = process.env) {
  const checkout = resolve(
    environment.BASEMAP_CONFORMANCE_CHECKOUT || join(CONFORMANCE_DIRECTORY, 'deck.gl-community')
  );
  const harness = join(checkout, 'dev', 'basemap-conformance');
  return {
    checkout,
    harness,
    // The order of deck.gl-community's own runner: the corpus, then basemap-layers' fixtures.
    fixtureRoots: [
      join(harness, 'fixtures'),
      join(checkout, 'modules', 'basemap-layers', 'tests', 'reference-render', 'fixtures')
    ],
    output: resolve(environment.CONFORMANCE_OUTPUT || join(CONFORMANCE_DIRECTORY, 'output'))
  };
}

/** Throws when the harness is not checked out. */
export function assertHarness(paths = getConformancePaths()) {
  if (!existsSync(join(paths.harness, 'src', 'index.ts'))) {
    throw new Error(
      `No basemap conformance harness in ${paths.harness}. Run \`yarn conformance:checkout\`, ` +
        'or set BASEMAP_CONFORMANCE_CHECKOUT to a deck.gl-community checkout.'
    );
  }
}

/** Runs a command and throws when it fails. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {stdio: 'inherit', ...options});
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}`);
  }
}

function readHead(checkout) {
  const result = spawnSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], {encoding: 'utf8'});
  return result.status === 0 ? result.stdout.trim() : null;
}

/** The environment of a command in the checkout, without this repository's Yarn state. */
function getCheckoutEnvironment(extra) {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(npm_|YARN_|BERRY_)/i.test(key) && key !== 'PROJECT_CWD' && key !== 'INIT_CWD') {
      environment[key] = value;
    }
  }
  return {...environment, ...extra};
}

/** Clones the pinned commit into `.basemap-conformance/`, or checks an explicit checkout. */
function checkout(paths) {
  if (process.env.BASEMAP_CONFORMANCE_CHECKOUT) {
    assertHarness(paths);
    const head = readHead(paths.checkout);
    if (head !== DECK_GL_COMMUNITY_COMMIT) {
      console.warn(
        `${paths.checkout} is at ${head}, not at the pinned ${DECK_GL_COMMUNITY_COMMIT}. ` +
          'Its scores are not comparable with CI.'
      );
    }
    return;
  }
  if (readHead(paths.checkout) === DECK_GL_COMMUNITY_COMMIT) {
    console.log(`${paths.checkout} is at ${DECK_GL_COMMUNITY_COMMIT}`);
    return;
  }
  mkdirSync(paths.checkout, {recursive: true});
  if (!existsSync(join(paths.checkout, '.git'))) {
    run('git', ['init', '--quiet', paths.checkout]);
    run('git', ['-C', paths.checkout, 'remote', 'add', 'origin', DECK_GL_COMMUNITY_REPOSITORY]);
  }
  run('git', ['-C', paths.checkout, 'fetch', '--depth', '1', 'origin', DECK_GL_COMMUNITY_COMMIT]);
  run('git', ['-C', paths.checkout, 'checkout', '--quiet', '--detach', DECK_GL_COMMUNITY_COMMIT]);
  console.log(`Checked out deck.gl-community ${DECK_GL_COMMUNITY_COMMIT} in ${paths.checkout}`);
}

/**
 * Renders the Streets scenes with deck.gl-community's own runner and MapLibre, as the `maplibre`
 * reference. The checkout then needs its dependencies and its Chromium, which this installs.
 */
function reference(paths) {
  assertHarness(paths);
  const options = {cwd: paths.checkout, env: getCheckoutEnvironment({})};
  if (!existsSync(join(paths.checkout, 'node_modules'))) {
    run('yarn', ['install', '--immutable'], {
      ...options,
      env: getCheckoutEnvironment({YARN_ENABLE_HARDENED_MODE: '0'})
    });
  }
  run('yarn', ['playwright', 'install', 'chromium'], options);
  run('yarn', ['test-conformance'], {
    ...options,
    env: getCheckoutEnvironment({
      VITE_CONFORMANCE_RENDERERS: 'maplibre',
      VITE_CONFORMANCE_SCENES: process.env.VITE_CONFORMANCE_SCENES || 'tangram-streets',
      CONFORMANCE_OUTPUT: paths.output
    })
  });
}

/** Runs the shared scorer. It writes report.md, scores.json and images/ to the output. */
function score(paths) {
  assertHarness(paths);
  run(process.execPath, [join(paths.harness, 'scripts', 'score.ts'), paths.output]);
}

const COMMANDS = {
  checkout,
  reference,
  score,
  clean: paths => rmSync(paths.output, {recursive: true, force: true})
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = COMMANDS[process.argv[2]];
  if (!command) {
    console.error(`Usage: node scripts/basemap-conformance.mjs <${Object.keys(COMMANDS).join('|')}>`);
    process.exit(2);
  }
  try {
    command(getConformancePaths());
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import version from './version';
import Thread from './thread';
import WorkerBroker from './worker_broker';

import type {BrokerWorker} from './worker-types';

const workerBroker = WorkerBroker;

const LEVELS = {
  silent: -1,
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4
} as const;

/** Supported renderer log levels. */
export type LogLevel = keyof typeof LEVELS;

/** Per-message renderer logging options. */
export type LogOptions = {level: LogLevel; once?: boolean};

type ConsoleMethod = (...messages: unknown[]) => void;

/** Renderer logger with shared level and worker controls. */
export interface Logger {
  (options: LogLevel | LogOptions, ...messages: unknown[]): Promise<boolean>;
  level: LogLevel;
  workers: BrokerWorker[] | null;
  setLevel(level: LogLevel): void;
  setWorkers?(workers: BrokerWorker[] | null): void;
  reset?(): void;
}

const methods: Partial<Record<LogLevel, ConsoleMethod>> = {};
let loggedOnce: Record<string, true> = {};

function getMethodForLevel(level: LogLevel): ConsoleMethod | undefined {
  if (!Thread.is_main) {
    return;
  }
  if (!methods[level]) {
    const consoleMethods = console as unknown as Record<string, ConsoleMethod | undefined>;
    methods[level] = (consoleMethods[level] || console.log).bind(console);
  }
  return methods[level];
}

const log = (async (
  options: LogLevel | LogOptions,
  ...messages: unknown[]
): Promise<boolean> => {
  const level = typeof options === 'object' ? options.level : options;
  if (LEVELS[level] > LEVELS[log.level]) {
    return false;
  }

  if (Thread.is_worker) {
    return workerBroker.postMessage<boolean>(
      {method: '_logProxy', stringify: true},
      options,
      ...messages
    );
  }

  if (typeof options === 'object' && options.once === true) {
    const key = JSON.stringify(messages);
    if (loggedOnce[key]) {
      return false;
    }
    loggedOnce[key] = true;
  }

  const logger = getMethodForLevel(level);
  if (messages.length > 1) {
    logger!(`Tangram ${version} [${level}]: ${messages[0]}`, ...messages.slice(1));
  } else {
    logger!(`Tangram ${version} [${level}]: ${messages[0]}`);
  }
  return true;
}) as Logger;

log.level = 'info';
log.workers = null;

log.setLevel = (level: LogLevel): void => {
  log.level = level;
  if (Thread.is_main && Array.isArray(log.workers)) {
    workerBroker.postMessage(log.workers, '_logSetLevelProxy', level);
  }
};

if (Thread.is_main) {
  log.setWorkers = (workers: BrokerWorker[] | null): void => {
    log.workers = workers;
  };
  log.reset = (): void => {
    loggedOnce = {};
  };
}

WorkerBroker.addTarget('_logProxy', log);
WorkerBroker.addTarget('_logSetLevelProxy', log.setLevel);

export default log;

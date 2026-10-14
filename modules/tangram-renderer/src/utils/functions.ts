// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import hashString from './hash';

export type CompiledFunction = ((...arguments_: unknown[]) => unknown) & {source: string};
export type FunctionStringWrapper = (source: string) => string;
export type FunctionStringCache = {
  functions: Record<number, CompiledFunction>;
  num_functions: number;
  num_cached: number;
};

// cache of functions, keyed by unique source
const cache: FunctionStringCache = {
  functions: {},
  num_functions: 0,
  num_cached: 0
};

export { cache as functionStringCache };

export function clearFunctionStringCache(): void {
  cache.functions = {};
  cache.num_functions = 0;
  cache.num_cached = 0;
}

// Recursively parse an object, compiling string properties that look like functions
export function compileFunctionStrings<Value extends object>(value: Value, wrap?: FunctionStringWrapper): Value;
export function compileFunctionStrings<Value>(value: Value, wrap?: FunctionStringWrapper): Value | CompiledFunction;
export function compileFunctionStrings<Value>(
  value: Value,
  wrap?: FunctionStringWrapper
): Value | CompiledFunction {
  // Convert string
  if (typeof value === 'string') {
    return compileFunctionString(value, wrap) as Value | CompiledFunction;
  }
  // Loop through object properties
  if (value != null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const property in record) {
      record[property] = compileFunctionStrings(record[property], wrap);
    }
  }
  return value;
}

// Compile a string that looks like a function
export function compileFunctionString<Value>(
  value: Value,
  wrap?: FunctionStringWrapper
): Value | CompiledFunction {
  // Parse function signature and body
  const functionMatch =
    typeof value === 'string' && value.match(/^\s*function[^(]*\(([^)]*)\)\s*?\{([\s\S]*)\}$/m);

  if (functionMatch && functionMatch.length > 2) {
    try {
      // function body
      const body = functionMatch[2];
      const source = wrap ? wrap(body) : body;

      // compile and cache by unique function source
      const key = hashString(source);
      if (cache.functions[key] === undefined) {
        // function arguments extracted from signature
        const parsedArguments = functionMatch[1]
          .split(',')
          .map(argument => argument.trim())
          .filter(Boolean);
        const functionArguments = parsedArguments.length > 0 ? parsedArguments : ['context'];

        const compiledFunction = new Function(
          functionArguments.toString(),
          source
        ) as CompiledFunction;
        compiledFunction.source = body;
        cache.functions[key] = compiledFunction;
        cache.num_functions++;
      } else {
        cache.num_cached++;
      }

      return cache.functions[key];
    } catch {
      // fall back to original value if parsing failed
      return value;
    }
  }
  return value;
}

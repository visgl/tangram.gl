// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, describe, expect, test, vi} from 'vitest';
import makeWireframeForTriangleElementData from '../src/builders/wireframe';
import debounce from '../src/utils/debounce';
import {MethodNotImplemented} from '../src/utils/errors';
import {vec3} from '../src/utils/gl-matrix';
import sliceObject from '../src/utils/slice';
import {
  addBaseURL,
  addParamsToURL,
  extensionForURL,
  flattenRelativeURL,
  isLocalURL,
  isRelativeURL,
  pathForURL
} from '../src/utils/urls';

afterEach(() => {
  vi.useRealTimers();
});

describe('small renderer utilities', () => {
  test('converts triangle indices into line pairs', () => {
    expect(makeWireframeForTriangleElementData(new Uint16Array([1, 2, 3, 4, 5, 6])))
      .toEqual(new Uint16Array([1, 2, 2, 3, 3, 1, 4, 5, 5, 6, 6, 4]));
  });

  test('debounces calls while preserving receiver and arguments', async () => {
    vi.useFakeTimers();
    const receiver = {value: 0};
    const callback = vi.fn(function callback(this: {value: number}, value: number) {
      this.value = value;
    });
    const debounced = debounce(callback, 20);
    debounced.call(receiver, 1);
    debounced.call(receiver, 2);
    await vi.advanceTimersByTimeAsync(20);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(receiver.value).toBe(2);
  });

  test('selects named object properties', () => {
    expect(sliceObject({alpha: 1, beta: 2, gamma: 3}, ['alpha', 'gamma']))
      .toEqual({alpha: 1, gamma: 3});
  });

  test('keeps renderer vectors at double precision', () => {
    const vector = vec3.fromValues(1, 2, 3);
    expect(vector).toBeInstanceOf(Float64Array);
    expect(Array.from(vector)).toEqual([1, 2, 3]);
  });

  test('describes unimplemented subclass methods', () => {
    const error = new MethodNotImplemented('load');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('MethodNotImplemented');
    expect(error.message).toBe('Method load must be implemented in subclass');
  });

  test('resolves and classifies URLs', () => {
    expect(addBaseURL('../style.yaml', 'https://example.com/scenes/main.yaml'))
      .toBe('https://example.com/scenes/../style.yaml');
    expect(addBaseURL('/style.yaml', 'https://example.com/scenes/main.yaml'))
      .toBe('https://example.com/style.yaml');
    expect(addBaseURL('https://example.com/style.yaml', 'https://example.com/scenes/main.yaml'))
      .toBe('https://example.com/style.yaml');
    expect(addBaseURL('', 'https://example.com/scenes/main.yaml')).toBe('');
    expect(pathForURL('https://example.com/scenes/main.yaml?version=1#map')).toBe('https://example.com/scenes/');
    expect(pathForURL(null as unknown as string)).toBe('');
    expect(extensionForURL('https://example.com/scenes/main.yaml?version=1')).toBe('yaml?version=1');
    expect(extensionForURL('https://example.com/scenes/README')).toBeUndefined();
    expect(flattenRelativeURL('scenes/styles/../main.yaml')).toBe('scenes/main.yaml');
    expect(isRelativeURL('./main.yaml')).toBe(true);
    expect(isRelativeURL('https://example.com/main.yaml')).toBe(false);
    expect(isRelativeURL(null)).toBe(false);
    expect(isRelativeURL('data:text/plain,style')).toBe(false);
    expect(isLocalURL('blob:https://example.com/id')).toBe(true);
    expect(isLocalURL(null)).toBe(false);
  });

  test('adds URL parameters without duplicating existing values', () => {
    expect(addParamsToURL('https://example.com/tiles?api_key=existing#map', {api_key: 'new', lang: 'en'}))
      .toEqual(['https://example.com/tiles?lang=en&api_key=existing#map', [['api_key', 'new']]]);
  });
});

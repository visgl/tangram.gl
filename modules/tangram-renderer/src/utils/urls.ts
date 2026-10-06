// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import log from './log';

type URLParameters = Record<string, string | number | boolean | null | undefined>;
type ObjectURLSource = Blob | MediaSource;
type URLResult = [string, Array<[string, URLParameters[string]]>];

// Adds a base origin to relative URLs
/** Adds a base origin to a relative URL. */
export function addBaseURL(url: string, base?: string): string;
/** An omitted resource URL remains omitted, rather than acquiring a base path. */
export function addBaseURL(url: string | undefined, base?: string): string | undefined;
export function addBaseURL(url: string | undefined, base?: string): string | undefined {
    if (!url || !isRelativeURL(url)) {
        return url;
    }

    var relative_path = (url[0] !== '/');
    var base_info;
    if (base) {
        base_info = document.createElement('a'); // use a temporary element to parse URL
        base_info.href = base;
    }
    else {
        base_info = window.location;
    }

    if (relative_path) {
        let path = pathForURL(base_info.href);
        url = path + url;
    }
    else {
        let origin = base_info.origin;
        if (!origin) {
            origin = base_info.protocol + '//' + base_info.host; // IE11 doesn't have origin property
        }
        url = origin + url;
    }

    return url;
}

/** Returns the directory path portion of a URL. */
export function pathForURL(url: string | object | null | undefined): string {
    if (typeof url === 'string' && url.search(/^(data|blob):/) === -1) {
        let qs = url.indexOf('?');
        if (qs > -1) {
            url = url.substr(0, qs);
        }

        let hash = url.indexOf('#');
        if (hash > -1) {
            url = url.substr(0, hash);
        }

        return url.substr(0, url.lastIndexOf('/') + 1) || '';
    }
    return '';
}

/** Returns the filename extension portion of a URL. */
export function extensionForURL(url: string): string | undefined {
    const filename = url.split('/').pop() || '';
    let last_dot = filename.lastIndexOf('.');
    if (last_dot > -1) {
        return filename.substring(last_dot + 1);
    }
}

/** Returns whether a URL uses a local data or blob scheme. */
export function isLocalURL(url: unknown): boolean {
    if (typeof url !== 'string') {
        return false;
    }
    return (url.search(/^(data|blob):/) > -1);
}

/** Returns whether a URL is relative to its current document. */
export function isRelativeURL(url: unknown): boolean {
    if (typeof url !== 'string') {
        return false;
    }
    return !(url.search(/^(http|https|data|blob):/) > -1 || url.substr(0, 2) === '//');
}

// Resolves './' and '../' components from relative path, to get a "flattened" path
/** Resolves dot-directory components in a relative URL path. */
export function flattenRelativeURL(url: string): string {
    let dirs = (url || '').split('/');
    for (let d = 1; d < dirs.length; d++) {
        if (dirs[d] === '.') {
            dirs.splice(d, 1);
            d--;
        }
        else if (dirs[d] === '..') {
            d = d + 0;
            dirs.splice(d-1, 2);
            d--;
        }
    }
    return dirs.join('/');
}

// Add a set of query string params to a URL
// params: hash of key/value pairs of query string parameters
// returns array of: [modified URL, array of duplicate param name and values]
/** Adds query parameters and returns any parameters already present in the URL. */
export function addParamsToURL(url: string, params?: URLParameters): URLResult {
    if (!params || Object.keys(params).length === 0) {
        return [url, []];
    }

    var qs_index = url.indexOf('?');
    var hash_index = url.indexOf('#');

    // Save and trim hash
    var hash = '';
    if (hash_index > -1) {
        hash = url.slice(hash_index);
        url = url.slice(0, hash_index);
    }

    // Start query string
    if (qs_index === -1) {
        qs_index = url.length;
        url += '?';
    }
    qs_index++; // advanced past '?'

    // Build query string params
    var url_params = '';
    const dupes: Array<[string, URLParameters[string]]> = [];
    for (var p in params) {
        if (getURLParameter(p, url) !== '') {
            dupes.push([p, params[p]]);
            continue;
        }
        url_params += `${p}=${params[p]}&`;
    }

    // Insert new query string params and restore hash
    url = url.slice(0, qs_index) + url_params + url.slice(qs_index) + hash;

    return [url, dupes];
}

// Polyfill (for Safari compatibility)
let createObjectURLFunction: typeof URL.createObjectURL | null | undefined;
/** Creates a blob URL, using the vendor-prefixed fallback when necessary. */
export function createObjectURL(url: ObjectURLSource): string | ObjectURLSource {
    if (createObjectURLFunction === undefined) {
        createObjectURLFunction = (window.URL && window.URL.createObjectURL) || (window.webkitURL && window.webkitURL.createObjectURL);

        if (typeof createObjectURLFunction !== 'function') {
            createObjectURLFunction = null;
            log('warn', 'window.URL.createObjectURL (or vendor prefix) not found, unable to create local blob URLs');
        }
    }

    if (createObjectURLFunction) {
        return createObjectURLFunction(url);
    }
    else {
        return url;
    }
}

let revokeObjectURLFunction: typeof URL.revokeObjectURL | null | undefined;
/** Revokes a blob URL, using the vendor-prefixed fallback when necessary. */
export function revokeObjectURL(url: string): string | undefined {
    if (revokeObjectURLFunction === undefined) {
        revokeObjectURLFunction = (window.URL && window.URL.revokeObjectURL) || (window.webkitURL && window.webkitURL.revokeObjectURL);

        if (typeof revokeObjectURLFunction !== 'function') {
            revokeObjectURLFunction = null;
            log('warn', 'window.URL.revokeObjectURL (or vendor prefix) not found, unable to create local blob URLs');
        }
    }

    if (revokeObjectURLFunction) {
        revokeObjectURLFunction(url);
        return undefined;
    }
    else {
        return url;
    }
}

// Get URL that the current script was loaded from
// If currentScript is not available, loops through <script> elements searching for a list of provided paths
// e.g. findCurrentURL('tangram.debug.js', 'tangram.min.js');
/** Finds the URL of the current script or a matching script element. */
export function findCurrentURL(...paths: string[]): string | undefined {
    // Find currently executing script
    var script = document.currentScript;
    if (script) {
        return (script as HTMLScriptElement).src;
    }
    else if (Array.isArray(paths)) {
        // Fallback on looping through <script> elements if document.currentScript is not supported
        var scripts = document.getElementsByTagName('script');
        for (var s=0; s < scripts.length; s++) {
            for (let p=0; p < paths.length; p++) {
                const script = scripts[s] as HTMLScriptElement;
                if (script.src.indexOf(paths[p]) > -1) {
                    return script.src;
                }
            }
        }
    }
}

// Via https://davidwalsh.name/query-string-javascript
function getURLParameter(name: string, url: string): string {
    name = name.replace(/[[]/, '\\[').replace(/[\]]/, '\\]');
    var regex = new RegExp('[\\?&]' + name + '=([^&#]*)');
    var results = regex.exec(url);
    return results === null ? '' : decodeURIComponent(results[1].replace(/\+/g, ' '));
}

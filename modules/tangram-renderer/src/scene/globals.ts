// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import log from '../utils/log';
import { getPropertyPathTarget } from '../utils/props';

// prefix used to identify global property references
const GLOBAL_PREFIX = 'global.';
const GLOBAL_PREFIX_LENGTH = GLOBAL_PREFIX.length;

// name of 'hidden' (non-enumerable) property used to track global property references on an object
const GLOBAL_REGISTRY = '__global_prop';

/** Authored globals may contain scalars, functions, arrays, or opaque application values. */
type GlobalObject = Record<string, unknown>;
/** Non-enumerable provenance attached to objects/arrays after substitution. */
type GlobalTarget = Record<PropertyKey, unknown> & {
    [GLOBAL_REGISTRY]?: Record<PropertyKey, string>;
};

// Property name references a global property?
/** Identify URL/global-reference strings while retaining omitted resource values. */
export function isGlobalReference (val: string | null | undefined): boolean {
    return val?.slice(0, GLOBAL_PREFIX_LENGTH) === GLOBAL_PREFIX;
}

// Has object property been substitued with a value from a global reference?
// Property provided as a single-depth string name, or nested path array (`a.b.c` => ['a', 'b', 'c'])
/** Inspect substitution provenance for a named property or nested object/array path. */
export function isGlobalSubstitution (object: object, prop_or_path: string | (string | number)[]): boolean {
    const path = Array.isArray(prop_or_path) ? prop_or_path : [prop_or_path];
    const target = getPropertyPathTarget(object, path) as GlobalTarget | undefined;
    const prop = path[path.length - 1];
    return target?.[GLOBAL_REGISTRY]?.[prop] !== undefined;
}

// Flatten nested global properties for simpler string look-ups
/** Flatten global records without discarding their original nested values. */
export function flattenGlobalProperties (obj: GlobalObject, prefix: string | null = null, globals: GlobalObject = {}): GlobalObject {
    prefix = prefix ? (prefix + '.') : GLOBAL_PREFIX;

    for (const p in obj) {
        const key = prefix + p;
        const val = obj[p];
        globals[key] = val;

        if (typeof val === 'object' && !Array.isArray(val)) {
            flattenGlobalProperties(val as GlobalObject, key, globals);
        }
    }
    return globals;
}

// Find and apply new global properties (and re-apply old ones)
/** Reapply globals using hidden provenance, retaining the input object's identity and type. */
export function applyGlobalProperties<Value>(globals: GlobalObject, obj: Value, target?: object, key?: string | number): Value {
    let prop: string | undefined;
    const targetRecord = target as GlobalTarget | undefined;

    // Check for previously applied global substitution
    if (targetRecord?.[GLOBAL_REGISTRY]?.[key!]) {
        prop = targetRecord[GLOBAL_REGISTRY][key!];
    }
    // Check string for new global substitution
    else if (typeof obj === 'string' && obj.slice(0, GLOBAL_PREFIX_LENGTH) === GLOBAL_PREFIX) {
        prop = obj;
    }

    // Found global property to substitute
    if (prop) {
        // Mark property as global substitution
        if (targetRecord![GLOBAL_REGISTRY] == null) {
            Object.defineProperty(targetRecord!, GLOBAL_REGISTRY, { value: {} });
        }
        targetRecord![GLOBAL_REGISTRY]![key!] = prop;

        // Get current global value
        let val = globals[prop];
        let stack: string[] | undefined;
        while (typeof val === 'string' && val.slice(0, GLOBAL_PREFIX_LENGTH) === GLOBAL_PREFIX) {
            // handle globals that refer to other globals, detecting any cyclical references
            stack = stack || [prop];
            if (stack.indexOf(val) > -1) {
                log({ level: 'warn', once: true }, 'Global properties: cyclical reference detected', stack);
                val = null;
                break;
            }
            stack.push(val);
            val = globals[val];
        }

        // Create getter/setter
        Object.defineProperty(targetRecord!, key!, {
            enumerable: true,
            get: function () {
                return val; // return substituted value
            },
            set: function (v: unknown) {
                // clear the global substitution and remove the getter/setter
                delete targetRecord![GLOBAL_REGISTRY]![key!];
                delete targetRecord![key!];
                targetRecord![key!] = v; // save the new value
            }
        });
    }
    // Loop through object keys or array indices
    else if (Array.isArray(obj)) {
        for (let p = 0; p < obj.length; p++) {
            applyGlobalProperties(globals, obj[p], obj, p);
        }
    }
    else if (typeof obj === 'object') {
        for (const p in obj) {
            applyGlobalProperties(globals, obj[p], obj as object, p);
        }
    }
    return obj;
}

// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

type FilterValue = unknown;
/** Optional normalization for filter range bounds. */
export interface FilterOptions {
    rangeTransform?: (value: unknown) => unknown;
}
/** Generated filter retains authored function results; matching applies truthiness. */
export type FilterFunction = (context: {
    feature?: {properties: Record<string, unknown>};
    [name: string]: unknown;
}) => unknown;
type FilterAst = string[];

function notNull (x: FilterValue): boolean { return x != null; }
function wrap (x: FilterValue): string { return '(' + x + ')';}

function maybeQuote (value: FilterValue): FilterValue {
    if (typeof value === 'string') {
        return '"' + value + '"';
    }
    return value;
}

function lookUp (key: string): string {
    if (key[0] === '$') {
        // keys prefixed with $ are special properties in the context object (not feature properties)
        return 'context[\'' + key.substring(1) + '\']';
    }
    else if (key.indexOf('.') > -1) {
        if (key.indexOf('\\.') === -1) { // no escaped dot notation
            // un-escaped dot notation indicates a nested feature property
            return `context.feature.properties${key.split('.').map(k => '[\'' + k + '\']').join('')}`;
        }
        else { // mixed escaped/unescaped dot notation
            // escaped dot notation will be interpreted as a single-level feature property with dots in the name
            // this splits on unescaped dots, which requires a temporary swap of escaped and unescaped dots
            let keys = key
                .replace(/\\\./g, '__TANGRAM_DELIMITER__')
                .split('.')
                .map(s => s.replace(/__TANGRAM_DELIMITER__/g, '.'));
            return `context.feature.properties${keys.map(k => '[\'' + k + '\']').join('')}`;
        }
    }
    // single-level feature property
    return 'context.feature.properties[\'' + key + '\']';
}

function nullValue (/*key, value*/ _key?: FilterValue, _value?: FilterValue): string {
    return ' true ';
}

function propertyEqual (key: string, value: FilterValue): string {
    return wrap(maybeQuote(value) + ' === ' + lookUp(key));
}

function propertyOr (key: string, values: FilterValue[]): string {
    const arr = '[' + values.map(maybeQuote).join(',') + ']';
    return wrap(`${arr}.indexOf(${lookUp(key)}) > -1`);
}

function printNested (values: FilterAst[], joiner: string): string {
    return wrap(values.filter(notNull).map(function (x: FilterAst) {
        return wrap(x.join(' && '));
    }).join(' ' + joiner + ' '));
}

function any (_: FilterValue, values: FilterValue[], options: FilterOptions | undefined): string {
    return (values && values.length > 0) ? printNested(values.map(function (v: FilterValue) { return parseFilter(v, options); }), '||') : 'true';
}

function all (_: FilterValue, values: FilterValue[], options: FilterOptions | undefined): string {
    return (values && values.length > 0) ? printNested(values.map(function (v: FilterValue) { return parseFilter(v, options); }), '&&') : 'true';
}

function not (key: FilterValue, value: FilterValue, options: FilterOptions | undefined): string {
    return '!' + wrap(parseFilter(value, options).join(' && '));
}

function none (key: FilterValue, values: FilterValue[], options: FilterOptions | undefined): string {
    return '!' + wrap(any(null, values, options));
}

function propertyMatchesBoolean (key: string, value: boolean): string {
    return wrap(lookUp(key) + (value ? ' != ' : ' == ')  + 'null');
}

function rangeMatch (key: string, value: Record<string, unknown>, options: FilterOptions | undefined): string {
    var expressions = [];
    var transform = options && (typeof options.rangeTransform === 'function') && options.rangeTransform;

    if (value.max) {
        var max = transform ? transform(value.max) : value.max;
        expressions.push('' + lookUp(key) + ' < ' + max);
    }

    if (value.min) {
        var min: unknown = transform ? min = transform(value.min) : value.min;
        expressions.push('' + lookUp(key) + ' >= ' + min);
    }

    return wrap(expressions.join(' && '));
}

function includesMatch (key: string, value: Record<string, unknown>, _options?: FilterOptions): string {
    let expressions = [];

    // the array includes ONE OE MORE of the provided values (a single value is converted to an array)
    if (value.includes_any) {
        const vals = Array.isArray(value.includes_any) ? value.includes_any : [value.includes_any];
        const arr = '['+ vals.map(maybeQuote).join(',') + ']';
        expressions.push(`${lookUp(key)} != null && ${arr}.some(function(v) { return ${lookUp(key)}.indexOf(v) > -1 })`);
    }

    // the array includes ALL of the provided values (a single value is converted to an array)
    if (value.includes_all) {
        const vals = Array.isArray(value.includes_all) ? value.includes_all : [value.includes_all];
        const arr = '[' + vals.map(maybeQuote).join(',') + ']';
        expressions.push(`${lookUp(key)} != null && ${arr}.every(function(v) { return ${lookUp(key)}.indexOf(v) > -1 })`);
    }

    return wrap(expressions.join(' && '));
}

function parseFilter (filter: FilterValue, options: FilterOptions | undefined): FilterAst {
    var filterAST: FilterAst = [];

    // Function filter
    if (typeof filter === 'function') {
        return [wrap(wrap(filter.toString()) + '(context)')];
    }
    // Array filter, implicit 'any'
    else if (Array.isArray(filter)) {
        return [any(null, filter, options)];
    }
    // Null filter object
    else if (filter == null) {
        return ['true'];
    }

    // Object filter, e.g. implicit 'all'
    var keys = Object.keys(filter as object);
    for (var k=0; k < keys.length; k++) {
        var key = keys[k];

        var value = (filter as Record<string, unknown>)[key],
            type  = typeof value;
        if (type === 'string' || type === 'number') {
            filterAST.push(propertyEqual(key, value));
        } else if (type === 'boolean') {
            filterAST.push(propertyMatchesBoolean(key, value as boolean));
        } else if (key === 'not') {
            filterAST.push(not(key, value, options));
        } else if (key === 'any') {
            filterAST.push(any(key, value as FilterValue[], options));
        } else if (key === 'all') {
            filterAST.push(all(key, value as FilterValue[], options));
        } else if (key === 'none') {
            filterAST.push(none(key, value as FilterValue[], options));
        } else if (Array.isArray(value)) {
            filterAST.push(propertyOr(key, value));
        } else if (type === 'object' && value != null) {
            if ((value as Record<string, unknown>).max || (value as Record<string, unknown>).min) {
                filterAST.push(rangeMatch(key, value as Record<string, unknown>, options));
            }
            else if ((value as Record<string, unknown>).includes_any || (value as Record<string, unknown>).includes_all) {
                filterAST.push(includesMatch(key, value as Record<string, unknown>, options));
            }
        } else if (value == null) {
            filterAST.push(nullValue(key, value));
        } else {
            throw new Error('Unknown Query syntax: ' + value);
        }
    }

    return keys.length === 0 ? ['true'] : filterAST;
}

function filterToString (filterAST: FilterAst): string {
    return wrap(filterAST.join(' && '));
}

export function buildFilter (filter: FilterValue, options?: FilterOptions): FilterFunction {
    if (filter == null) { return function () { return true; }; }
    // jshint evil: true
    return new Function('context', 'return ' + filterToString(parseFilter(filter, options)) + ';') as FilterFunction;
}

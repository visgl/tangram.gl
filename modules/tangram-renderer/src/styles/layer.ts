// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import type {LayerConfig, LayerDrawGroup, LayerDrawGroups, LayerMatchContext, LayerPropertyMatch, LayerCombinationCache, SceneLayer, SceneLayerDefinition} from './layer-types';
import type {PropertyFunction} from './property-types';

import StyleParser from './style_parser';
import { compileFunctionStrings } from '../utils/functions';
import log from '../utils/log';
import mergeObjects from '../utils/merge';
import Geo from '../utils/geo';
import { buildFilter } from './filter';

// N.B.: 'visible' is legacy compatibility for 'enabled'
const reserved = ['filter', 'draw', 'visible', 'enabled', 'data', 'exclusive', 'priority'];

let layer_cache: LayerCombinationCache = {};
export function layerCache () {
    return layer_cache;
}

function cacheKey (layers: number[]): string | number {
    if (layers.length > 1) {
        var k = layers[0] as string | number;
        for (var i=1; i < layers.length; i++) {
            k += '/' + layers[i];
        }

        return k;
    }
    return layers[0];
}

// Merge matching layer trees into a final draw group
export function mergeTrees(matchingTrees: (Array<LayerDrawGroups | undefined> | false | undefined)[], group: string): LayerDrawGroup | null {
    let draws: LayerDrawGroup[], treeDepth = 0;

    // Find deepest tree
    for (let t=0; t < matchingTrees.length; t++) {
        if ((matchingTrees[t] as Array<LayerDrawGroups | undefined>).length > treeDepth) {
            treeDepth = (matchingTrees[t] as Array<LayerDrawGroups | undefined>).length;
        }
    }

    // No layers to parse
    if (treeDepth === 0) {
        return null;
    }

    // Merged draw group object
    let draw: LayerDrawGroup = {
        visible: true, // visible by default
    };

    // Iterate trees in parallel
    for (let x=0; x < treeDepth; x++) {
        // Pull out the requested draw group, for each tree, at this depth (avoiding duplicates at the same level in tree)
        draws = [];
        matchingTrees.forEach(tree => {
            if ((tree as LayerDrawGroups[])[x] && (tree as LayerDrawGroups[])[x][group]! && draws.indexOf((tree as LayerDrawGroups[])[x][group]!) === -1) {
                draws.push((tree as LayerDrawGroups[])[x][group]!);
            }
        });
        if (draws.length === 0) {
            continue;
        }

        // Merge draw objects
        mergeObjects(draw, ...draws);
    }

    // Short-circuit if not visible
    if (draw.visible === false) {
        return null;
    }

    return draw;
}

const blacklist = ['any', 'all', 'not', 'none'];

/** Lazy feature-filter and inherited draw state shared by tree and leaf nodes. */
class Layer {
    declare static id: number;
    declare id: number;
    declare config_data: unknown;
    declare parent: LayerTree | null | undefined;
    declare name: string;
    declare full_name: string;
    declare draw: LayerDrawGroups | undefined;
    declare filter: unknown;
    declare filter_original: unknown;
    declare exclusive: boolean;
    declare priority: number;
    declare styles: Record<string, unknown> | undefined;
    declare is_built: boolean;
    declare enabled: boolean;
    declare visible?: boolean;
    declare calculatedDraw: Array<LayerDrawGroups | undefined>;
    declare zooms?: Record<number, boolean>;
    declare feature_prop_matches?: LayerPropertyMatch[];
    declare context_prop_matches?: LayerPropertyMatch[];
    declare children_to_parse?: SceneLayerDefinition | null;
    declare is_leaf?: boolean;
    declare is_tree?: boolean;
    /** Children exist only on tree nodes, not leaf objects. */
    declare layers?: SceneLayer[];

    constructor({ layer, name, parent, draw, visible, enabled, filter, exclusive, priority, styles }: LayerConfig) {
        this.id = Layer.id++;
        this.config_data = layer.data;
        this.parent = parent;
        this.name = name;
        this.full_name = this.parent ? (this.parent.full_name + ':' + this.name) : this.name;
        this.draw = draw as LayerDrawGroups | undefined;
        this.filter = filter;
        this.exclusive = (exclusive === true);
        this.priority = (priority != null ? priority : Number.MAX_SAFE_INTEGER);
        this.styles = styles;
        this.is_built = false;

        enabled = (enabled === undefined) ? visible : enabled; // `visible` property is backwards compatible for `enabled`
        this.enabled = (enabled !== false); // layer is enabled unless explicitly set to disabled

        // Denormalize layer name to draw groups
        if (this.draw) {
            for (let group in this.draw) {
                this.draw[group] = (this.draw[group] == null) ? {} : this.draw[group];
                if (typeof this.draw[group] !== 'object') {
                    // Invalid draw group
                    let msg = `Draw group '${group}' for layer ${this.full_name} is invalid, must be an object, `;
                    msg += `but was set to \`${group}: ${this.draw[group]}\` instead`;
                    log('warn', msg); // TODO: fire external event that clients to subscribe to

                    delete this.draw[group];
                }
            }
        }
    }

    build () {
        log('trace', `Building layer '${this.full_name}'`);
        this.buildFilter();
        this.buildDraw();
        this.is_built = true;
    }

    buildDraw() {
        this.draw = compileFunctionStrings(this.draw, StyleParser.wrapFunction) as LayerDrawGroups | undefined;
        this.calculatedDraw = calculateDraw(this);
    }

    buildFilter() {
        this.filter_original = this.filter;
        this.filter = compileFunctionStrings(this.filter, StyleParser.wrapFunction);

        let type = typeof this.filter;
        if (this.filter != null && type !== 'object' && type !== 'function') {
            // Invalid filter
            let msg = `Filter for layer ${this.full_name} is invalid, filter value must be an object or function, `;
            msg += `but was set to \`filter: ${this.filter}\` instead`;
            log('warn', msg); // TODO: fire external event that clients to subscribe to
            return;
        }

        try {
            this.buildZooms();
            this.buildPropMatches();
            if (this.filter != null && (typeof this.filter === 'function' || Object.keys(this.filter).length > 0)) {
                this.filter = buildFilter(this.filter, FilterOptions);
            }
            else {
                this.filter = null;
            }
        }
        catch(e) {
            // Invalid filter
            let msg = `Filter for layer ${this.full_name} is invalid, \`filter: ${JSON.stringify(this.filter)}\` `;
            msg += `failed with error '${(e as Error).message}', stack trace: ${(e as Error).stack}`;
            log('warn', msg); // TODO: fire external event that clients to subscribe to
        }
    }

    // Zooms often cull large swaths of the layer tree, so they get special treatment and are checked first
    buildZooms() {
        let zoom = this.filter && (this.filter as Record<string, unknown>).$zoom; // has an explicit zoom filter
        let ztype = typeof zoom;
        if (zoom != null) {
            this.zooms = {};

            if (ztype === 'number') {
                this.zooms[zoom as number] = true;
            }
            else if (Array.isArray(zoom)) {
                for (let z=0; z < zoom.length; z++) {
                    this.zooms[zoom[z]] = true;
                }
            }
            else if (ztype === 'object' && ((zoom as {min?: number}).min != null || (zoom as {max?: number}).max != null)) {
                let zmin = (zoom as {min?: number}).min || 0;
                let zmax = (zoom as {max?: number}).max || Geo.max_style_zoom;
                for (let z=zmin; z < zmax; z++) {
                    this.zooms[z] = true;
                }
            }

            delete (this.filter as Record<string, unknown>).$zoom; // don't process zoom through usual generic filter logic
        }
    }

    buildPropMatches() {
        if (!this.filter || Array.isArray(this.filter) || typeof this.filter === 'function') {
            return;
        }

        Object.keys(this.filter).forEach(key => {
            if (blacklist.indexOf(key) === -1) {
                let val = (this.filter as Record<string, unknown>)[key];
                let type = typeof val;
                let array = Array.isArray(val);

                if (!(array || type === 'string' || type === 'number')) {
                    return;
                }

                if (key[0] === '$') {
                    // Context property
                    this.context_prop_matches = this.context_prop_matches || [];
                    this.context_prop_matches.push([key.substring(1), array ? val as unknown[] : [val]]);
                    delete (this.filter as Record<string, unknown>)[key];
                }
                else if (key.indexOf('.') === -1) { // exclude nested feature properties
                    // Single-level feature property
                    this.feature_prop_matches = this.feature_prop_matches || [];
                    this.feature_prop_matches.push([key, array ? val as unknown[] : [val]]);
                    delete (this.filter as Record<string, unknown>)[key];
                }
            }
        });
    }

    doPropMatches (context: LayerMatchContext): boolean {
        if (this.feature_prop_matches) {
            for (let r=0; r < this.feature_prop_matches.length; r++) {
                let match = this.feature_prop_matches[r];
                let val = context.feature.properties[match[0]];
                if (val == null || match[1].indexOf(val) === -1) {
                    return false;
                }
            }
        }

        if (this.context_prop_matches) {
            for (let r=0; r < this.context_prop_matches.length; r++) {
                let match = this.context_prop_matches[r];
                let val = context[match[0]];
                if (val == null || match[1].indexOf(val) === -1) {
                    return false;
                }
            }
        }

        return true;
    }

    doesMatch (context: LayerMatchContext): boolean {
        if (!this.enabled) {
            return false;
        }

        if (!this.is_built) {
            this.build();
        }

        // zoom pre-filter: skip rest of filter if out of layer zoom range
        if (this.zooms != null && !this.zooms[context.zoom]) {
            return false;
        }

        // direct feature property matches
        if (!this.doPropMatches(context)) {
            return false;
        }

        // any remaining filter (more complex matches or dynamic function)
        let match;
        if (this.filter instanceof Function){
            try {
                match = (this.filter as PropertyFunction)(context);
            }
            catch (error) {
                // Filter function error
                let msg = `Filter for this ${this.full_name}: \`filter: ${this.filter_original}\` `;
                msg += `failed with error '${(error as Error).message}', stack trace: ${(error as Error).stack}`;
                log('error', msg, context.feature);
            }
        }
        else {
            match = this.filter == null;
        }

        if (match) {
            if (this.children_to_parse) {
                parseLayerChildren(this as LayerTree, this.children_to_parse, this.styles);
                delete this.children_to_parse;
            }

            return true;
        }
        return false;
    }

}

Layer.id = 0;


/** Terminal scene node with no child traversal state. */
export class LayerLeaf extends Layer {
    constructor (config: LayerConfig) {
        super(config);
        this.is_leaf = true;
    }

}

/** Root/branch node with deferred children and cached matching draw combinations. */
export class LayerTree extends Layer {
    /** Traversable children, populated only after the parent matches. */
    declare layers: SceneLayer[];
    constructor (config: LayerConfig) {
        super(config);
        this.is_tree = true;
        this.layers = config.layers || [];
    }

    addLayer (layer: SceneLayer): void {
        this.layers.push(layer);
    }

    buildDrawGroups (context: LayerMatchContext): LayerDrawGroups | null | undefined {
        let layers: SceneLayer[] = [], layer_ids: number[] = [];
        matchFeature(context, [this], layers, layer_ids);

        if (layers.length > 0) {
            let cache_key = cacheKey(layer_ids);

            // Only evaluate each layer combination once (undefined means not yet evaluated,
            // null means evaluated with no draw object)
            if (layer_cache[cache_key] === undefined) {
                // Find all the unique visible draw blocks for this layer tree
                let draw_groups = layers.map(x => x && x.visible !== false && x.calculatedDraw);
                let draw_keys: Record<string, boolean> = {};

                for (let r=0; r < draw_groups.length; r++) {
                    let stack = draw_groups[r];
                    if (!stack) {
                        continue;
                    }
                    for (let g=0; g < stack.length; g++) {
                        let group = stack[g];
                        for (let key in group) {
                            draw_keys[key] = true;
                        }
                    }
                }

                // Calculate each draw group
                for (let draw_key in draw_keys) {
                    layer_cache[cache_key] = layer_cache[cache_key] || {};
                    layer_cache[cache_key]![draw_key] = mergeTrees(draw_groups, draw_key);

                    // Only save the ones that weren't null
                    if (!layer_cache[cache_key]![draw_key]) {
                        delete layer_cache[cache_key]![draw_key];
                    }
                    else {
                        layer_cache[cache_key]![draw_key]!.key = cache_key + '/' + draw_key;
                        layer_cache[cache_key]![draw_key]!.layers = layers.map(x => x && x.full_name);
                        layer_cache[cache_key]![draw_key]!.group = draw_key;
                    }
                }

                // No layers evaluated
                if (layer_cache[cache_key] && Object.keys(layer_cache[cache_key]).length === 0) {
                    layer_cache[cache_key] = null;
                }
            }
            return layer_cache[cache_key];
        }
    }

}

export const FilterOptions = {
    // Handle unit conversions on filter ranges
    rangeTransform(val: unknown): unknown {
        if (typeof val === 'string' && val.trim().slice(-3) === 'px2') {
            return `${parseFloat(val)} * context.meters_per_pixel_sq`;
        }
        return val;
    }
};

export function isReserved(key: string): boolean {
    return reserved.indexOf(key) > -1;
}

function isEmpty(obj: object): boolean {
    return Object.keys(obj).length === 0;
}

export function groupProps(obj: SceneLayerDefinition): [SceneLayerDefinition, SceneLayerDefinition] {
    let reserved: SceneLayerDefinition = {}, children: SceneLayerDefinition = {};

    for (let key in obj) {
        if (isReserved(key)) {
            reserved[key] = obj[key];
        } else {
            children[key] = obj[key];
        }
    }
    return [reserved, children];
}

export function calculateDraw(layer: Layer): Array<LayerDrawGroups | undefined> {

    let draw: Array<LayerDrawGroups | undefined> = [];

    if (layer.parent) {
        let cs = layer.parent.calculatedDraw || [];
        draw.push(...cs);
    }

    draw.push(layer.draw);
    return draw;
}

export function parseLayerNode(name: string, layer: SceneLayerDefinition | null | undefined, parent?: LayerTree | null, styles?: Record<string, unknown>): SceneLayer {

    layer = (layer == null) ? {} : layer;

    let properties = { name, layer, parent, styles };
    let [reserved, children] = groupProps(layer);
    let empty = isEmpty(children);
    let Create;

    if (empty && parent != null) {
        Create = LayerLeaf;
    } else {
        Create = LayerTree;
    }

    let r = new Create(Object.assign(properties, reserved) as LayerConfig);

    // only process child layers if this layer is enabled
    if (r.enabled) {
        if (parent) {
            parent.addLayer(r);
        }
        r.children_to_parse = empty ? null : children;
    }

    return r;
}

function parseLayerChildren (parent: LayerTree, children: SceneLayerDefinition, styles?: Record<string, unknown>): void {
    for (let key in children) {
        let child = children[key];
        if (typeof child === 'object' && !Array.isArray(child)) {
            parseLayerNode(key, child as SceneLayerDefinition | null, parent, styles);
        } else {
            // Invalid layer
            let msg = `Layer value must be an object: cannot create layer '${key}: ${JSON.stringify(child)}'`;
            msg += `, under parent layer '${parent.full_name}'.`;

            // If the parent is a style name, this may be an incorrectly nested layer
            if (styles![parent.name]) {
                msg += ` The parent name '${parent.name}' is also the name of a style, did you mean to create a 'draw' group`;
                if (parent.parent) {
                    msg += ` under '${parent.parent.name}'`;
                }
                msg += ' instead?';
            }
            log('warn', msg); // TODO: fire external event that clients to subscribe to
        }
    }

    // Sort sub-layers so they are applied deterministically when multiple layers modify the same properties
    // Sort order is: exclusive layers first, then by explicit layer priority, then by layer name
    parent.layers.sort(((a: SceneLayer, b: SceneLayer) => {
        // Exclusive layers come first
        // If an exclusive layer matches, no further sibling layers are matched
        if (a.exclusive < b.exclusive) return 1;
        else if (a.exclusive > b.exclusive) return -1;

        // When sub-sorting exclusive layers, sort the higher priority layers first, since only one exlcusive layer
        // can match and the first one that matches should be the highest priority.
        // When sub-sorting non-exclusive layers, sort the lower priority layers first, since multiple layers may
        // match, and when they are merged in order, the later layers will overwrite the earlier ones -- so we want
        // the higher priority ones to match last so that they "win".
        const direction = (a.exclusive ? 1 : -1);

        // Sub-sort by explicit priority
        if (a.priority > b.priority) return direction;
        else if (a.priority < b.priority) return -direction;

        // Sub-sort by layer name as last resort
        if (a.full_name < b.full_name) return direction;
        else if (a.full_name > b.full_name) return -direction;
    }) as (a: SceneLayer, b: SceneLayer) => number);
}


export function parseLayers (layers: Record<string, SceneLayerDefinition | null | undefined>, styles?: Record<string, unknown>): Record<string, SceneLayer> {
    layer_cache = {}; // clear layer cache
    let layer_trees: Record<string, SceneLayer> = {};

    for (let key in layers) {
        let layer = layers[key];
        if (layer) {
            layer_trees[key] = parseLayerNode(key, layer, null, styles);
        }
    }

    return layer_trees;
}

export function matchFeature(context: LayerMatchContext, layers: SceneLayer[], collected_layers: SceneLayer[], collected_layers_ids: number[]): boolean | undefined {
    let matched = false;
    let child_matched: boolean | undefined = false;

    if (layers.length === 0) {
        return;
    }

    for (let r=0; r < layers.length; r++) {
        let current = layers[r];

        if (current.is_leaf) {
            if (current.doesMatch(context)) {
                matched = true;
                collected_layers.push(current);
                collected_layers_ids.push(current.id);

                if (current.exclusive) {
                    break; // only one exclusive layer can match, stop matching further sibling layers
                }
            }

        } else if (current.is_tree) {
            if (current.doesMatch(context)) {
                matched = true;

                child_matched = matchFeature(
                    context,
                    current.layers!,
                    collected_layers,
                    collected_layers_ids
                );

                if (!child_matched) {
                    collected_layers.push(current);
                    collected_layers_ids.push(current.id);
                }

                if (current.exclusive) {
                    break; // only one exclusive layer can match, stop matching further sibling layers
                }
            }
        }
    }

    return matched;
}

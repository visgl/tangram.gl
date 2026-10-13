// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

// Texture management

import log from '../utils/log';
import Utils from '../utils/utils';
import subscribeMixin from '../utils/subscribe';
import WorkerBroker from '../utils/worker_broker';
import Context from './context';
import type {Texture as GPUTexture} from '@luma.gl/core';
import type {TangramTextureOptions} from '../gpu/tangram_gpu_backend';
import type {SubscriptionMethods} from '../utils/subscribe';

/** Browser image sources accepted by the classic texture wrapper. */
type TextureElement = HTMLCanvasElement | HTMLVideoElement | HTMLImageElement;
/** Shared raw pixel uploads and DOM sources; names/selectors are resolved by load. */
type TextureSource = TextureElement | Uint8Array | null;
/** The wrapper owns disposal only; portable draw binding remains the backend's responsibility. */
export type TextureResource = Pick<GPUTexture, 'destroy'>;
/** Named texture options, including worker-safe sprite definitions. */
export interface TextureOptions {
    filtering?: 'nearest' | 'linear' | 'mipmap';
    sprites?: Record<string, [number, number, number, number]>;
    url?: string;
    element?: string | TextureElement;
    data?: number[] | Uint8Array | null;
    width?: number;
    height?: number;
    density?: number;
    repeat?: boolean;
    TEXTURE_WRAP_S?: number;
    TEXTURE_WRAP_T?: number;
    UNPACK_FLIP_Y_WEBGL?: boolean;
    UNPACK_PREMULTIPLY_ALPHA_WEBGL?: boolean;
    textureFactory?: (options: TangramTextureOptions) => TextureResource;
    skip_create?: boolean;
}
/** Structured-clone metadata: workers never acquire GPU resources or live methods. */
export interface TextureInfo {
    name: string;
    width: number;
    height: number;
    density: number;
    css_size?: number[];
    aspect?: number;
    sprites?: TextureOptions['sprites'];
    texcoords: Record<string, number[]>;
    sizes: Record<string, number[]>;
    css_sizes: Record<string, number[]>;
    aspects: Record<string, number>;
    filtering?: TextureOptions['filtering'];
    power_of_2?: boolean;
    valid: boolean;
}
/** Legacy bulk requests may recursively expand empty names to the entire registry. */
export type TextureInfoResult = TextureInfo | null | TextureInfoResult[];

function isTextureElement(source: unknown): source is TextureElement {
    return (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) ||
        (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) ||
        (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement && source.complete);
}

// GL texture wrapper object for keeping track of a global set of textures, keyed by a unique user-defined name
export default class Texture {
    /** Release one mesh-owned reference to a named texture. */
    declare static release: (name: string) => void;
    /** Create or replace a named style texture through the existing registry. */
    declare static create: (context: object | null, name: string, options?: TextureOptions) => Texture;
    /** Placeholder sampler used by untextured mesh variants. */
    declare static default: string;
    /** Dimensions available to line styles in either execution thread. */
    declare static textures: Record<string, Texture | TextureInfo>;
    /** Synchronize named texture dimensions from the main thread to a worker. */
    declare static syncTexturesToWorker: (names?: string[] | null) => Promise<Record<string, Texture | TextureInfo>>;
    /** Live context resources; detached worker metadata has no GPU ownership. */
    declare gl: object | null;
    declare texture_factory: TextureOptions['textureFactory'];
    declare texture_resource: TextureResource | null;
    declare texture: TextureResource | WebGLTexture | null;
    declare valid: boolean;
    declare name: string;
    declare retain_count: number;
    declare config_type: 'url' | 'element' | 'data' | null;
    declare loading: Promise<Texture> | null;
    declare loaded: boolean;
    declare filtering: TextureOptions['filtering'];
    declare density: number;
    declare sprites: TextureOptions['sprites'];
    declare texcoords: TextureInfo['texcoords'];
    declare sizes: TextureInfo['sizes'];
    declare css_sizes: TextureInfo['css_sizes'];
    declare aspects: TextureInfo['aspects'];
    declare width: number;
    declare height: number;
    declare power_of_2: boolean | undefined;
    declare url: string;
    /** Existing dynamic static methods, declared without runtime field initialization. */
    declare static retain: (name: string) => void;
    declare static destroy: (context: object | null) => void;
    declare static getSpriteInfo: (name: string, sprite: string) => {size: number[]; css_size: number[]; aspect: number; texcoords: number[]} | undefined;
    declare static getTexcoordsForSprite: (origin: readonly number[], size: readonly number[], dimensions: readonly number[]) => number[];
    declare static createFromObject: (context: object | null, textures?: Record<string, TextureOptions>) => Promise<(Texture | null)[]>;
    declare static createDefault: (context: object | null) => Texture;
    declare static sliceOptions: (options: TextureOptions) => TextureOptions;
    declare static changed: (name: string, options: TextureOptions) => boolean;
    declare static getInfo: typeof getTextureInfo;
    declare static getMaxTextureSize: (context: object | null) => number;
    declare static setResourceFactory: (context: object, factory: TextureOptions['textureFactory']) => void;
    declare static getResourceFactory: (context: object) => TextureOptions['textureFactory'];
    declare static clearResourceFactory: (context: object) => void;
    declare static texture_configs: Record<string, string>;
    declare static resource_factories: WeakMap<object, NonNullable<TextureOptions['textureFactory']>>;
    declare static boundTexture: Texture['texture'];
    declare static activeUnit: number | null;
    declare static resetBindings: () => void;
    declare static trigger: SubscriptionMethods['trigger'];
    declare static subscribe: SubscriptionMethods['subscribe'];
    declare static unsubscribe: SubscriptionMethods['unsubscribe'];
    declare static unsubscribeAll: SubscriptionMethods['unsubscribeAll'];
    declare static hasSubscribersFor: SubscriptionMethods['hasSubscribersFor'];

    constructor(gl: object | null, name: string, options: TextureOptions = {}) {
        options = Texture.sliceOptions(options); // exclude any non-texture-specific props
        this.gl = gl;
        this.texture_factory = options.textureFactory || (gl && Texture.getResourceFactory(gl)) || undefined;
        this.texture_resource = null;
        this.texture = this.texture_factory ? null : getClassicTextureContext(gl).createTexture();
        this.valid = Boolean(this.texture_factory || this.texture);
        this.bind();

        this.name = name;
        this.retain_count = 0;
        this.config_type = null;
        this.loading = null;    // a Promise object to track the loading state of this texture
        this.loaded = false;    // successfully loaded as expected
        this.filtering = options.filtering;
        this.density = options.density || 1; // native pixel density of texture
        this.sprites = options.sprites;
        this.texcoords = {};    // sprite UVs ([0, 1] range)
        this.sizes = {};        // sprite sizes (pixel size)
        this.css_sizes = {};    // sprite sizes, adjusted for native texture pixel density
        this.aspects = {};      // sprite aspect ratios

        // Default to a 1-pixel transparent black texture so we can safely render while we wait for an image to load
        // See: http://stackoverflow.com/questions/19722247/webgl-wait-for-texture-to-load
        this.setData(1, 1, new Uint8Array([0, 0, 0, 0]), { filtering: 'nearest' });
        this.loaded = false; // don't consider loaded when only placeholder data is present

        // Destroy previous texture if present
        const previousTexture = Texture.textures[this.name];
        if (previousTexture instanceof Texture) {
            // Preserve previous retain count
            this.retain_count = previousTexture.retain_count;
            previousTexture.retain_count = 0; // allow to be freed
            previousTexture.destroy();
        }

        // Cache texture instance and definition
        Texture.textures[this.name] = this;
        Texture.texture_configs[this.name] = JSON.stringify(Object.assign({ name }, options));

        this.load(options);
        log('trace', `creating Texture ${this.name}`);
    }

    // Destroy a single texture instance
    destroy(options: {force?: boolean} = {}) {
        if (this.texture_factory) {
            return this.destroyTexture(options);
        }
        return Context.withContext(this.gl, () => this.destroyTexture(options));
    }

    destroyTexture({ force }: {force?: boolean} = {}) {
        if (this.retain_count > 0 && !force) {
            log('error', `Texture '${this.name}': destroying texture with retain count of '${this.retain_count}'`);
            return;
        }

        if (!this.valid) {
            return;
        }
        if (this.texture_resource) {
            this.texture_resource.destroy();
            this.texture_resource = null;
        }
        else {
            getClassicTextureContext(this.gl).deleteTexture(this.texture);
        }
        this.texture = null;
        if (Texture.textures[this.name] === this) {
            delete Texture.textures[this.name];
            delete Texture.texture_configs[this.name];
        }
        this.valid = false;
        log('trace', `destroying Texture ${this.name}`);
    }

    retain () {
        this.retain_count++;
    }

    release () {
        if (this.retain_count <= 0) {
            log('error', `Texture '${this.name}': releasing texture with retain count of '${this.retain_count}'`);
        }

        this.retain_count--;
        if (this.retain_count <= 0) {
            this.destroy();
        }
    }

    bind(unit = 0) {
        if (!this.valid) {
            return;
        }

        if (this.texture_factory) {
            return;
        }

        const gl = getClassicTextureContext(this.gl);
        if (Texture.activeUnit !== unit) {
            gl.activeTexture(gl.TEXTURE0 + unit);
            Texture.activeUnit = unit;
            Texture.boundTexture = null; // texture must be re-bound when unit changes
        }

        if (Texture.boundTexture !== this.texture) {
            gl.bindTexture(gl.TEXTURE_2D, this.texture);
            Texture.boundTexture = this.texture;
        }
    }

    load(options?: TextureOptions): Promise<Texture> {
        if (!options) {
            return this.loading || Promise.resolve(this);
        }

        this.loading = null;
        if (typeof options.url === 'string') {
            this.config_type = 'url';
            this.setUrl(options.url, options);
        } else if (options.element) {
            this.config_type = 'element';
            this.setElement(options.element, options);
        } else if (options.data && options.width && options.height) {
            this.config_type = 'data';
            this.setData(options.width, options.height, options.data, options);
        }

        this.loading =
            (this.getLoadingPromise()?.then(() => { this.calculateSprites(); return this; })) ||
            Promise.resolve(this);
        return this.loading;
    }

    // Sets texture from an url
    setUrl(url: string, options: TextureOptions = {}) {
        if (!this.valid) {
            return;
        }

        this.url = url; // save URL reference (will be overwritten when element is loaded below)

        this.loading = new Promise(resolve => {
            let image = new Image();
            image.onload = () => {
                try {
                    // For data URL images, first draw the image to a separate canvas element. Workaround for
                    // obscure bug seen with small (<28px) SVG images encoded as data URLs in Chrome and Safari.
                    if (this.url.slice(0, 5) === 'data:') {
                        const canvas = document.createElement('canvas');
                        const ctx = canvas.getContext('2d');
                        canvas.width = image.width;
                        canvas.height = image.height;
                        if (!ctx) throw new Error('Texture canvas requires a 2D context');
                        ctx.drawImage(image, 0, 0);
                        this.setElement(canvas, options);
                    }
                    else {
                        this.setElement(image, options);
                    }
                }
                catch (e) {
                    this.loaded = false;
                    log('warn', `Texture '${this.name}': failed to load url: '${this.url}'`, e, options);
                    Texture.trigger('warning', { message: `Failed to load texture from ${this.url}`, error: e, texture: options });
                }

                this.loaded = true;
                resolve(this);
            };
            image.onerror = e => {
                // Warn and resolve on error
                this.loaded = false;
                log('warn', `Texture '${this.name}': failed to load url: '${this.url}'`, e, options);
                Texture.trigger('warning', { message: `Failed to load texture from ${this.url}`, error: e, texture: options });
                resolve(this);
            };

            // Safari has a bug loading data-URL images with CORS enabled, so it must be disabled in that case
            // https://bugs.webkit.org/show_bug.cgi?id=123978
            if (!(Utils.isSafari() && this.url.slice(0, 5) === 'data:')) {
                image.crossOrigin = 'anonymous';
            }

            image.src = this.url;
        });
        return this.loading;
    }

    // Sets texture to a raw image buffer
    setData(width: number, height: number, data: TextureOptions['data'], options: TextureOptions = {}) {
        this.width = width;
        this.height = height;

        // Convert regular array to typed array
        if (Array.isArray(data)) {
            data = new Uint8Array(data);
        }

        this.update(data ?? null, options);
        this.setFiltering(options);

        this.loaded = true;
        this.loading = Promise.resolve(this);
        return this.loading;
    }

    // Sets the texture to track a element (canvas/image)
    setElement(element: string | TextureElement, options: TextureOptions = {}) {
        let el = element;

        // a string element is interpeted as a CSS selector
        if (typeof element === 'string') {
            element = document.querySelector<TextureElement>(element) ?? '';
        }

        if (element instanceof HTMLCanvasElement ||
            element instanceof HTMLImageElement ||
            element instanceof HTMLVideoElement) {
            this.update(element, options);
            this.setFiltering(options);
        }
        else {
            this.loaded = false;
            let msg = `the 'element' parameter (\`element: ${JSON.stringify(el)}\`) must be a CSS `;
            msg += 'selector string, or a <canvas>, <image> or <video> object';
            log('warn', `Texture '${this.name}': ${msg}`, options);
            Texture.trigger('warning', { message: `Failed to load texture because ${msg}`, texture: options });
        }

        this.loaded = true;
        this.loading = Promise.resolve(this);
        return this.loading;
    }

    // Uploads current image or buffer to the GPU (can be used to update animated textures on the fly)
    update(source: TextureSource, options: TextureOptions = {}) {
        if (this.texture_factory) {
            return this.updateTexture(source, options);
        }
        return Context.withContext(this.gl, () => {
            if (Context.hasContextScope(this.gl)) {
                Texture.resetBindings();
            }
            return this.updateTexture(source, options);
        });
    }

    updateTexture(source: TextureSource, options: TextureOptions = {}) {
        if (!this.valid) {
            return;
        }

        if (this.texture_factory) {
            return this.updateTextureResource(source, options);
        }

        this.bind();

        // Image or Canvas element
        const gl = getClassicTextureContext(this.gl);
        if (source instanceof HTMLCanvasElement || source instanceof HTMLVideoElement ||
            (source instanceof HTMLImageElement && source.complete)) {

            this.width = source.width;
            this.height = source.height;
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, (options.UNPACK_FLIP_Y_WEBGL === false ? false : true));
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, options.UNPACK_PREMULTIPLY_ALPHA_WEBGL || false);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        }
        // Raw image buffer
        else {
            // these pixel store params are deprecated for non-DOM element uploads
            // (e.g. when creating texture from raw data)
            // setting them to null avoids a Firefox warning
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
            if (source instanceof HTMLImageElement) throw new Error('Texture image must finish loading before upload');
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
        }

        Texture.trigger('update', this);
    }

    // Replace the injected GPU texture resource because luma.gl texture dimensions are immutable.
    updateTextureResource(source: TextureSource, options: TextureOptions = {}) {
        if (isTextureElement(source)) {
            this.width = source.width;
            this.height = source.height;
        }

        const power_of_2 = Utils.isPowerOf2(this.width) && Utils.isPowerOf2(this.height);
        const filtering = options.filtering === 'mipmap' && !power_of_2 ?
            'linear' : (options.filtering || this.filtering || 'linear');

        const factory = this.texture_factory;
        if (!factory) throw new Error('Texture resource update requires a texture factory');
        const resource = factory({
            id: this.name,
            width: this.width,
            height: this.height,
            data: source ?? undefined,
            filtering,
            repeat: options.repeat === true && power_of_2,
            flipY: options.UNPACK_FLIP_Y_WEBGL !== false,
            premultipliedAlpha: options.UNPACK_PREMULTIPLY_ALPHA_WEBGL === true
        });
        if (!resource || typeof resource.destroy !== 'function') {
            throw new Error(`Texture '${this.name}': texture factory must return a GPU resource`);
        }

        const previous_resource = this.texture_resource;
        this.texture_resource = resource;
        this.texture = resource;
        if (previous_resource) {
            previous_resource.destroy();
        }
        Texture.trigger('update', this);
    }

    // Return the injected GPU resource for renderers that own texture bindings.
    getResource() {
        return this.texture_resource;
    }

    // Determines appropriate filtering mode
    setFiltering(options: TextureOptions = {}) {
        if (this.texture_factory) {
            return this.updateFiltering(options);
        }
        return Context.withContext(this.gl, () => {
            if (Context.hasContextScope(this.gl)) {
                Texture.resetBindings();
            }
            return this.updateFiltering(options);
        });
    }

    updateFiltering(options: TextureOptions = {}) {
        if (!this.valid) {
            return;
        }

        options.filtering = options.filtering || 'linear';

        if (this.texture_resource) {
            this.power_of_2 = Utils.isPowerOf2(this.width) && Utils.isPowerOf2(this.height);
            this.filtering = options.filtering === 'mipmap' && !this.power_of_2 ?
                'linear' : options.filtering;
            Texture.trigger('update', this);
            return;
        }

        const gl = getClassicTextureContext(this.gl);
        this.bind();

        // For power-of-2 textures, the following presets are available:
        // mipmap: linear blend from nearest mip
        // linear: linear blend from original image (no mips)
        // nearest: nearest pixel from original image (no mips, 'blocky' look)
        if (Utils.isPowerOf2(this.width) && Utils.isPowerOf2(this.height)) {
            this.power_of_2 = true;
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, options.TEXTURE_WRAP_S || (options.repeat && gl.REPEAT) || gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, options.TEXTURE_WRAP_T || (options.repeat && gl.REPEAT) || gl.CLAMP_TO_EDGE);

            if (options.filtering === 'mipmap') {
                this.filtering = 'mipmap';
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); // TODO: use trilinear filtering by defualt instead?
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                gl.generateMipmap(gl.TEXTURE_2D);
            }
            else if (options.filtering === 'linear') {
                this.filtering = 'linear';
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            }
            else if (options.filtering === 'nearest') {
                this.filtering = 'nearest';
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            }
        }
        else {
            // WebGL has strict requirements on non-power-of-2 textures:
            // No mipmaps and must clamp to edge
            this.power_of_2 = false;
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

            if (options.filtering === 'nearest') {
                this.filtering = 'nearest';
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            }
            else { // default to linear for non-power-of-2 textures
                this.filtering = 'linear';
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            }
        }

        Texture.trigger('update', this);
    }

    // Pre-calc sprite regions for a texture sprite in UV [0, 1] space
    calculateSprites() {
        if (this.sprites) {
            for (let s in this.sprites) {
                let sprite = this.sprites[s];

                // Map [0, 0] to [1, 1] coords to the appropriate sprite sub-area of the texture
                this.texcoords[s] = Texture.getTexcoordsForSprite(
                    [sprite[0], sprite[1]],
                    [sprite[2], sprite[3]],
                    [this.width, this.height]
                );

                // Pixel size of sprite
                // Divide by native texture density to get correct CSS pixels
                this.sizes[s] = [sprite[2], sprite[3]];
                this.css_sizes[s] = [sprite[2] / this.density, sprite[3] / this.density];
                this.aspects[s] = sprite[2] / sprite[3];
            }
        }
    }

    // Get the tetxure size in bytes
    byteSize() {
        // mipmaps use 33% additional memory
        return Math.round(this.width * this.height * 4 * (this.filtering == 'mipmap' ? 1.33 : 1));
    }

    /** Observe asynchronous updates assigned by load helpers without narrowing them to the prior null value. */
    private getLoadingPromise(): Promise<Texture> | null { return this.loading; }

}


// Static/class methods and state

Texture.create = function (gl, name, options) {
    return new Texture(gl, name, options);
};

Texture.retain = function (name) {
    const texture = Texture.textures[name];
    if (texture && 'retain' in texture) {
        texture.retain();
    }
};

Texture.release = function (name) {
    const texture = Texture.textures[name];
    if (texture && 'release' in texture) {
        texture.release();
    }
};

// Destroy all texture instances for a given GL context
Texture.destroy = function (gl) {
    var textures = Object.keys(Texture.textures);
    textures.forEach(t => {
        var texture = Texture.textures[t];
        if ('gl' in texture && texture.gl === gl) {
            texture.destroy({ force: true });
        }
    });
};

// Get sprite pixel size and UVs
Texture.getSpriteInfo = function (texname, sprite) {
    let texture = Texture.textures[texname];
    return texture && {
        size: texture.sizes[sprite],
        css_size: texture.css_sizes[sprite],
        aspect: texture.aspects[sprite],
        texcoords: texture.texcoords[sprite]
    };
};

// Re-scale UVs from [0, 1] range to a smaller area within the image
Texture.getTexcoordsForSprite = function (area_origin, area_size, tex_size) {
    var area_origin_y = tex_size[1] - area_origin[1] - area_size[1];

    return [
        area_origin[0] / tex_size[0],
        area_origin_y / tex_size[1],
        (area_size[0] + area_origin[0]) / tex_size[0],
        (area_size[1] + area_origin_y) / tex_size[1]
    ];
};

// Create a set of textures keyed in an object
// Optionally load each if it has a URL specified
Texture.createFromObject = function (gl, textures) {
    let loading = [];
    if (textures) {
        for (let texname in textures) {
            let config = textures[texname];

            if (config.skip_create) {
                // explicitly skip (re-)creating this texture
                // used for dynamic canvas textures that we *know* haven't changed
                // (internal raster tiles, vs. user-supplied canvas where pixels may have changed)
                continue;
            }

            // If texture already exists and definition hasn't changed, no need to re-create
            // Note: to avoid flicker when other textures/scene items change
            if (!Texture.changed(texname, config)) {
                continue;
            }

            let texture = Texture.create(gl, texname, config);
            loading.push(texture.loading);
        }
    }
    return Promise.all(loading);
};

// Create a 'default' texture (1x1 pixel) that can be used as a placeholder
// (for example to prevent GL from complaining about unbound textures)
Texture.default = '__default';
Texture.createDefault = function (gl) {
    return Texture.create(gl, Texture.default);
};

// Only include texture-specific properties (avoid faulty equality comparisons between
// textures when caller may include other ancillary props)
Texture.sliceOptions = function(options) {
    return {
        filtering: options.filtering,
        sprites: options.sprites,
        url: options.url,
        element: options.element,
        data: options.data,
        width: options.width,
        height: options.height,
        density: options.density,
        repeat: options.repeat,
        TEXTURE_WRAP_S: options.TEXTURE_WRAP_S,
        TEXTURE_WRAP_T: options.TEXTURE_WRAP_T,
        UNPACK_FLIP_Y_WEBGL: options.UNPACK_FLIP_Y_WEBGL,
        UNPACK_PREMULTIPLY_ALPHA_WEBGL: options.UNPACK_PREMULTIPLY_ALPHA_WEBGL,
        textureFactory: options.textureFactory
    };
};

// Indicate if a texture definition would be a change from the current cache
Texture.changed = function (name, config) {
    let texture = Texture.textures[name];
    if (texture) { // cached texture
        // canvas/image-based textures are considered dynamic and always refresh
        if ('config_type' in texture && texture.config_type === 'element' || config.element != null) {
            return true;
        }

        // compare definitions
        config = Texture.sliceOptions(config); // exclude any non-texture-specific props
        if (Texture.texture_configs[name] === JSON.stringify(Object.assign({ name }, config))) {
            return false;
        }
    }
    return true;
};

// Get metadata for a texture by name
// Returns via promise, in case texture is still loading
// Can be called on main thread from worker, to sync texture info to worker
/** Return one detached metadata record or the requested list, preserving nullable missing names. */
function getTextureInfo(name?: string | string[] | null): Promise<TextureInfoResult> {
    // Get info for all textures by default
    if (!name) {
        name = Object.keys(Texture.textures);
    }

    // Get multiple textures
    if (Array.isArray(name)) {
        return Promise.all(name.map(n => Texture.getInfo(n)));
    }

    // Get single texture
    var tex = Texture.textures[name];
    if (tex) {
        // Wait for this texture to finish loading, or return immediately
        var loading = ('loading' in tex && tex.loading) || Promise.resolve(tex);
        return loading.then(() => {
            // Return a subset of texture info
            // (compatible w/structured cloning, suitable for passing to a worker)
            return {
                name: tex.name,
                width: tex.width,
                height: tex.height,
                density: tex.density,
                css_size: [ tex.width / tex.density, tex.height / tex.density ],
                aspect: tex.width / tex.height,
                sprites: tex.sprites,
                texcoords: tex.texcoords,
                sizes: tex.sizes,
                css_sizes: tex.css_sizes,
                aspects: tex.aspects,
                filtering: tex.filtering,
                power_of_2: tex.power_of_2,
                valid: tex.valid
            };
        });
    }
    else {
        // No texture found
        return Promise.resolve(null);
    }
}
Texture.getInfo = getTextureInfo;

// Sync texture info to worker
// Called from worker, gets info on one or more textures info from main thread via remote call, then stores it
// locally in worker. 'textures' can be an array of texture names to sync, or if null, all textures are synced.
Texture.syncTexturesToWorker = function (names) {
    return WorkerBroker.postMessage('Texture.getInfo', names).
        then(textures => {
            if (Array.isArray(textures)) {
                textures
                    .filter(isTextureInfo) // remove nulls and validate detached metadata
                    .forEach(t => Texture.textures[t.name] = t);
            }
            return Texture.textures;
        });
};

// Report max texture size for a GL context
Texture.getMaxTextureSize = function (gl) {
    const context = getClassicTextureContext(gl);
    return context.getParameter(context.MAX_TEXTURE_SIZE);
};

// Register an injected GPU texture factory for all textures created against a context.
Texture.setResourceFactory = function (gl, texture_factory) {
    if (texture_factory) {
        Texture.resource_factories.set(gl, texture_factory);
    }
};

Texture.getResourceFactory = function (gl) {
    return Texture.resource_factories.get(gl);
};

Texture.clearResourceFactory = function (gl) {
    Texture.resource_factories.delete(gl);
};

// Global set of textures, by name
Texture.textures = {};
Texture.texture_configs = {};
Texture.resource_factories = new WeakMap();
Texture.boundTexture = null;
Texture.activeUnit = null;
Texture.resetBindings = function () {
    Texture.boundTexture = null;
    Texture.activeUnit = null;
};

WorkerBroker.addTarget('Texture', Texture);
subscribeMixin(Texture);

/** The broker returns unknown; recognize detached metadata, never invent live GPU methods. */
function isTextureInfo(value: unknown): value is TextureInfo {
    return typeof value === 'object' && value !== null &&
        'name' in value && typeof value.name === 'string' &&
        'width' in value && typeof value.width === 'number' &&
        'height' in value && typeof value.height === 'number' &&
        'density' in value && typeof value.density === 'number' &&
        'valid' in value && typeof value.valid === 'boolean' &&
        ['texcoords', 'sizes', 'css_sizes', 'aspects'].every(key => typeof Reflect.get(value, key) === 'object' && Reflect.get(value, key) !== null);
}

/** Portable contexts are opaque/null; only the classic path may require texture GL operations. */
function getClassicTextureContext(context: object | null): WebGLRenderingContext {
    if (isClassicTextureContext(context)) return context;
    throw new Error('Classic textures require a WebGL context');
}
/** Narrow the classic texture capability boundary while allowing hermetic structural GL fixtures. */
function isClassicTextureContext(context: object | null): context is WebGLRenderingContext {
    return context !== null && 'createTexture' in context && typeof context.createTexture === 'function' &&
        'texImage2D' in context && typeof context.texImage2D === 'function';
}

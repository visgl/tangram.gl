// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import gl from './constants'; // web workers don't have access to GL context, so import all GL constants
import VertexData from './vertex_data';
import hashString from '../utils/hash';
import type {VertexFormat} from '@luma.gl/core';
import type {VertexAttribute, AddVertexFunction, VertexAttributeProgram, VertexAttributeContext, VertexBufferLayout} from './vertex-types';
type VertexComponent = {type: number; shift: number; offset: number; index: number};

// Describes a vertex layout that can be used with many different GL programs.
export default class VertexLayout {
    static enabled_attribs: Record<string, VertexAttributeProgram> = {};
    static add_vertex_funcs: Record<number, AddVertexFunction> = {};
    attribs: VertexAttribute[];
    dynamic_attribs: VertexAttribute[];
    static_attribs: VertexAttribute[];
    components: VertexComponent[];
    index: Record<string, number>;
    offset: Record<string, number>;
    stride: number;
    addVertex?: AddVertexFunction;
    // Attribs are an array, in layout order, of: name, size, type, normalized
    // ex: { name: 'position', size: 3, type: gl.FLOAT, normalized: false }
    constructor (attribs: VertexAttribute[]) {
        this.attribs = attribs; // array of attributes, specified as standard GL attrib options
        this.dynamic_attribs = this.attribs.filter(x => x.static == null); // attributes with per-vertex values, used to build VBOs
        this.static_attribs = this.attribs.filter(x => x.static != null); // attributes with fixed values
        this.components = [];   // list of type and offset info about each attribute component
        this.index = {};        // JS buffer index of each attribute component, e.g. this.index.position
        this.offset = {};       // VBO buffer byte offset of each attribute component, e.g. this.offset.color
        this.stride = 0;        // byte stride of a single vertex

        let index = 0, count = 0;
        for (let a=0; a < this.attribs.length; a++) {
            let attrib = this.attribs[a];
            // Dynamic attribute
            if (attrib.static == null) {
                attrib.offset = this.stride;
                attrib.byte_size = attrib.size;
                let shift = 0;

                switch (attrib.type) {
                case gl.FLOAT:
                case gl.INT:
                case gl.UNSIGNED_INT:
                    attrib.byte_size *= 4;
                    shift = 2;
                    break;
                case gl.SHORT:
                case gl.UNSIGNED_SHORT:
                    attrib.byte_size *= 2;
                    shift = 1;
                    break;
                }

                // Force 4-byte alignment on attributes
                if (attrib.byte_size & 3) { // pad to multiple of 4 bytes
                    attrib.byte_size += 4 - (attrib.byte_size & 3);
                }
                this.stride += attrib.byte_size;

                // Add info to list of attribute components (e.g. float is 1 component, vec3 is 3 separate components)
                // Used to map plain JS array to typed arrays
                let offset_typed = attrib.offset >> shift;
                for (let s=0; s < attrib.size; s++) {
                    this.components.push({
                        type: attrib.type,
                        shift,
                        offset: offset_typed++,
                        index: count++
                    });
                }

                // Provide an index into the vertex data buffer for each attribute by name
                this.index[attrib.name] = index;
                index += attrib.size;

                // Store byte offset of each attribute by name
                this.offset[attrib.name] = attrib.offset;
            }
            // Static attribute
            else {
                attrib.static = Array.isArray(attrib.static) ? attrib.static : [attrib.static]; // convert single value to array
                attrib.method = `vertexAttrib${attrib.static.length}fv`;
            }
        }
    }

    // Enables dynamic (array-based) attributes for a given GL program
    // Assumes that the desired vertex buffer (VBO) is already bound
    // If the program doesn't include all attributes, it can still use the vertex layout
    // to read those attribs that it does recognize, using the attrib offsets to skip others.
    enableDynamicAttributes (gl: VertexAttributeContext, program: VertexAttributeProgram): void {
        // Disable all attributes
        for (const location in VertexLayout.enabled_attribs) {
            // Object keys are numeric strings; WebGL performs the existing numeric coercion.
            gl.disableVertexAttribArray(location as unknown as number);
        }
        VertexLayout.enabled_attribs = {};

        // Enable dynamic attributes for this layout
        this.dynamic_attribs.forEach(attrib => {
            const location = program.attribute(attrib.name).location;
            if (location !== -1) {
                gl.enableVertexAttribArray(location);
                gl.vertexAttribPointer(location, attrib.size, attrib.type, attrib.normalized!, this.stride, attrib.offset!);
                VertexLayout.enabled_attribs[location] = program;
            }
        });
    }

    // Enable static attributes for this layout. Since these aren't captured as part of Vertex Array Object state,
    // they are enabled separately.
    enableStaticAttributes (gl: VertexAttributeContext, program: VertexAttributeProgram): void {
        this.static_attribs.forEach(attrib => {
            const location = program.attribute(attrib.name).location;
            if (location !== -1 && gl[attrib.method!] instanceof Function) {
                // N.B.: Safari appears to require an explicit array enable to set vertex attribute as "active"
                // (the static attribute value method does not work without it). So the attribute is temporarily
                // enabled as an array, then disabled.
                gl.enableVertexAttribArray(location);
                gl[attrib.method!]!(location, attrib.static as number[]);
                gl.disableVertexAttribArray(location);
            }
        });
    }

    createVertexData (): VertexData {
        return new VertexData(this);
    }

    // Return a luma.gl-compatible description of the interleaved vertex buffer.
    // Static attributes are omitted because they are supplied independently of the buffer.
    getBufferLayout (name = 'vertices'): VertexBufferLayout {
        return {
            name,
            byteStride: this.stride,
            attributes: this.dynamic_attribs.map(attrib => ({
                attribute: attrib.name,
                format: getVertexFormat(attrib),
                byteOffset: attrib.offset!
            }))
        };
    }

    // Return constant vertex attributes for renderers that don't use Tangram's VAO wrapper.
    getStaticAttributes (): {attribute: string; value: number[]}[] {
        return this.static_attribs.map(attrib => ({
            attribute: attrib.name,
            value: (attrib.static as number[]).slice()
        }));
    }

    // Lazily create the add vertex function
    getAddVertexFunction (): AddVertexFunction {
        if (this.addVertex == null) {
            this.createAddVertexFunction();
        }
        return this.addVertex!;
    }

    // Dynamically compile a function to add a plain JS vertex array to this layout's typed VBO arrays
    createAddVertexFunction () {
        const key = hashString(JSON.stringify(this.attribs));
        if (VertexLayout.add_vertex_funcs[key] == null) {
            // `t` = current typed array to write to
            // `o` = current offset into VBO, in current type size (e.g. divide 2 for shorts, divide by 4 for floats, etc.)
            // `v` = plain JS array containing vertex data
            // `vs` = typed arrays (one per GL type needed for this vertex layout)
            // `off` = current offset into VBO, in bytes
            let src: string[] | string = ['var t, o;'];

            // Sort by array type to reduce redundant array look-up and offset calculation
            let last_type;
            let components = [...this.components];
            components.sort((a, b) => (a.type !== b.type) ? (a.type - b.type) : (a.index - b.index));

            for (let c=0; c < components.length; c++) {
                let component = components[c];

                if (last_type !== component.type) {
                    src.push(`t = vs[${component.type}];`);
                    src.push(`o = off${component.shift ? ' >> ' + component.shift : ''};`);
                    last_type = component.type;
                }

                src.push(`t[o + ${component.offset}] = v[${component.index}];`);
            }

            src = src.join('\n');
            const func = new Function('v', 'vs', 'off', src) as AddVertexFunction; // Generated writer follows the component layout above.
            VertexLayout.add_vertex_funcs[key] = func;
        }

        this.addVertex = VertexLayout.add_vertex_funcs[key];
    }
}

function getVertexFormat(attrib: VertexAttribute): VertexFormat {
    let type: string;
    switch (attrib.type) {
    case gl.BYTE:
        type = attrib.normalized ? 'snorm8' : 'sint8';
        break;
    case gl.UNSIGNED_BYTE:
        type = attrib.normalized ? 'unorm8' : 'uint8';
        break;
    case gl.SHORT:
        type = attrib.normalized ? 'snorm16' : 'sint16';
        break;
    case gl.UNSIGNED_SHORT:
        type = attrib.normalized ? 'unorm16' : 'uint16';
        break;
    case gl.INT:
        type = 'sint32';
        break;
    case gl.UNSIGNED_INT:
        type = 'uint32';
        break;
    case gl.FLOAT:
        type = 'float32';
        break;
    default:
        throw new Error(`VertexLayout: unsupported attribute type ${attrib.type}`);
    }

    if (attrib.size === 1) {
        return type as VertexFormat; // The switch restricts the scalar format to luma's supported GL types.
    }
    if (attrib.size < 2 || attrib.size > 4) {
        throw new Error(`VertexLayout: unsupported attribute size ${attrib.size}`);
    }
    const webgl_only = attrib.size === 3 && attrib.type !== gl.FLOAT &&
        attrib.type !== gl.INT && attrib.type !== gl.UNSIGNED_INT;
    return `${type}x${attrib.size}${webgl_only ? '-webgl' : ''}` as VertexFormat; // Validated component size/type above.
}

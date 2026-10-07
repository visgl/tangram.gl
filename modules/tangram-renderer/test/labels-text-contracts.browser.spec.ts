// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, beforeEach, describe, expect, expectTypeOf, test, vi} from 'vitest';
import Label from '../src/labels/label';
import LabelPoint from '../src/labels/label_point';
import LabelLine, {LabelLineBase, LabelLineStraight} from '../src/labels/label_line';
import mainThreadLabelCollisionPass from '../src/labels/main_pass';
import type {LabelTile, LabelMesh} from '../src/labels/main-pass-types';
import type {LabelPointCoordinate} from '../src/labels/label-types';
import Collision from '../src/labels/collision';
import RepeatGroup from '../src/labels/repeat_group';
import OBB from '../src/utils/obb';
import Utils from '../src/utils/utils';
import Task from '../src/utils/task';
import type {TaskRecord} from '../src/utils/task';
import WorkerBroker from '../src/utils/worker_broker';
import Texture from '../src/gl/texture';
import TextCanvas from '../src/styles/text/text_canvas';
import type {TextTable, TextSizesTask, TextRasterTask, TextLabelCandidate} from '../src/styles/text/text-types';
import {createLabelLayout, createTextTile, createTextQueue, createTextFeature, createTextContext, createTextSettings, createTextInfo, createTextStyle, createTextSize} from './text-test-fixtures';

const broker = WorkerBroker;
const textureRegistry = Texture as unknown as {
    create(...arguments_: unknown[]): unknown;
    retain(name: string): void;
    release(name: string): void;
};
const initialIdentifier = {id: Label.id, prefix: Label.id_prefix, multiplier: Label.id_multiplier};

beforeEach(() => {
    Label.id = 0;
    Label.id_prefix = 1;
    Label.id_multiplier = 1;
    Collision.tiles = {};
    Collision.initGrid();
    RepeatGroup.groups = {};
});

afterEach(() => {
    vi.restoreAllMocks();
    Label.id = initialIdentifier.id;
    Label.id_prefix = initialIdentifier.prefix;
    Label.id_multiplier = initialIdentifier.multiplier;
});

/** Mesh fixture using the actual worker serialization contract. */
function createLabelMesh(label: LabelPoint | LabelLineStraight): LabelMesh {
    return {
        valid: true, labels: {[label.id]: {container: {label: label.toJSON(), linked: null}, ranges: [[0, 2]]}},
        vertex_layout: {offset: {a_shape: 0}, stride: 8},
        vertex_data: new Uint8Array(16), upload: vi.fn()
    };
}

/** Main-pass tile using deterministic Mercator units and no proxy state. */
function createLabelTile(meshes: LabelMesh[]): LabelTile {
    return {
        coords: {z: 10}, style_z: 10, build_id: 1, min: {x: 0, y: 0}, span: {x: 1000},
        meshes: {text: meshes}, pending_label_meshes: {}, isProxy: () => false, swapPendingLabels: vi.fn()
    };
}

describe('checked label geometry and worker snapshots', () => {
    test('typing declarations do not add own properties or mask inherited hooks', () => {
        const label = new LabelLineBase(createLabelLayout());
        expect(Object.keys(label)).toEqual(['id', 'layout', 'position', 'angle', 'offset', 'unit_scale', 'obbs', 'aabbs', 'type', 'throw_away']);
        expect(Object.hasOwn(label, 'mayRepeatAcrossTiles')).toBe(false);
        const canvas = new TextCanvas();
        expect(Object.keys(canvas)).toEqual(['canvas', 'context', 'vertical_text_buffer', 'horizontal_text_buffer', 'background_size']);
        expect(Object.hasOwn(canvas, 'px_size')).toBe(false);
    });

    test('serializes only the collision layout subset and preserves source arrays', () => {
        const position: LabelPointCoordinate = [100, -100];
        const layout = createLabelLayout({repeat_distance: 25, repeat_group: 'places'});
        const label = new LabelPoint(position, [20, 10], layout);
        const snapshot = label.toJSON();
        expectTypeOf(snapshot.position).toEqualTypeOf<LabelPointCoordinate>();
        expect(snapshot.layout).toEqual({priority: 0, collide: false, repeat_distance: 25, repeat_group: 'places', buffer: [0, 0], italic: undefined});
        expect(snapshot.layout).not.toHaveProperty('repeat_scale');
        expect(position).toEqual([100, -100]);
        expect(snapshot.obb).toEqual(label.obb?.toJSON());
    });

    test('tries alternate anchors without changing the shared input layout', () => {
        const layout = createLabelLayout({anchor: ['center', 'left'], collide: true});
        const label = new LabelPoint([100, -100], [40, 10], layout);
        const blocker = new OBB(115, -100, 10, 10, 10);
        expect(label.discard({aabb: [blocker.getExtent()], obb: [blocker]})).toBe(false);
        expect(label.anchor).toBe('left');
        expect(layout.anchor).toEqual(['center', 'left']);
        expect(layout.offset).toEqual([0, 0]);
    });

    test('ignores a linked parent box and accepts degenerate point labels', () => {
        const layout = createLabelLayout({collide: true});
        const parent = new LabelPoint([100, -100], [20, 10], layout);
        const child = new LabelPoint([100, -100], [20, 10], layout);
        const boxes = {aabb: [parent.aabb!], obb: [parent.obb!]};
        expect(child.discard(boxes)).toBe(true);
        expect(child.discard(boxes, parent)).toBe(false);
        expect(new LabelPoint([100, -100], [0, 0], layout).discard(boxes)).toBe(false);
    });

    test('retains straight fitting, vertical orientation and fractional-zoom curved samples', () => {
        const layout = createLabelLayout();
        const vertical = new LabelLineStraight([20, 5], [[100, -100], [100, -300]], layout, 1.5);
        expect(vertical.throw_away).toBe(false);
        expect(vertical.angle).toBeCloseTo(-Math.PI / 2);
        const line: LabelPointCoordinate[] = [[100, -100], [200, -100], [280, -140], [400, -140]];
        const curved = LabelLine.create([[25, 5], [25, 5]], [250, 5], line, layout);
        expect(curved && curved.type).toBe('curved');
        if (!curved || !('angles' in curved)) throw new Error('Expected articulated fixture');
        expect(curved.angles).toHaveLength(2);
        expect(curved.angles.every(samples => samples.length === 4)).toBe(true);
        // Legacy fitting repeats the base-stop boxes once per segment; preserve that shape in this typing PR.
        expect(curved.toJSON().obbs).toHaveLength(4);
        expect(curved.toJSON()).not.toHaveProperty('angles');
    });

    test('reconstructs worker labels, resolves links and uploads visibility bytes only once', async () => {
        const first = new LabelPoint([100, -100], [20, 10], createLabelLayout());
        const second = new LabelPoint([100, -100], [20, 10], createLabelLayout());
        const firstMesh = createLabelMesh(first);
        const secondMesh = createLabelMesh(second);
        secondMesh.labels![second.id].container.linked = first.id;
        const tile = createLabelTile([firstMesh, secondMesh]);
        const snapshots = structuredClone([firstMesh.labels, secondMesh.labels]);
        const firstPass = await mainThreadLabelCollisionPass([tile], 10);
        expect(firstPass.containers[1].linked).toBe(firstPass.containers[0]);
        expect(firstMesh.vertex_data[6]).toBe(1);
        expect(firstMesh.vertex_data[14]).toBe(1);
        expect(firstMesh.upload).toHaveBeenCalledTimes(1);
        expect([firstMesh.labels, secondMesh.labels]).toEqual(snapshots);
        await mainThreadLabelCollisionPass([tile], 10);
        expect(firstMesh.upload).toHaveBeenCalledTimes(1);
        expect(tile.swapPendingLabels).toHaveBeenCalledTimes(2);
    });

    test('does not upload invalid meshes or reveal never-visible proxy labels', async () => {
        const mesh = createLabelMesh(new LabelPoint([100, -100], [20, 10], createLabelLayout()));
        mesh.valid = false;
        const tile = createLabelTile([mesh]);
        await mainThreadLabelCollisionPass([tile], 10);
        expect(mesh.upload).not.toHaveBeenCalled();
        const proxyMesh = createLabelMesh(new LabelPoint([100, -100], [20, 10], createLabelLayout()));
        const proxyTile = createLabelTile([proxyMesh]);
        proxyTile.isProxy = () => true;
        expect((await mainThreadLabelCollisionPass([proxyTile], 10)).labels).toEqual([]);
        expect(proxyMesh.upload).not.toHaveBeenCalled();
    });

    test('accepts tiles after pending label meshes have been swapped to null', async () => {
        const mesh = createLabelMesh(new LabelPoint([100, -100], [20, 10], createLabelLayout()));
        const tile = createLabelTile([mesh]);
        tile.pending_label_meshes = null;
        expect((await mainThreadLabelCollisionPass([tile], 10)).labels).toHaveLength(1);
        expect(tile.swapPendingLabels).toHaveBeenCalledOnce();
    });

    test('preserves the legacy ignored zero-ID link without fabricating a dependency', async () => {
        Label.id_prefix = 0;
        const first = new LabelPoint([100, -100], [20, 10], createLabelLayout());
        const second = new LabelPoint([100, -100], [20, 10], createLabelLayout());
        const firstMesh = createLabelMesh(first);
        const secondMesh = createLabelMesh(second);
        secondMesh.labels![second.id].container.linked = first.id;
        const result = await mainThreadLabelCollisionPass([createLabelTile([firstMesh, secondMesh])], 10);
        expect(result.containers[1].linked).toBe(0);
        expect(result.labels).toHaveLength(2);
    });
});

describe('checked text source and worker handoff contracts', () => {
    test('preserves lookup/fallback callbacks and boundary-label repeat grouping', () => {
        const style = createTextStyle();
        const feature = createTextFeature();
        feature.properties.alt = 'Alternative';
        const context = createTextContext();
        expect(style.parseTextSource(feature, {text_source: ['missing', 'alt', 'name']}, context)).toBe('Alternative');
        expect(style.parseTextSource(feature, {text_source: () => 'Computed'}, context)).toBe('Computed');
        expect(style.parseTextSource(feature, {text_source: {left: 'name', right: 'alt'}}, context)).toEqual({left: 'Cafe', right: 'Alternative'});
        const parsed = style.parseTextFeature(feature, {
            font: {size: '12px'}, text_source: {left: 'name', right: 'alt'}, repeat_group: 'boundaries'
        }, {...context, geometry: 'line'}, context.tile);
        expect(Array.isArray(parsed)).toBe(true);
        if (!Array.isArray(parsed)) throw new Error('Expected boundary labels');
        expect(parsed.map(candidate => candidate.layout.orientation)).toEqual([-1, 1]);
        expect(parsed.map(candidate => candidate.layout.repeat_group)).toEqual(['boundaries/Cafe-Alternative/Cafe', 'boundaries/Cafe-Alternative/Alternative']);
    });

    test('retains falsy fallback behavior and empty-source omission', () => {
        const style = createTextStyle();
        const feature = createTextFeature();
        feature.properties.zero = 0;
        const context = createTextContext();
        expect(style.parseTextSource(feature, {text_source: ['zero', 'name']}, context)).toBe('Cafe');
        expect(style.parseTextSource(feature, {text_source: 'zero'}, context)).toBe(0);
        expect(style.parseTextFeature(feature, {text_source: 'missing'}, context, context.tile)).toBeUndefined();
    });

    test('measures remotely then builds candidates from the returned cache', async () => {
        const style = createTextStyle();
        const texts: TextTable = {regular: {Cafe: createTextInfo()}};
        style.texts.tile = texts;
        const post = vi.spyOn(broker, 'postMessage').mockResolvedValue(texts);
        const queue = createTextQueue();
        const labels = await style.prepareTextLabels(createTextTile(), [queue]);
        expect(labels).toHaveLength(1);
        expect(labels[0].feature).toBe(queue.feature);
        expect(post).toHaveBeenCalledWith('styles.text-test.calcTextSizes', 'tile', texts);
    });

    test.each(['missing', 'rejected', 'canceled'] as const)('does not build after %s measurement', async failure => {
        const style = createTextStyle();
        style.texts.tile = {regular: {Cafe: createTextInfo()}};
        const post = vi.spyOn(broker, 'postMessage');
        if (failure === 'rejected') post.mockRejectedValue(new Error('Style removed'));
        else post.mockResolvedValue(failure === 'missing' ? undefined : style.texts.tile);
        const build = vi.spyOn(style, 'buildTextLabels');
        const abort = vi.spyOn(Collision, 'abortTile');
        expect(await style.prepareTextLabels(createTextTile({canceled: failure === 'canceled'}), [createTextQueue()])).toEqual([]);
        expect(build).not.toHaveBeenCalled();
        expect(abort).toHaveBeenCalledTimes(failure === 'canceled' ? 0 : 1);
    });

    test('culls unused strings and transfers visible atlas ownership', async () => {
        const style = createTextStyle();
        const candidate: TextLabelCandidate = {...createTextQueue(), label: new LabelPoint([100, -100], [20, 10], createLabelLayout())};
        const texts: TextTable = {regular: {Cafe: createTextInfo(), Unused: createTextInfo()}, unused: {Other: createTextInfo()}};
        style.texts.tile = texts;
        vi.spyOn(style, 'prepareTextLabels').mockResolvedValue([candidate]);
        const post = vi.spyOn(broker, 'postMessage').mockResolvedValue({texts, textures: ['atlas-0']});
        Collision.startTile('tile');
        Collision.addStyle('text', 'tile');
        const result = await style.collideAndRenderTextLabels(createTextTile(), 'text', [candidate]);
        expect(result.labels?.[0]).toBe(candidate);
        expect(result.textures).toEqual(['atlas-0']);
        expect(texts).not.toHaveProperty('unused');
        expect(texts.regular).not.toHaveProperty('Unused');
        expect(texts.regular.Cafe.align).toHaveProperty('center');
        expect(post).toHaveBeenCalledWith('styles.text-test.rasterizeTexts', 'tile', '0/0/0', texts);
    });

    test('drops canceled rasterization results without returning texture ownership', async () => {
        const style = createTextStyle();
        const tile = createTextTile();
        const candidate: TextLabelCandidate = {...createTextQueue(), label: new LabelPoint([100, -100], [20, 10], createLabelLayout())};
        style.texts.tile = {regular: {Cafe: createTextInfo()}};
        vi.spyOn(style, 'prepareTextLabels').mockResolvedValue([candidate]);
        vi.spyOn(broker, 'postMessage').mockImplementation(async () => {tile.canceled = true; return {textures: ['late-atlas']};});
        Collision.startTile('tile');
        Collision.addStyle('text', 'tile');
        expect(await style.collideAndRenderTextLabels(tile, 'text', [candidate])).toEqual({});
    });
});

describe('checked canvas tasks and atlas contracts', () => {
    test.each([
        [null, undefined], ['garbage', 0], ['1.5em', 24], ['12pt', 16], ['100%', 16], [12, 12], ['-12px', 12]
    ])('preserves legacy font conversion for %s', (input, expected) => {
        expect(TextCanvas.fontPixelSize(input)).toBe(expected == null ? expected : expected * Utils.device_pixel_ratio!);
    });

    test('packs independent alignments and articulated segments across bounded atlases', () => {
        const canvas = new TextCanvas();
        const texts: TextTable = {regular: {
            Cafe: createTextInfo({size: createTextSize([60, 60]), align: {left: {}, right: {}}}),
            Road: createTextInfo({size: createTextSize([80, 60]), text_settings: createTextSettings({can_articulate: true}),
                type: ['straight', 'curved'], segments: ['Ro', 'ad'], segment_sizes: [createTextSize([40, 60]), createTextSize([40, 60])]})
        }};
        const atlases = canvas.setTextureTextPositions(texts, 128);
        expect(atlases.length).toBeGreaterThan(1);
        expect(atlases.every(atlas => atlas.texture_size[0] <= 128 && atlas.texture_size[1] <= 128)).toBe(true);
        expect(texts.regular.Cafe.align?.left.texture_position).not.toEqual(texts.regular.Cafe.align?.right.texture_position);
        expect(texts.regular.Road.textures).toHaveLength(2);
    });

    test('resumes measurement after a scheduler yield without skipping entries', () => {
        const canvas = new TextCanvas();
        const texts: TextTable = {regular: {Cafe: createTextInfo(), Other: createTextInfo()}};
        const task: TextSizesTask = {
            run: () => undefined, texts, cursor: {styles: ['regular'], texts: null, style_idx: 0, text_idx: null}
        };
        const shouldContinue = vi.spyOn(Task, 'shouldContinue').mockReturnValueOnce(false).mockReturnValue(true);
        const finish = vi.spyOn(Task, 'finish').mockImplementation(task => task.promise!);
        expect(canvas.processTextSizesTask(task)).toBe(false);
        expect(task.cursor.text_idx).toBe(1);
        expect(canvas.processTextSizesTask(task)).toBe(true);
        expect(finish).toHaveBeenCalledWith(task, texts);
        expect(shouldContinue).toHaveBeenCalled();
        expect(texts.regular.Cafe.size?.texture_size[0]).toBeGreaterThan(0);
        expect(texts.regular.Other.size?.texture_size[0]).toBeGreaterThan(0);
    });

    test('rasterizes retained textures and releases only allocated names on cancellation', () => {
        const canvas = new TextCanvas();
        const texts: TextTable = {regular: {Cafe: createTextInfo({align: {center: {}}})}};
        const textures = canvas.setTextureTextPositions(texts, 128);
        const task: TextRasterTask = {
            run: () => undefined, texts, textures, texture_prefix: 'atlas-', resource_context: {}, tile_id: 'tile',
            cursor: {styles: ['regular'], texts: null, style_idx: 0, text_idx: null, texture_idx: 0, texture_resize: true, texture_names: []}
        };
        vi.spyOn(Task, 'shouldContinue').mockReturnValue(true);
        vi.spyOn(Task, 'finish').mockImplementation(task => task.promise!);
        vi.spyOn(textureRegistry, 'create').mockImplementation(() => undefined);
        const retain = vi.spyOn(textureRegistry, 'retain').mockImplementation(() => {});
        const release = vi.spyOn(textureRegistry, 'release').mockImplementation(() => {});
        expect(canvas.processRasterizeTask(task)).toBe(true);
        expect(retain).toHaveBeenCalledWith('atlas-0');
        expect(texts.regular.Cafe.align?.center.texcoords).toHaveLength(4);
        canvas.cancelRasterizeTask(task);
        expect(release.mock.calls).toEqual([['atlas-0']]);
    });

    test('retains typed scheduler result contracts', () => {
        expectTypeOf<TextSizesTask>().toExtend<TaskRecord<TextTable>>();
        expectTypeOf<TextRasterTask>().toExtend<TaskRecord<string[]>>();
    });
});

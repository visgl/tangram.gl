// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

/*jshint worker: true*/

import Scene from './scene/classic_scene';
import ClassicWebGLRenderer from './scene/renderer';
import HostFrame from './scene/host_frame';
import LumaDeviceRenderer from './gpu/luma_device_renderer';
export type {HostTileResourceOptions, TileResourceStatistics, TileSourceStatistics} from './types';
export type {MeshProjectionStatistics} from './procedures/mesh-projector';

// Additional modules are exposed for debugging
import version from './utils/version';
import log from './utils/log';
import Utils from './utils/utils';
import Geo from './utils/geo';
import Vector from './utils/vector';
import DataSource from './sources/data_source';
import GLSL from './gl/glsl';
import ShaderProgram from './gl/shader_program';
import UniformBuffer from './gl/uniform_buffer';
import VertexData from './gl/vertex_data';
import Texture from './gl/texture';
import Material from './lights/material';
import Light from './lights/light';
import WorkerBroker from './utils/worker_broker';
import Task from './utils/task';
import {StyleManager} from './styles/style_manager';
import StyleParser from './styles/style_parser';
import {TileID} from './tile/tile_id';
import Collision from './labels/collision';
import FeatureSelection from './selection/selection';
import TextCanvas from './styles/text/text_canvas';
import debugSettings from './utils/debug_settings';
import {
    WebMercatorGlobeVisibilityAdapter,
    WebMercatorVisibilityAdapter
} from './scene/visibility_adapter';

import yaml from 'js-yaml';

// Make some modules accessible for debugging
const debug = {
    log,
    yaml,
    Utils,
    Geo,
    Vector,
    DataSource,
    GLSL,
    ShaderProgram,
    UniformBuffer,
    VertexData,
    Texture,
    Material,
    Light,
    Scene,
    ClassicWebGLRenderer,
    HostFrame,
    LumaDeviceRenderer,
    WorkerBroker,
    Task,
    StyleManager,
    StyleParser,
    TileID,
    Collision,
    FeatureSelection,
    TextCanvas,
    debugSettings
};

const Tangram = {
    Scene,
    ClassicWebGLRenderer,
    Renderer: ClassicWebGLRenderer,
    HostFrame,
    LumaDeviceRenderer,
    debug,
    version
};

export {WebMercatorGlobeVisibilityAdapter, WebMercatorVisibilityAdapter};
export {calculatePlanarGroundBounds} from './scene/ground_footprint';
export {convertLumaLight, mapTangramLight} from './lights/light-definitions';
export type {ResolvedTangramLight, TangramLightMapping, TangramLight, TangramAmbientLight,
    TangramDirectionalLight, TangramPointLight, TangramSpotLight, TangramLightExtensions,
    TangramPositionalLightExtensions, TangramLightColor, NormalizedTangramLight} from './lights/light-definitions';
export type {Light as LumaLight} from '@luma.gl/shadertools';
export type {TangramTileSourceMetadata} from './sources/tile_source_metadata';
export type {
    CalculatedViewBounds,
    GlobeVisibilityLODAdapter,
    GlobeVisibilityViewState,
    VisibilityLODAdapter,
    VisibilityViewState
} from './scene/visibility_adapter';

export default Tangram;

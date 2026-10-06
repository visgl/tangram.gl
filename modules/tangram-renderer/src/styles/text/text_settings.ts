// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import Utils from '../../utils/utils';
import StyleParser from '../style_parser';

type TextColorValue = unknown;

interface TextFontStroke {
    color?: TextColorValue;
    alpha?: TextColorValue;
    width?: TextColorValue;
}

interface TextFontBackground {
    color?: TextColorValue;
    alpha?: TextColorValue;
    width?: TextColorValue;
    stroke?: TextFontStroke;
}

interface TextFont {
    fill?: TextColorValue;
    alpha?: TextColorValue;
    stroke?: TextFontStroke;
    underline?: boolean;
    background?: TextFontBackground;
    weight?: TextColorValue;
    family?: string;
    style?: string;
    transform?: string;
    px_size?: TextColorValue;
    size?: TextColorValue;
}

export interface TextDraw {
    font?: TextFont;
    supersample_text?: boolean;
    can_articulate?: boolean;
    text_wrap?: boolean | number;
    max_lines?: number;
}

export interface TextSettingsResult {
    style?: string;
    weight?: string | number;
    px_size?: number;
    family?: string;
    fill?: string;
    stroke?: string;
    stroke_width?: number;
    underline_width?: number;
    background_color?: string;
    background_width?: number;
    background_stroke_color?: string;
    background_stroke_width?: number;
    transform?: string;
    text_wrap?: boolean | number;
    max_lines?: number;
    supersample: number;
    can_articulate?: boolean;
    font_css?: string;
}

interface TextSettingsContext {
    [key: string]: unknown;
}

interface StyleParserApi {
    zeroPair: readonly [number, number];
    evalCachedProperty(value: unknown, context: unknown): unknown;
    evalCachedColorPropertyWithAlpha(value: unknown, alpha: unknown, context: unknown): number[] | false | null | undefined;
}

const typedStyleParser = StyleParser as unknown as StyleParserApi;

function toCssColor(value: number[] | false | null | undefined): string | undefined {
    return Array.isArray(value) ? Utils.toCSSColor(value) : undefined;
}

const TextSettings = {

    // A key for grouping all labels of the same text style (e.g. same Canvas state, to minimize state changes)
    key (settings: TextSettingsResult): string {
        return [
            settings.style,
            settings.weight,
            settings.family,
            settings.px_size,
            settings.fill,
            settings.stroke,
            settings.stroke_width,
            settings.underline_width,
            settings.background_color,
            settings.background_width,
            settings.background_stroke_color,
            settings.background_stroke_width,
            settings.transform,
            settings.text_wrap,
            settings.max_lines,
            settings.supersample,
            Utils.device_pixel_ratio
        ].join('/');
    },

    defaults: {
        style: 'normal',
        weight: 'normal',
        size: '12px',
        px_size: 12,
        family: 'Helvetica',
        fill: [1, 1, 1, 1],
        text_wrap: 15,
        max_lines: 5,
        align: 'center'
    },

    compute (draw: TextDraw, context: TextSettingsContext): TextSettingsResult {
        const style: TextSettingsResult = {supersample: 1};

        draw.font = draw.font || this.defaults;

        style.supersample = draw.supersample_text ? 1.5 : 1; // optionally render text at 150% to improve clarity

        // LineString labels can articulate while point labels cannot. Needed for future texture coordinate calculations.
        style.can_articulate = draw.can_articulate;

        // Text fill
        const fillColor = typedStyleParser.evalCachedColorPropertyWithAlpha(draw.font.fill, draw.font.alpha, context);
        style.fill = toCssColor(fillColor); // convert to CSS for Canvas

        // Text stroke
        if (draw.font.stroke && draw.font.stroke.color) {
            style.stroke = toCssColor(typedStyleParser.evalCachedColorPropertyWithAlpha(draw.font.stroke.color, draw.font.stroke.alpha, context)); // convert to CSS for Canvas
            style.stroke_width = typedStyleParser.evalCachedProperty(draw.font.stroke.width, context) as number;
        }

        // Text underline
        if (draw.font.underline === true && !style.can_articulate) {
            style.underline_width = 1.5 * style.supersample;
        }

        // Background box
        if (draw.font.background && !style.can_articulate) { // supported for point labels only
            // Background fill
            style.background_color = toCssColor(typedStyleParser.evalCachedColorPropertyWithAlpha(draw.font.background.color, draw.font.background.alpha, context)); // convert to CSS for Canvas
            if (style.background_color) {
                style.background_width = typedStyleParser.evalCachedProperty(draw.font.background.width, context) as number;
            }

            // Background stroke
            const backgroundStroke = draw.font.background.stroke;
            const backgroundStrokeColor = backgroundStroke?.color != null ?
                typedStyleParser.evalCachedColorPropertyWithAlpha(backgroundStroke.color, backgroundStroke.alpha, context) :
                undefined;
            style.background_stroke_color = toCssColor(backgroundStrokeColor);
            if (style.background_stroke_color) {
                // default background stroke to 1px when stroke color but no stroke width specified
                style.background_stroke_width = backgroundStroke?.width != null ?
                    typedStyleParser.evalCachedProperty(backgroundStroke.width, context) as number : 1;
            }
        }

        // Font properties are modeled after CSS names:
        // - family: Helvetica, Futura, etc.
        // - size: in pt, px, or em
        // - style: normal, italic, oblique
        // - weight: normal, bold, etc.
        // - transform: capitalize, uppercase, lowercase

        // clamp weight to 1-1000 (see https://drafts.csswg.org/css-fonts-4/#valdef-font-weight-number)
        style.weight = typedStyleParser.evalCachedProperty(draw.font.weight, context) as string | number || this.defaults.weight;
        if (typeof style.weight === 'number') {
            style.weight = Math.min(Math.max(style.weight, 1), 1000);
        }

        if (draw.font.family) {
            style.family = draw.font.family;
            if (style.family !== this.defaults.family) {
                style.family += ', ' + this.defaults.family;
            }
        }
        else {
            style.family = this.defaults.family;
        }

        style.style = draw.font.style || this.defaults.style;
        style.transform = draw.font.transform;

        // calculated pixel size
        style.px_size = (typedStyleParser.evalCachedProperty(draw.font.px_size, context) as number) * style.supersample;

        style.font_css = this.fontCSS(style);

        // Word wrap and text alignment
        // Not a font properties, but affect atlas of unique text textures
        let text_wrap = draw.text_wrap; // use explicitly set value

        if (text_wrap == null && !style.can_articulate) {
            // point labels (for point and polygon features) have word wrap on w/default max length,
            // line labels default off
            text_wrap = true;
        }

        // setting to 'true' causes default wrap value to be used
        if (text_wrap === true) {
            text_wrap = this.defaults.text_wrap;
        }
        style.text_wrap = text_wrap;

        // max_lines setting to truncate very long labels with an ellipsis
        style.max_lines = draw.max_lines || this.defaults.max_lines;

        return style;
    },

    // Build CSS-style font string (to set Canvas draw state)
    fontCSS ({style, weight, px_size, family}: TextSettingsResult): string {
        return [style, weight, px_size + 'px', family]
            .filter(x => x) // remove null props
            .join(' ');
    }

};

export default TextSettings;

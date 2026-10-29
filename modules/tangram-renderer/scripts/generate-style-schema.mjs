// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {z} from 'zod';
import {TangramStyleSheetSchema} from '../dist/style-schema.js';

const jsonSchema = z.toJSONSchema(TangramStyleSheetSchema, {
    target: 'draft-7',
    reused: 'ref'
});

jsonSchema.$id = 'https://unpkg.com/@tangram.gl/tangram-renderer/tangram-style.schema.json';
jsonSchema.title = 'Tangram scene style sheet';

await writeFile(
    resolve('dist/tangram-style.schema.json'),
    `${JSON.stringify(jsonSchema, null, 2)}\n`
);

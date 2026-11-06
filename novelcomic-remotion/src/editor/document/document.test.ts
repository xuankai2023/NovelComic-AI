import {describe, expect, it} from 'vitest';
import {createAdjustmentLayer, createEmptyDocument, createGroupLayer, createPixelLayer} from './defaults';
import {hashDocument} from './hash';
import {migrateDocument} from './migrations';
import {canonicalDocumentJson, normalizeDocument} from './normalize';
import {validateDocument} from './validate';

describe('document schema', () => {
	it('creates a valid empty document and all layer factories', () => { const d = createEmptyDocument(); expect(validateDocument(d)).toEqual([]); expect(createGroupLayer().content.kind).toBe('group'); expect(createPixelLayer('asset').content.kind).toBe('pixel'); expect(createAdjustmentLayer({kind: 'invert'}).kind).toBe('adjustment'); });
	it('reports stable invariant errors without repairing input', () => { const d = createEmptyDocument(); d.width = 0; expect(validateDocument(d).map((x) => x.code)).toContain('CANVAS_SIZE_INVALID'); const invalid = {...createEmptyDocument(), schemaVersion: 2 as 1}; expect(validateDocument(invalid).map((x) => x.code)).toContain('SCHEMA_TOO_NEW'); });
	it('normalizes key order and hashes deterministically', async () => { const d = createEmptyDocument(); const copy = JSON.parse(JSON.stringify(d)); copy.metadata = {z: 1, a: 2}; d.metadata = {a: 2, z: 1}; expect(canonicalDocumentJson(d)).toBe(canonicalDocumentJson(copy)); expect(await hashDocument(d)).toBe(await hashDocument(copy)); expect(normalizeDocument(d)).not.toBe(d); });
	it('migrates unversioned legacy envelope explicitly', () => { const result = migrateDocument({compositionWidth: 800, compositionHeight: 600}); expect(result.document.width).toBe(800); expect(result.report.fromVersion).toBe(0); });
});

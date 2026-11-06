import {describe, expect, it} from 'vitest';
import {convertPsdLayers, parsePsdHeader, PsdAdapterError} from './psd-adapter';

const header = (colorMode = 3, depth = 8) => { const bytes = new Uint8Array(26); bytes.set([0x38, 0x42, 0x50, 0x53]); const view = new DataView(bytes.buffer); view.setUint16(4, 1); view.setUint16(12, 4); view.setUint32(14, 2); view.setUint32(18, 2); view.setUint16(22, depth); view.setUint16(24, colorMode); return bytes; };
describe('PSD adapter', () => {
	it('accepts 8-bit RGB and converts editable metadata', () => { const parsed = parsePsdHeader(header()); const result = convertPsdLayers({header: parsed, projectId: 'project-1', layers: [{id: 'text', name: 'Text', text: {content: 'Hi'}}]}); expect(result.document.layers.text?.kind).toBe('text'); });
	it('rejects CMYK and non-8-bit input', () => { expect(() => parsePsdHeader(header(4))).toThrowError(PsdAdapterError); expect(() => parsePsdHeader(header(3, 16))).toThrowError(PsdAdapterError); });
});

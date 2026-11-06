import {describe, expect, it} from 'vitest';
import {createEmptyDocument} from '../document/defaults';
import {resolveToolCapability} from './tool-capabilities';
describe('tool capabilities', () => { const document = createEmptyDocument(); it('explains missing active layer', () => expect(resolveToolCapability('brush', {document, activeLayerId: null, selectedLayerIds: []}, ['active-layer'])).toEqual({enabled: false, reason: '需要活动图层'})); it('allows document-only tools without a layer', () => expect(resolveToolCapability('move', {document, activeLayerId: null, selectedLayerIds: []}, ['document'])).toEqual({enabled: true})); });

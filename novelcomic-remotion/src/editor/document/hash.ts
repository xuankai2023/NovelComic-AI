import {canonicalDocumentJson, normalizeDocument} from './normalize';
import type {DocumentState} from './types';
export const sha256Hex = async (input: string): Promise<string> => { const bytes = new TextEncoder().encode(input); const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes); return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(''); };
export const hashDocument = (document: DocumentState): Promise<string> => sha256Hex(canonicalDocumentJson(normalizeDocument(document)));

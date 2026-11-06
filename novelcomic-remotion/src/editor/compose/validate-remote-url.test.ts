import {describe, expect, it} from 'vitest';
import {COMIC_ERROR_CODES, ComicEditorError} from '../comic/errors';
import {validateRemoteUrl} from './validate-remote-url';

const policy = {
	allowedHosts: ['cdn.example.com', '8.8.8.8', '2001:db8::1'],
};

const expectRejected = (url: string, message: string, redirects?: string[]) => {
	expect(() => validateRemoteUrl(url, policy, redirects)).toThrow(
		ComicEditorError,
	);
	try {
		validateRemoteUrl(url, policy, redirects);
	} catch (error) {
		expect(error).toBeInstanceOf(ComicEditorError);
		if (error instanceof ComicEditorError) {
			expect(error.code).toBe(COMIC_ERROR_CODES.INVALID_REMOTE_URL);
			expect(error.status).toBe(422);
			expect(error.message).toBe(message);
		}
	}
};

describe('validateRemoteUrl', () => {
	it('accepts an allowlisted HTTPS CDN and its subdomains', () => {
		expect(
			validateRemoteUrl('https://cdn.example.com/a.png?token=1', policy),
		).toBe('https://cdn.example.com/a.png?token=1');
		expect(
			validateRemoteUrl('https://images.cdn.example.com/a.png', policy),
		).toBe('https://images.cdn.example.com/a.png');
	});

	it('rejects non-HTTPS, credentials, and hosts outside the allowlist', () => {
		expectRejected('http://cdn.example.com/a.png', 'HTTPS is required');
		expectRejected(
			'https://user:secret@cdn.example.com/a.png',
			'Remote URL credentials are not allowed',
		);
		expectRejected(
			'https://cdn.example.com.evil.test/a.png',
			'Host is not allowlisted',
		);
		expectRejected('https://evil.test/a.png', 'Host is not allowlisted');
	});

	it('rejects IPv4 private, loopback, and link-local addresses', () => {
		for (const host of [
			'127.0.0.1',
			'10.1.2.3',
			'192.168.0.5',
			'172.16.5.5',
			'169.254.169.254',
			'0.0.0.0',
			'2130706433',
		]) {
			expectRejected(
				`https://${host}/a.png`,
				'Private or local addresses are not allowed',
			);
		}

		expectRejected(
			'https://127.0.0.1/a.png',
			'Private or local addresses are not allowed',
			[],
		);
		expect(
			validateRemoteUrl('https://8.8.8.8/a.png', {
				allowedHosts: ['127.0.0.1', '8.8.8.8'],
			}),
		).toBe('https://8.8.8.8/a.png');
		expectRejected(
			'https://127.0.0.1/a.png',
			'Private or local addresses are not allowed',
		);
	});

	it('rejects IPv6 loopback, unique-local, and link-local addresses', () => {
		expectRejected(
			'https://[::1]/a.png',
			'Private or local addresses are not allowed',
		);
		expectRejected(
			'https://[fd00::1]/a.png',
			'Private or local addresses are not allowed',
		);
		expectRejected(
			'https://[fe80::1]/a.png',
			'Private or local addresses are not allowed',
		);
		expectRejected(
			'https://[::ffff:127.0.0.1]/a.png',
			'Private or local addresses are not allowed',
		);
		expect(validateRemoteUrl('https://[2001:db8::1]/a.png', policy)).toBe(
			'https://[2001:db8::1]/a.png',
		);
	});

	it('rejects localhost and a redirect onto a private or foreign host', () => {
		expectRejected(
			'https://localhost/a.png',
			'Private or local addresses are not allowed',
		);
		expectRejected(
			'https://cdn.example.com/start.png',
			'Private or local addresses are not allowed',
			['https://169.254.169.254/latest/meta-data'],
		);
		expectRejected('https://cdn.example.com/start.png', 'HTTPS is required', [
			'http://cdn.example.com/next.png',
		]);
		expectRejected(
			'https://cdn.example.com/start.png',
			'Host is not allowlisted',
			['https://evil.test/next.png'],
		);
		expect(
			validateRemoteUrl('https://cdn.example.com/start.png', policy, [
				'https://images.cdn.example.com/final.png',
			]),
		).toBe('https://images.cdn.example.com/final.png');
		expectRejected('https://cdn.example.com/start.png', 'Too many redirects', [
			'https://cdn.example.com/1.png',
			'https://cdn.example.com/2.png',
			'https://cdn.example.com/3.png',
			'https://cdn.example.com/4.png',
			'https://cdn.example.com/5.png',
			'https://cdn.example.com/6.png',
		]);
	});
});

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { resolveDatabasePath } = require('../database');
const { generateHTMLTemplate } = require('../publisher');

const {
    classifyUpload,
    escapeHtml,
    isAllowedHostHeader,
    isSameOriginRequest,
    normalizeLoopbackHost,
    normalizeThemeColor,
    resolvePublicAssetPath
} = require('../lib/security');

test('server bind and Host policy are loopback-only', () => {
    assert.equal(normalizeLoopbackHost(undefined), '127.0.0.1');
    assert.equal(normalizeLoopbackHost('localhost'), 'localhost');
    assert.equal(normalizeLoopbackHost('[::1]'), '::1');
    assert.throws(() => normalizeLoopbackHost('0.0.0.0'), /loopback/);
    assert.throws(() => normalizeLoopbackHost('192.168.1.10'), /loopback/);

    assert.equal(isAllowedHostHeader('localhost:3000'), true);
    assert.equal(isAllowedHostHeader('127.0.0.1'), true);
    assert.equal(isAllowedHostHeader('[::1]:3000'), true);
    assert.equal(isAllowedHostHeader('attacker.example:3000'), false);
    assert.equal(isAllowedHostHeader('localhost:0'), false);
    assert.equal(isAllowedHostHeader('localhost:65536'), false);
    assert.equal(isAllowedHostHeader('user@localhost:3000'), false);
});

test('mutating browser requests must use the local page origin', () => {
    assert.equal(isSameOriginRequest(undefined, 'localhost:3000'), true);
    assert.equal(isSameOriginRequest('http://localhost:3000', 'localhost:3000'), true);
    assert.equal(isSameOriginRequest('http://127.0.0.1:3000', '127.0.0.1:3000'), true);
    assert.equal(isSameOriginRequest('https://localhost:3000', 'localhost:3000'), false);
    assert.equal(isSameOriginRequest('http://user@localhost:3000', 'localhost:3000'), false);
    assert.equal(isSameOriginRequest('http://localhost:3000/path', 'localhost:3000'), false);
    assert.equal(isSameOriginRequest('https://attacker.example', 'localhost:3000'), false);
    assert.equal(isSameOriginRequest('null', 'localhost:3000'), false);
});

test('upload categories use exact, case-insensitive file extensions', () => {
    assert.equal(classifyUpload('clip.MP4'), 'video');
    assert.equal(classifyUpload('track.m4a'), 'audio');
    assert.equal(classifyUpload('clip.mp4.exe'), null);
    assert.equal(classifyUpload('not-a-video.movx'), null);
    assert.equal(classifyUpload('payload.html'), null);
    assert.equal(classifyUpload(null), null);
});

test('theme colors are restricted to safe hexadecimal values and text is escaped', () => {
    assert.equal(normalizeThemeColor('#ABC'), '#abc');
    assert.equal(normalizeThemeColor('#3B82F6'), '#3b82f6');
    assert.equal(normalizeThemeColor('red'), '#3b82f6');
    assert.equal(normalizeThemeColor('</style><script>'), '#3b82f6');
    assert.equal(escapeHtml(`<tag a="'&">`), '&lt;tag a=&quot;&#39;&amp;&quot;&gt;');
});

test('standalone exports escape project titles and reject CSS injection', () => {
    const hostileTitle = '</title><script>alert(1)</script>';
    const html = generateHTMLTemplate(hostileTitle, '</style><script>alert(2)</script>', [], {}, [{ id: 'clip-1' }], [], 1);
    assert.match(html, /<title>&lt;\/title&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/title>/);
    assert.match(html, /<h1[^>]*>&lt;\/title&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/h1>/);
    assert.doesNotMatch(html, /<script>alert\([12]\)<\/script>/);
    assert.match(html, /background: #3b82f6;/);
    const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(inlineScript);
    assert.doesNotThrow(() => new vm.Script(inlineScript[1]));
});

test('default database storage is anchored to the app directory', () => {
    assert.equal(path.dirname(resolveDatabasePath()), path.resolve(__dirname, '..'));
    assert.equal(resolveDatabasePath('custom/database.sqlite'), path.resolve('custom/database.sqlite'));
});

test('public asset resolution rejects traversal and symlinks outside the public tree', async (t) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-infinity-security-'));
    const publicDir = path.join(tempDir, 'public');
    const mediaDir = path.join(publicDir, 'videos');
    const outsideFile = path.join(tempDir, 'private.txt');
    await fs.mkdir(mediaDir, { recursive: true });
    await fs.writeFile(path.join(mediaDir, 'clip.mp4'), 'video');
    await fs.writeFile(outsideFile, 'private');
    await fs.symlink(outsideFile, path.join(mediaDir, 'outside-link.mp4'));
    t.after(() => fs.rm(tempDir, { recursive: true, force: true }));

    assert.equal(await resolvePublicAssetPath(publicDir, '/videos/clip.mp4'), await fs.realpath(path.join(mediaDir, 'clip.mp4')));
    assert.equal(await resolvePublicAssetPath(publicDir, '../../private.txt'), null);
    assert.equal(await resolvePublicAssetPath(publicDir, '..\\..\\private.txt'), null);
    assert.equal(await resolvePublicAssetPath(publicDir, '/videos/outside-link.mp4'), null);
    assert.equal(await resolvePublicAssetPath(publicDir, '\0bad'), null);
    assert.equal(await resolvePublicAssetPath(publicDir, ''), null);
});

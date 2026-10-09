const fs = require('node:fs/promises');
const path = require('node:path');

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.avi', '.mov', '.mkv', '.webm']);
const DEFAULT_THEME_COLOR = '#3b82f6';

function normalizeLoopbackHost(value) {
    const host = String(value || '127.0.0.1').trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (!LOOPBACK_HOSTS.has(host)) {
        throw new Error('StudioInfinity only supports loopback host addresses.');
    }
    return host;
}

function isAllowedHostHeader(value) {
    if (typeof value !== 'string') return false;
    const match = /^(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/i.exec(value.trim());
    if (!match) return false;
    return match[2] === undefined || (Number(match[2]) >= 1 && Number(match[2]) <= 65535);
}

function isSameOriginRequest(origin, hostHeader) {
    if (origin === undefined || origin === null || origin === '') return true;
    if (origin === 'null' || !isAllowedHostHeader(hostHeader)) return false;

    try {
        const requestOrigin = new URL(`http://${hostHeader}`).origin;
        const suppliedOrigin = new URL(origin);
        return suppliedOrigin.protocol === 'http:' && !suppliedOrigin.username && !suppliedOrigin.password &&
            suppliedOrigin.pathname === '/' && !suppliedOrigin.search && !suppliedOrigin.hash &&
            suppliedOrigin.origin === requestOrigin;
    } catch {
        return false;
    }
}

function classifyUpload(filename) {
    if (typeof filename !== 'string') return null;
    const extension = path.extname(filename).toLowerCase();
    if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
    if (VIDEO_EXTENSIONS.has(extension)) return 'video';
    return null;
}

function normalizeThemeColor(value, fallback = DEFAULT_THEME_COLOR) {
    if (typeof value !== 'string') return fallback;
    const color = value.trim();
    return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color) ? color.toLowerCase() : fallback;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function isWithinDirectory(root, target) {
    const relative = path.relative(root, target);
    return relative !== '' && relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function resolvePublicAssetPath(publicDir, assetPath) {
    if (typeof assetPath !== 'string' || assetPath.trim() === '' || assetPath.includes('\0')) return null;

    const root = path.resolve(publicDir);
    const normalizedAssetPath = assetPath.trim().replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalizedAssetPath) return null;

    const candidate = path.resolve(root, normalizedAssetPath);
    if (!isWithinDirectory(root, candidate)) return null;

    try {
        const [realRoot, realCandidate] = await Promise.all([
            fs.realpath(root),
            fs.realpath(candidate)
        ]);
        if (!isWithinDirectory(realRoot, realCandidate)) return null;
        const stat = await fs.stat(realCandidate);
        return stat.isFile() ? realCandidate : null;
    } catch {
        return null;
    }
}

module.exports = {
    AUDIO_EXTENSIONS,
    DEFAULT_THEME_COLOR,
    VIDEO_EXTENSIONS,
    classifyUpload,
    escapeHtml,
    isAllowedHostHeader,
    isSameOriginRequest,
    normalizeLoopbackHost,
    normalizeThemeColor,
    resolvePublicAssetPath
};

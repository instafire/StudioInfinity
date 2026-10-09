// server.js
const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const { v4: uuidv4 } = require('uuid');
const { initDB } = require('./database');
const {
    classifyUpload,
    isAllowedHostHeader,
    isSameOriginRequest,
    normalizeLoopbackHost
} = require('./lib/security');

// --- FFmpeg Setup ---
try {
    const ffmpegPath = require('ffmpeg-static');
    const ffprobePath = require('ffprobe-static').path;
    ffmpeg.setFfmpegPath(ffmpegPath);
    ffmpeg.setFfprobePath(ffprobePath);
    console.log("✅ FFmpeg/FFprobe linked (Static)");
} catch (e) {
    console.warn("⚠️ Static FFmpeg not found. Using system default.");
}

const PORT = Number(process.env.PORT || 3000);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
}
const HOST = normalizeLoopbackHost(process.env.STUDIO_HOST);
const app = express();
const PUBLIC_DIR = path.join(__dirname, 'public');

// --- Middleware ---
app.disable('x-powered-by');
app.use((req, res, next) => {
    const hostHeader = req.headers.host;
    if (!isAllowedHostHeader(hostHeader)) {
        return res.status(400).json({ error: 'Invalid Host header.' });
    }
    if (!isSameOriginRequest(req.headers.origin, hostHeader)) {
        return res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
});
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// --- Init Folders ---
['videos', 'clips', 'thumbnails', 'exports', 'audio'].forEach(f => fs.ensureDirSync(path.join(PUBLIC_DIR, f)));

// --- Multer Config ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dest = classifyUpload(file.originalname) === 'audio' ? 'public/audio' : 'public/videos';
        cb(null, path.join(__dirname, dest));
    },
    filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase()}`)
});
const upload = multer({
    storage,
    limits: { fileSize: 2000 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (classifyUpload(file.originalname)) cb(null, true);
        else cb(new Error('Unsupported upload extension.'));
    }
});

// --- Initialize System ---
(async () => {
    // 1. Start Database
    await initDB();

    // 2. Load Routes (injecting dependencies)
    const apiRoutes = require('./routes')(upload, PUBLIC_DIR);
    app.use('/api', apiRoutes);

    // 3. Start Server
    app.use((err, req, res, next) => {
        if (res.headersSent) return next(err);
        if (req.file?.path) fs.remove(req.file.path).catch(() => {});
        console.error(`Request rejected: ${err.code || err.name || 'unknown error'}`);
        res.status(400).json({ error: 'Request could not be processed.' });
    });

    app.listen(PORT, HOST, () => {
        console.log(`StudioInfinity running at http://${HOST}:${PORT}`);
    });
})().catch((err) => {
    console.error(`StudioInfinity failed to start: ${err.message}`);
    process.exitCode = 1;
});

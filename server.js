// server.js
const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const { initDB } = require('./database');

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

const PORT = 3000;
const app = express();
const PUBLIC_DIR = path.join(__dirname, 'public');

// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// --- Init Folders ---
['videos', 'clips', 'thumbnails', 'exports', 'audio'].forEach(f => fs.ensureDirSync(path.join(PUBLIC_DIR, f)));

// --- Multer Config ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dest = file.mimetype.startsWith('audio') ? 'public/audio' : 'public/videos';
        cb(null, path.join(__dirname, dest));
    },
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ 
    storage, 
    limits: { fileSize: 2000 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = /mp4|avi|mov|mkv|webm|mp3|wav|ogg|m4a|aac/;
        const ext = path.extname(file.originalname).toLowerCase().slice(1);
        if (allowed.test(ext)) cb(null, true);
        else cb(new Error('Invalid file type'));
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
    app.listen(PORT, () => {
        console.log(`🎬 Studio Infinity v20.12 Running: http://localhost:${PORT}`);
    });
})();
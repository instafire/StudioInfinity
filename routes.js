const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const { getDB } = require('./database');
const { publishProject } = require('./publisher');
const ffmpeg = require('fluent-ffmpeg');
const { classifyUpload, normalizeThemeColor, resolvePublicAssetPath } = require('./lib/security');

function toPositiveInteger(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
}

module.exports = (upload, publicDir) => {
    const removePublicAsset = async (assetPath) => {
        const safePath = await resolvePublicAssetPath(publicDir, assetPath);
        if (safePath) await fs.remove(safePath);
    };

    // --- 1. PROJECT ROUTES ---
    router.get('/projects', async (req, res) => {
        try {
            const rows = await getDB().all('SELECT * FROM projects ORDER BY id DESC');
            res.json(rows.map(project => ({ ...project, theme_color: normalizeThemeColor(project.theme_color) })));
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/projects', async (req, res) => {
        try {
            const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
            if (!title || title.length > 120) return res.status(400).json({ error: 'Project title must be 1–120 characters.' });
            await getDB().run('INSERT INTO projects (title) VALUES (?)', [title]);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/delete_project', async (req, res) => {
        try {
            const id = toPositiveInteger(req.body?.id);
            if (!id) return res.status(400).json({ error: 'Invalid project ID.' });
            const db = getDB();
            const videos = await db.all('SELECT filepath, thumbnail FROM videos WHERE project_id = ?', [id]);
            const clips = await db.all('SELECT filepath, thumbnail, name FROM clips WHERE project_id = ?', [id]);
            
            const filesToDelete = [];
            videos.forEach(v => {
                if(v.filepath) filesToDelete.push(v.filepath);
                if(v.thumbnail) filesToDelete.push(v.thumbnail);
            });
            clips.forEach(c => {
                if(c.filepath && !String(c.name || '').startsWith('FULL:')) filesToDelete.push(c.filepath);
                if(c.thumbnail) filesToDelete.push(c.thumbnail);
            });

            await db.exec('BEGIN IMMEDIATE');
            try {
                await db.run('DELETE FROM edges WHERE project_id = ?', [id]);
                await db.run('DELETE FROM variables WHERE project_id = ?', [id]);
                await db.run('DELETE FROM analytics WHERE project_id = ?', [id]);
                await db.run('DELETE FROM clips WHERE project_id = ?', [id]);
                await db.run('DELETE FROM videos WHERE project_id = ?', [id]);
                await db.run('DELETE FROM projects WHERE id = ?', [id]);
                await db.exec('COMMIT');
            } catch (err) {
                await db.exec('ROLLBACK').catch(() => {});
                throw err;
            }

            for (const file of new Set(filesToDelete)) {
                try { await removePublicAsset(file); }
                catch (err) { console.error(`Project media cleanup failed: ${err.code || 'filesystem error'}`); }
            }

            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/project/settings', async (req, res) => {
        try {
            const id = toPositiveInteger(req.body?.id);
            const color = normalizeThemeColor(req.body?.color, '');
            if (!id || !color) return res.status(400).json({ error: 'Invalid project ID or theme color.' });
            await getDB().run('UPDATE projects SET theme_color = ? WHERE id = ?', [color, id]);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // --- VARIABLE ROUTES ---
    router.get('/variables', async (req, res) => {
        try {
            const projectId = toPositiveInteger(req.query.projectId) || 1;
            const rows = await getDB().all('SELECT * FROM variables WHERE project_id = ? ORDER BY name ASC', [projectId]);
            res.json(rows);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/variables', async (req, res) => {
        const projectId = toPositiveInteger(req.body?.projectId);
        const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
        const initialValue = req.body?.initialValue == null ? 0 : Number(req.body.initialValue);
        const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
        if (!projectId || !/^[a-z][a-z0-9_]{0,39}$/i.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name.toLowerCase()) || ![0, 1].includes(initialValue) || description.length > 500) {
            return res.status(400).json({ error: 'Invalid variable definition.' });
        }
        try {
            const db = getDB();
            if (!await db.get('SELECT id FROM projects WHERE id = ?', [projectId])) return res.status(404).json({ error: 'Project not found.' });
            const exists = await db.get('SELECT * FROM variables WHERE project_id = ? AND name = ?', [projectId, name]);
            if (exists) {
                await db.run('UPDATE variables SET initial_value = ?, description = ? WHERE id = ? AND project_id = ?', [initialValue, description, exists.id, projectId]);
            } else {
                await db.run('INSERT INTO variables (project_id, name, initial_value, description) VALUES (?, ?, ?, ?)', [projectId, name, initialValue || 0, description || '']);
            }
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/variable/delete', async (req, res) => {
        try {
            const id = toPositiveInteger(req.body?.id);
            const projectId = toPositiveInteger(req.body?.projectId);
            if (!id || !projectId) return res.status(400).json({ error: 'Invalid variable ID or project.' });
            await getDB().run('DELETE FROM variables WHERE id = ? AND project_id = ?', [id, projectId]);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // --- 2. VIDEO & STORY ROUTES ---
    router.get('/videos', async (req, res) => { 
        try {
            const projectId = req.query.projectId || 1; 
            const videos = await getDB().all('SELECT * FROM videos WHERE project_id = ? ORDER BY id DESC', [projectId]); 
            res.json(videos); 
        } catch(err) { res.status(500).json({ error: 'Failed to fetch videos' }); }
    });

    router.get('/story', async (req, res) => { 
        try {
            const projectId = req.query.projectId || 1; 
            const clips = await getDB().all('SELECT * FROM clips WHERE project_id = ? ORDER BY id DESC', [projectId]); 
            const edges = await getDB().all('SELECT * FROM edges WHERE project_id = ? ORDER BY trigger_time ASC', [projectId]); 
            res.json({ clips, edges }); 
        } catch(err) { res.status(500).json({ error: 'Failed to fetch story data' }); }
    });

    router.get('/audio', async (req, res) => { 
        try { 
            const audioDir = path.join(publicDir, 'audio');
            if (!await fs.pathExists(audioDir)) return res.json([]);
            const files = await fs.readdir(audioDir); 
            res.json(files.map(f => ({ name: f, path: `/audio/${f}` }))); 
        } catch(e) { res.json([]); } 
    });

    // --- 3. UPLOAD ROUTE ---
    router.post('/upload', upload.single('file'), async (req, res) => {
        if (!req.file) return res.status(400).json({ error: "No file" });
        const projectId = req.body?.projectId == null ? 1 : toPositiveInteger(req.body.projectId);
        if (!projectId) {
            await fs.remove(req.file.path).catch(() => {});
            return res.status(400).json({ error: 'Invalid project ID.' });
        }
        const category = classifyUpload(req.file.originalname);
        if (category === 'audio') {
            return res.json({ success: true, type: 'audio', path: `/audio/${req.file.filename}`, name: String(req.file.originalname).slice(0, 255) });
        }
        let project;
        try {
            project = await getDB().get('SELECT id FROM projects WHERE id = ?', [projectId]);
        } catch (err) {
            await fs.remove(req.file.path).catch(() => {});
            return res.status(500).json({ error: 'Could not verify the target project.' });
        }
        if (!project) {
            await fs.remove(req.file.path).catch(() => {});
            return res.status(404).json({ error: 'Project not found.' });
        }

        let thumbnail = null;
        let thumbnailFile = null;
        try {
            const filename = req.file.filename;
            const webPath = `/videos/${filename}`;
            const videoPath = req.file.path;
            const metadata = await new Promise((resolve, reject) => {
                ffmpeg.ffprobe(videoPath, (err, result) => err ? reject(err) : resolve(result));
            });
            const duration = Number(metadata?.format?.duration);
            if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid video metadata.');

            const thumbName = `${path.parse(filename).name}_${uuidv4()}.jpg`;
            thumbnailFile = path.join(publicDir, 'thumbnails', thumbName);
            const thumbCreated = await new Promise((resolve) => {
                ffmpeg(videoPath).screenshots({ timestamps: ['20%'], filename: thumbName, folder: path.join(publicDir, 'thumbnails'), size: '640x360' })
                    .on('end', () => resolve(true))
                    .on('error', () => resolve(false));
            });
            if (thumbCreated) thumbnail = `/thumbnails/${thumbName}`;
            else {
                await fs.remove(thumbnailFile).catch(() => {});
                thumbnailFile = null;
            }

            const db = getDB();
            await db.exec('BEGIN IMMEDIATE');
            try {
                const result = await db.run('INSERT INTO videos (project_id, filename, filepath, thumbnail, duration) VALUES (?, ?, ?, ?, ?)', [projectId, String(req.file.originalname).slice(0, 255), webPath, thumbnail, duration]);
                const clipId = uuidv4();
                await db.run('INSERT INTO clips (unique_id, project_id, name, filepath, thumbnail, source_video_id, duration, x, y) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [clipId, projectId, `FULL: ${String(req.file.originalname).slice(0, 120)}`, webPath, thumbnail, result.lastID, duration, 100, 100]);
                await db.exec('COMMIT');
            } catch (dbErr) {
                await db.exec('ROLLBACK').catch(() => {});
                throw dbErr;
            }
            return res.json({ success: true, type: 'video' });
        } catch (err) {
            await fs.remove(req.file.path).catch(() => {});
            if (thumbnailFile) await fs.remove(thumbnailFile).catch(() => {});
            console.error(`Video upload failed: ${err.code || err.name || 'processing error'}`);
            return res.status(422).json({ error: 'The uploaded file could not be processed.' });
        }
    });

    // --- 4. CLIP & LOGIC ROUTES ---
    router.post('/clip', async (req, res) => {
        const body = req.body || {};
        const projectId = toPositiveInteger(body.projectId);
        const sourceId = toPositiveInteger(body.sourceId);
        const fStart = Number(body.start);
        const fEnd = Number(body.end);
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
        const filter = body.filter || 'none';
        const speedValue = body.speed == null ? 1 : Number(body.speed);
        const volumeValue = body.volume == null ? 1 : Number(body.volume);
        if (!projectId || !sourceId || !name || !Number.isFinite(fStart) || !Number.isFinite(fEnd) || fStart < 0 || fEnd <= fStart ||
            !Number.isFinite(speedValue) || speedValue < 0.5 || speedValue > 4 || !Number.isFinite(volumeValue) || volumeValue < 0 || volumeValue > 2 ||
            !['none', 'bw', 'sepia', 'vivid'].includes(filter)) {
            return res.status(400).json({ error: 'Invalid clip parameters.' });
        }
        try {
            const video = await getDB().get('SELECT * FROM videos WHERE id = ? AND project_id = ?', [sourceId, projectId]);
            if (!video) return res.status(404).json({ error: 'Source video not found' });
            if (!Number.isFinite(Number(video.duration)) || Number(video.duration) <= 0 || fEnd > Number(video.duration)) return res.status(400).json({ error: 'Clip range exceeds source duration.' });
            const sourcePath = await resolvePublicAssetPath(publicDir, video.filepath);
            if (!sourcePath) return res.status(400).json({ error: 'Source media path is invalid.' });

            const duration = (fEnd - fStart) / speedValue;

            const clipId = uuidv4();
            const outputFilename = `clip_${clipId}.mp4`;
            const outputPath = path.join(publicDir, 'clips', outputFilename);
            
            try {
                await new Promise((resolve, reject) => {
                    const command = ffmpeg(sourcePath).setStartTime(fStart).setDuration(fEnd - fStart);
                    if (speedValue !== 1) {
                        command.audioFilters(`atempo=${speedValue}`);
                        command.videoFilters(`setpts=${1 / speedValue}*PTS`);
                    }
                    if (filter === 'bw') command.videoFilters('hue=s=0');
                    if (filter === 'sepia') command.videoFilters('colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131');
                    if (filter === 'vivid') command.videoFilters('eq=saturation=2');
                    if (volumeValue !== 1) command.audioFilters(`volume=${volumeValue}`);
                    command.videoCodec('libx264').audioCodec('aac').outputOptions('-preset ultrafast').output(outputPath)
                        .on('end', resolve).on('error', reject).run();
                });
                const webPath = `/clips/${outputFilename}`;
                await getDB().run('INSERT INTO clips (unique_id, project_id, name, filepath, thumbnail, source_video_id, duration, start_time, end_time, x, y, is_event_clip, is_game_over) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)',
                    [clipId, projectId, name, webPath, video.thumbnail, sourceId, duration, fStart, fEnd, 150, 150]);
                return res.json({ success: true });
            } catch (err) {
                await fs.remove(outputPath).catch(() => {});
                console.error(`Clip processing failed: ${err.code || err.name || 'processing error'}`);
                return res.status(422).json({ error: 'Clip could not be generated.' });
            }
        } catch (err) { res.status(500).json({ error: 'Clip request failed.' }); }
    });

    router.post('/create_event_clip', async (req, res) => {
        const body = req.body || {};
        const projectId = toPositiveInteger(body.projectId);
        const sourceId = toPositiveInteger(body.sourceId);
        const fStart = Number(body.start);
        const fEnd = Number(body.end);
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
        const choices = body.choices == null ? [] : body.choices;
        if (!projectId || !sourceId || !name || !Number.isFinite(fStart) || !Number.isFinite(fEnd) || fStart < 0 || fEnd <= fStart ||
            !Array.isArray(choices) || choices.length > 100 || choices.some(choice => !choice || typeof choice !== 'object' || typeof choice.label !== 'string' || choice.label.length > 100 || (choice.toId != null && typeof choice.toId !== 'string') || (choice.setVar != null && typeof choice.setVar !== 'string') || (choice.reqVar != null && typeof choice.reqVar !== 'string'))) {
            return res.status(400).json({ error: 'Invalid event clip parameters.' });
        }
        try {
            const db = getDB();
            const video = await db.get('SELECT * FROM videos WHERE id = ? AND project_id = ?', [sourceId, projectId]);
            if (!video) return res.status(404).json({ error: 'Source video not found' });
            if (!Number.isFinite(Number(video.duration)) || Number(video.duration) <= 0 || fEnd > Number(video.duration)) return res.status(400).json({ error: 'Event range exceeds source duration.' });
            const projectClips = new Set((await db.all('SELECT unique_id FROM clips WHERE project_id = ?', [projectId])).map(clip => clip.unique_id));
            const variables = new Set((await db.all('SELECT name FROM variables WHERE project_id = ?', [projectId])).map(variable => variable.name));
            const activeChoices = choices.filter(choice => choice.label.trim());
            for (const choice of activeChoices) {
                if (choice.toId && !projectClips.has(choice.toId)) return res.status(400).json({ error: 'Choice target is not in this project.' });
                if (choice.setVar && !variables.has(choice.setVar)) return res.status(400).json({ error: 'Choice variable is not in this project.' });
                if (choice.reqVar && !variables.has(choice.reqVar)) return res.status(400).json({ error: 'Required variable is not in this project.' });
                const x = choice.x == null ? 50 : Number(choice.x);
                const y = choice.y == null ? 50 : Number(choice.y);
                if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100) return res.status(400).json({ error: 'Choice positions must be between 0 and 100.' });
            }

            const sourcePath = await resolvePublicAssetPath(publicDir, video.filepath);
            if (!sourcePath) return res.status(400).json({ error: 'Source media path is invalid.' });
            const clipId = uuidv4();
            const outputFilename = `event_${clipId}.mp4`;
            const outputPath = path.join(publicDir, 'clips', outputFilename);
            const duration = fEnd - fStart;

            try {
                await new Promise((resolve, reject) => {
                    ffmpeg(sourcePath).setStartTime(fStart).setDuration(duration).output(outputPath)
                        .on('end', resolve).on('error', reject).run();
                });

                await db.exec('BEGIN IMMEDIATE');
                try {
                    const thumbnailPath = await resolvePublicAssetPath(publicDir, video.thumbnail);
                    await db.run('INSERT INTO clips (unique_id, project_id, name, filepath, thumbnail, source_video_id, duration, start_time, end_time, x, y, is_event_clip, is_game_over) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)',
                        [clipId, projectId, name, `/clips/${outputFilename}`, thumbnailPath ? `/thumbnails/${path.basename(thumbnailPath)}` : null, sourceId, duration, fStart, fEnd, 150, 150]);

                    if (activeChoices.length > 0) {
                        const triggerTime = Math.max(0, duration - 0.5);
                        for (const choice of activeChoices) {
                            const color = normalizeThemeColor(choice.color || '#ffffff', '#ffffff');
                            const x = choice.x == null ? 50 : Number(choice.x);
                            const y = choice.y == null ? 50 : Number(choice.y);
                            if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100) throw new Error('Invalid choice position.');
                            await db.run('INSERT INTO edges (project_id, from_id, to_id, label, text_color, trigger_time, return_to_main, set_var, req_var, x, y) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ',
                                [projectId, clipId, choice.toId || null, choice.label.trim(), color, triggerTime, choice.returnToMain ? 1 : 0, choice.setVar || null, choice.reqVar || null, x, y]);
                        }
                    }
                    await db.exec('COMMIT');
                } catch (dbErr) {
                    await db.exec('ROLLBACK').catch(() => {});
                    throw dbErr;
                }
                return res.json({ success: true });
            } catch (err) {
                await fs.remove(outputPath).catch(() => {});
                console.error(`Event clip generation failed: ${err.code || err.name || 'processing error'}`);
                return res.status(422).json({ error: 'Event clip could not be generated.' });
            }
        } catch (err) { res.status(500).json({ error: 'Event clip request failed.' }); }
    });
    
    router.post('/update_event_logic', async (req, res) => {
        const body = req.body || {};
        const projectId = toPositiveInteger(body.projectId);
        const clipId = typeof body.clipId === 'string' ? body.clipId : '';
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
        const choices = body.choices == null ? [] : body.choices;
        if (!projectId || !clipId || !name || !Array.isArray(choices) || choices.length > 100 ||
            choices.some(choice => !choice || typeof choice !== 'object' || typeof choice.label !== 'string' || choice.label.length > 100 || (choice.toId != null && typeof choice.toId !== 'string'))) {
            return res.status(400).json({ error: 'Invalid event logic.' });
        }
        try {
            const db = getDB();
            const clip = await db.get('SELECT duration FROM clips WHERE unique_id = ? AND project_id = ? AND is_event_clip = 1', [clipId, projectId]);
            if (!clip) return res.status(404).json({ error: 'Event clip not found in this project.' });
            const duration = Number(clip.duration);
            if (!Number.isFinite(duration) || duration <= 0) return res.status(400).json({ error: 'Event clip duration is invalid.' });
            const projectClips = new Set((await db.all('SELECT unique_id FROM clips WHERE project_id = ?', [projectId])).map(row => row.unique_id));
            const variables = new Set((await db.all('SELECT name FROM variables WHERE project_id = ?', [projectId])).map(row => row.name));
            const activeChoices = choices.filter(choice => choice.label.trim());
            for (const choice of activeChoices) {
                if (choice.toId && !projectClips.has(choice.toId)) return res.status(400).json({ error: 'Choice target is not in this project.' });
                if (choice.setVar && !variables.has(choice.setVar)) return res.status(400).json({ error: 'Choice variable is not in this project.' });
                if (choice.reqVar && !variables.has(choice.reqVar)) return res.status(400).json({ error: 'Required variable is not in this project.' });
                const x = choice.x == null ? 50 : Number(choice.x);
                const y = choice.y == null ? 50 : Number(choice.y);
                if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100) return res.status(400).json({ error: 'Choice positions must be between 0 and 100.' });
            }
            const triggerTime = Math.max(0, duration - 0.5);
            await db.exec('BEGIN IMMEDIATE');
            try {
                await db.run('UPDATE clips SET name = ? WHERE unique_id = ? AND project_id = ?', [name, clipId, projectId]);
                await db.run('DELETE FROM edges WHERE from_id = ? AND project_id = ?', [clipId, projectId]);
                for (const choice of activeChoices) {
                    const color = normalizeThemeColor(choice.color || '#ffffff', '#ffffff');
                    await db.run('INSERT INTO edges (project_id, from_id, to_id, label, text_color, trigger_time, return_to_main, set_var, req_var, x, y) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                        [projectId, clipId, choice.toId || null, choice.label.trim(), color, triggerTime, choice.returnToMain === true ? 1 : 0, choice.setVar || null, choice.reqVar || null, choice.x == null ? 50 : Number(choice.x), choice.y == null ? 50 : Number(choice.y)]);
                }
                await db.exec('COMMIT');
            } catch (err) {
                await db.exec('ROLLBACK').catch(() => {});
                throw err;
            }
            res.json({ success: true });
        } catch(err) { res.status(500).json({ error: err.message }); }
    });

    // UPDATED: Saves x, y positions and logic blocks
    router.post('/save_logic_block', async (req, res) => {
        const body = req.body || {};
        const projectId = toPositiveInteger(body.projectId);
        const fromId = typeof body.fromId === 'string' ? body.fromId : '';
        const logicId = typeof body.logicId === 'string' && body.logicId.length <= 80 ? body.logicId : '';
        const triggerTime = Number(body.triggerTime);
        const choices = body.choices == null ? [] : body.choices;
        const requestedMusic = typeof body.bgMusic === 'string' ? body.bgMusic.trim() : '';
        if (!projectId || !fromId || !Number.isFinite(triggerTime) || triggerTime < 0 || !Array.isArray(choices) || choices.length > 100 ||
            choices.some(choice => !choice || typeof choice !== 'object' || (choice.toId != null && typeof choice.toId !== 'string') || (choice.label != null && (typeof choice.label !== 'string' || choice.label.length > 120)))) {
            return res.status(400).json({ error: 'Invalid logic block.' });
        }
        try {
            let bgMusic = '';
            if (requestedMusic) {
                const audioMatch = /^\/?audio\/([^/\\]+)$/i.exec(requestedMusic.replace(/\\/g, '/'));
                if (!audioMatch || classifyUpload(audioMatch[1]) !== 'audio') return res.status(400).json({ error: 'Background music must be a local audio upload.' });
                const audioPath = await resolvePublicAssetPath(publicDir, `/audio/${audioMatch[1]}`);
                if (!audioPath || path.dirname(audioPath) !== await fs.realpath(path.join(publicDir, 'audio'))) return res.status(400).json({ error: 'Background audio file was not found.' });
                bgMusic = `/audio/${path.basename(audioPath)}`;
            }

            const db = getDB();
            const sourceClip = await db.get('SELECT duration FROM clips WHERE unique_id = ? AND project_id = ?', [fromId, projectId]);
            if (!sourceClip) return res.status(404).json({ error: 'Source clip not found in this project.' });
            if (Number.isFinite(Number(sourceClip.duration)) && triggerTime > Number(sourceClip.duration)) return res.status(400).json({ error: 'Logic trigger is beyond the clip duration.' });

            const projectClips = new Set((await db.all('SELECT unique_id FROM clips WHERE project_id = ?', [projectId])).map(clip => clip.unique_id));
            const variables = new Set((await db.all('SELECT name FROM variables WHERE project_id = ?', [projectId])).map(variable => variable.name));
            for (const choice of choices) {
                if (choice.toId && !projectClips.has(choice.toId)) return res.status(400).json({ error: 'Choice target is not in this project.' });
                if (choice.setVar && !variables.has(choice.setVar)) return res.status(400).json({ error: 'Choice variable is not in this project.' });
                if (choice.reqVar && !variables.has(choice.reqVar)) return res.status(400).json({ error: 'Required variable is not in this project.' });
                const x = choice.x == null ? 50 : Number(choice.x);
                const y = choice.y == null ? 50 : Number(choice.y);
                if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100) return res.status(400).json({ error: 'Choice positions must be between 0 and 100.' });
            }

            const newLogicId = logicId || uuidv4();
            await db.exec('BEGIN IMMEDIATE');
            try {
                await db.run('UPDATE clips SET bg_music = ?, mute_audio = ? WHERE unique_id = ? AND project_id = ?', [bgMusic, body.muteAudio === true || body.muteAudio === 1 ? 1 : 0, fromId, projectId]);
                if (logicId) await db.run('DELETE FROM edges WHERE logic_id = ? AND project_id = ?', [logicId, projectId]);
                else await db.run('DELETE FROM edges WHERE from_id = ? AND project_id = ? AND trigger_time BETWEEN ? AND ?', [fromId, projectId, triggerTime - 0.05, triggerTime + 0.05]);

                for (const choice of choices) {
                    const color = normalizeThemeColor(choice.color || '#ffffff', '#ffffff');
                    await db.run('INSERT INTO edges (project_id, from_id, to_id, label, text_color, trigger_time, logic_id, return_to_main, set_var, req_var, x, y) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                        [projectId, fromId, choice.toId || null, (choice.label || 'Choice').trim(), color, triggerTime, newLogicId, choice.return === true ? 1 : 0, choice.setVar || null, choice.reqVar || null, choice.x == null ? 50 : Number(choice.x), choice.y == null ? 50 : Number(choice.y)]);
                }
                await db.exec('COMMIT');
            } catch (err) {
                await db.exec('ROLLBACK').catch(() => {});
                throw err;
            }
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/delete_logic_block', async (req, res) => { 
        const body = req.body || {};
        const projectId = toPositiveInteger(body.projectId);
        const logicId = typeof body.logicId === 'string' ? body.logicId : '';
        const fromId = typeof body.fromId === 'string' ? body.fromId : '';
        const triggerTime = Number(body.triggerTime);
        if (!projectId || (!logicId && (!fromId || !Number.isFinite(triggerTime) || triggerTime < 0))) return res.status(400).json({ error: 'Invalid logic block identifier.' });
        try { 
            if (logicId) await getDB().run('DELETE FROM edges WHERE logic_id = ? AND project_id = ?', [logicId, projectId]);
            else await getDB().run('DELETE FROM edges WHERE from_id = ? AND project_id = ? AND trigger_time BETWEEN ? AND ?', [fromId, projectId, triggerTime - 0.02, triggerTime + 0.02]);
            res.json({ success: true }); 
        } catch(err) { res.status(500).json({error: err.message}); } 
    });

    router.post('/clip/positions', async (req, res) => {
        try {
            const projectId = toPositiveInteger(req.body?.projectId);
            const updates = req.body?.updates;
            if (!projectId || !Array.isArray(updates) || updates.length > 500 || updates.some(update => !update || typeof update.id !== 'string' || !Number.isFinite(Number(update.x)) || !Number.isFinite(Number(update.y)) || Math.abs(Number(update.x)) > 100000 || Math.abs(Number(update.y)) > 100000)) {
                return res.status(400).json({ error: 'Invalid clip layout.' });
            }
            const db = getDB();
            const clipIds = new Set((await db.all('SELECT unique_id FROM clips WHERE project_id = ?', [projectId])).map(clip => clip.unique_id));
            if (updates.some(update => !clipIds.has(update.id))) return res.status(400).json({ error: 'Layout contains a clip outside this project.' });
            await db.exec('BEGIN IMMEDIATE');
            try {
                for (const update of updates) await db.run('UPDATE clips SET x = ?, y = ? WHERE unique_id = ? AND project_id = ?', [Number(update.x), Number(update.y), update.id, projectId]);
                await db.exec('COMMIT');
            } catch (err) {
                await db.exec('ROLLBACK').catch(() => {});
                throw err;
            }
            res.json({ success: true });
        } catch(err) { res.status(500).json({error: err.message}); }
    });
    
    router.post('/clip/update', async (req, res) => {
        const projectId = toPositiveInteger(req.body?.projectId);
        const id = typeof req.body?.id === 'string' ? req.body.id : '';
        const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 120) : '';
        const isGameOver = req.body?.isGameOver;
        if (!projectId || !id || !name || ![true, false, 0, 1].includes(isGameOver)) return res.status(400).json({ error: 'Invalid clip details.' });
        try {
            await getDB().run('UPDATE clips SET name = ?, is_game_over = ? WHERE unique_id = ? AND project_id = ?', [name, isGameOver === true || isGameOver === 1 ? 1 : 0, id, projectId]);
            res.json({ success: true });
        } catch(err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/edge/create', async (req, res) => {
        const projectId = toPositiveInteger(req.body?.projectId);
        const fromId = typeof req.body?.fromId === 'string' ? req.body.fromId : '';
        const toId = typeof req.body?.toId === 'string' ? req.body.toId : '';
        if (!projectId || !fromId || !toId || fromId === toId) return res.status(400).json({ error: 'Invalid edge endpoints.' });
        try {
            const db = getDB();
            const [source, target] = await Promise.all([
                db.get('SELECT duration FROM clips WHERE unique_id = ? AND project_id = ?', [fromId, projectId]),
                db.get('SELECT unique_id FROM clips WHERE unique_id = ? AND project_id = ?', [toId, projectId])
            ]);
            if (!source || !target) return res.status(404).json({ error: 'Edge endpoints must belong to this project.' });
            const duration = Number(source.duration);
            if (!Number.isFinite(duration) || duration <= 0) return res.status(400).json({ error: 'Source clip duration is invalid.' });
            const triggerTime = Math.max(0, duration - 0.5);
            const logicId = uuidv4();

            await db.run(
                'INSERT INTO edges (project_id, from_id, to_id, label, trigger_time, logic_id, x, y) VALUES (?, ?, ?, ?, ?, ?, 50, 50)', 
                [projectId, fromId, toId, 'Next Scene', triggerTime, logicId]
            );
            res.json({ success: true });
        } catch(err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/edge/delete', async (req, res) => {
        try {
            const projectId = toPositiveInteger(req.body?.projectId);
            const id = toPositiveInteger(req.body?.id);
            if (!projectId || !id) return res.status(400).json({ error: 'Invalid edge ID or project.' });
            await getDB().run('DELETE FROM edges WHERE id = ? AND project_id = ?', [id, projectId]);
            res.json({ success: true });
        } catch(err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/delete_video', async (req, res) => { 
        try {
            const id = toPositiveInteger(req.body?.id);
            const projectId = toPositiveInteger(req.body?.projectId);
            if (!id || !projectId) return res.status(400).json({ error: 'Invalid video ID or project.' });
            const db = getDB();
            const vid = await db.get('SELECT * FROM videos WHERE id = ? AND project_id = ?', [id, projectId]);
            if (vid) {
                const clips = await db.all('SELECT unique_id, name, filepath, thumbnail FROM clips WHERE source_video_id = ? AND project_id = ?', [id, projectId]);
                const filesToDelete = [vid.filepath, vid.thumbnail];
                for (const clip of clips) {
                    if (!String(clip.name || '').startsWith('FULL:')) filesToDelete.push(clip.filepath);
                    if (clip.thumbnail && clip.thumbnail !== vid.thumbnail) filesToDelete.push(clip.thumbnail);
                }
                await db.exec('BEGIN IMMEDIATE');
                try {
                    for (const clip of clips) await db.run('DELETE FROM edges WHERE from_id = ? OR to_id = ?', [clip.unique_id, clip.unique_id]);
                    await db.run('DELETE FROM clips WHERE source_video_id = ? AND project_id = ?', [id, projectId]);
                    await db.run('DELETE FROM videos WHERE id = ? AND project_id = ?', [id, projectId]);
                    await db.exec('COMMIT');
                } catch (err) {
                    await db.exec('ROLLBACK').catch(() => {});
                    throw err;
                }
                for (const file of new Set(filesToDelete.filter(Boolean))) {
                    try { await removePublicAsset(file); }
                    catch (err) { console.error(`Video media cleanup failed: ${err.code || 'filesystem error'}`); }
                }
            }
            res.json({ success: true }); 
        } catch(err) { res.status(500).json({ error: 'Failed' }); }
    });

    router.post('/delete_clip', async (req, res) => { 
        try {
            const uniqueId = typeof req.body?.unique_id === 'string' ? req.body.unique_id : '';
            const projectId = toPositiveInteger(req.body?.projectId);
            if (!uniqueId || !projectId) return res.status(400).json({ error: 'Invalid clip ID or project.' });
            const db = getDB();
            const clip = await db.get('SELECT * FROM clips WHERE unique_id = ? AND project_id = ?', [uniqueId, projectId]);
            if (clip && !String(clip.name || '').startsWith('FULL:')) {
                await db.exec('BEGIN IMMEDIATE');
                try {
                    await db.run('DELETE FROM clips WHERE unique_id = ? AND project_id = ?', [uniqueId, projectId]);
                    await db.run('DELETE FROM edges WHERE project_id = ? AND (from_id = ? OR to_id = ?)', [projectId, uniqueId, uniqueId]);
                    await db.exec('COMMIT');
                } catch (err) {
                    await db.exec('ROLLBACK').catch(() => {});
                    throw err;
                }
                try { await removePublicAsset(clip.filepath); }
                catch (err) { console.error(`Clip media cleanup failed: ${err.code || 'filesystem error'}`); }
            }
            res.json({ success: true }); 
        } catch(err) { res.status(500).json({ error: 'Failed' }); }
    });

    router.post('/delete_clips_bulk', async (req, res) => {
        const ids = req.body?.ids;
        const projectId = toPositiveInteger(req.body?.projectId);
        if (!projectId || !Array.isArray(ids) || ids.length > 500 || ids.some(id => typeof id !== 'string')) {
            return res.status(400).json({ error: 'Invalid clip IDs or project.' });
        }
        let count = 0;
        try {
            const db = getDB();
            const clips = [];
            for (const id of new Set(ids)) {
                const clip = await db.get('SELECT * FROM clips WHERE unique_id = ? AND project_id = ?', [id, projectId]);
                if (clip && !String(clip.name || '').startsWith('FULL:')) clips.push(clip);
            }
            await db.exec('BEGIN IMMEDIATE');
            try {
                for (const clip of clips) {
                    await db.run('DELETE FROM clips WHERE unique_id = ? AND project_id = ?', [clip.unique_id, projectId]);
                    await db.run('DELETE FROM edges WHERE project_id = ? AND (from_id = ? OR to_id = ?)', [projectId, clip.unique_id, clip.unique_id]);
                }
                await db.exec('COMMIT');
            } catch (err) {
                await db.exec('ROLLBACK').catch(() => {});
                throw err;
            }
            for (const clip of clips) {
                try { await removePublicAsset(clip.filepath); }
                catch (err) { console.error(`Clip media cleanup failed: ${err.code || 'filesystem error'}`); }
            }
            count = clips.length;
            res.json({ success: true, count });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/clip/thumbnail', async (req, res) => {
        const id = typeof req.body?.id === 'string' ? req.body.id : '';
        const projectId = toPositiveInteger(req.body?.projectId);
        const time = Number(req.body?.time);
        let thumbPath = null;
        try {
            if (!id || !projectId) return res.status(400).json({ error: 'Invalid clip ID or project.' });
            const clip = await getDB().get('SELECT * FROM clips WHERE unique_id = ? AND project_id = ?', [id, projectId]);
            if (!clip) return res.status(404).json({ error: 'Clip not found in this project.' });
            if (!Number.isFinite(time) || time < 0 || time > Number(clip.duration)) return res.status(400).json({ error: 'Invalid thumbnail time.' });
            const videoPath = await resolvePublicAssetPath(publicDir, clip.filepath);
            if (!videoPath) return res.status(400).json({ error: 'Clip media path is invalid.' });
            const thumbName = `thumb_${uuidv4()}.jpg`;
            thumbPath = path.join(publicDir, 'thumbnails', thumbName);
            try {
                await new Promise((resolve, reject) => {
                    ffmpeg(videoPath).screenshots({ timestamps: [time], filename: thumbName, folder: path.join(publicDir, 'thumbnails'), size: '640x360' })
                        .on('end', resolve).on('error', reject);
                });
            } catch (err) {
                await fs.remove(thumbPath).catch(() => {});
                return res.status(422).json({ error: 'Thumbnail could not be generated.' });
            }
            const newThumbPath = `/thumbnails/${thumbName}`;
            const db = getDB();
            await db.exec('BEGIN IMMEDIATE');
            try {
                await db.run('UPDATE clips SET thumbnail = ? WHERE unique_id = ? AND project_id = ?', [newThumbPath, id, projectId]);
                if (String(clip.name || '').startsWith('FULL:')) await db.run('UPDATE videos SET thumbnail = ? WHERE id = ? AND project_id = ?', [newThumbPath, clip.source_video_id, projectId]);
                await db.exec('COMMIT');
            } catch (err) {
                await db.exec('ROLLBACK').catch(() => {});
                throw err;
            }
            res.json({ success: true, thumbnail: newThumbPath });
        } catch (err) {
            if (thumbPath) await fs.remove(thumbPath).catch(() => {});
            res.status(500).json({ error: 'Thumbnail update failed.' });
        }
    });

    router.get('/analytics/:id', async (req, res) => {
        try {
            const projectId = toPositiveInteger(req.params.id);
            if (!projectId) return res.status(400).json({ error: 'Invalid project ID.' });
            const rows = await getDB().all('SELECT choice_label, COUNT(*) as count FROM analytics WHERE project_id = ? GROUP BY choice_label ORDER BY count DESC', [projectId]);
            res.json(rows);
        } catch (e) { res.json([]); }
    });

    router.post('/analytics/track', async (req, res) => {
        try {
            const projectId = toPositiveInteger(req.body?.projectId);
            const label = typeof req.body?.label === 'string' ? req.body.label.slice(0, 120) : '';
            const targetId = req.body?.target == null ? null : (typeof req.body.target === 'string' ? req.body.target : '');
            if (!projectId || targetId === '' || targetId?.length > 80) return res.status(400).json({ error: 'Invalid analytics event.' });
            const db = getDB();
            const project = await db.get('SELECT id FROM projects WHERE id = ?', [projectId]);
            if (!project) return res.status(404).json({ error: 'Project not found.' });
            if (targetId && !await db.get('SELECT unique_id FROM clips WHERE unique_id = ? AND project_id = ?', [targetId, projectId])) return res.status(400).json({ error: 'Analytics target is not in this project.' });
            await db.run('INSERT INTO analytics (project_id, choice_label, target_clip_id) VALUES (?, ?, ?)', [projectId, label, targetId]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: 'Could not record analytics event.' }); }
    });

    router.post('/analytics/reset', async (req, res) => {
        try {
            const projectId = toPositiveInteger(req.body?.projectId);
            if (!projectId) return res.status(400).json({ error: 'Invalid project ID.' });
            await getDB().run('DELETE FROM analytics WHERE project_id = ?', [projectId]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/publish', async (req, res) => {
        const projectId = toPositiveInteger(req.body?.projectId);
        const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
        const sequence = req.body?.sequence;
        if (!projectId || !title || title.length > 120 || !Array.isArray(sequence) || sequence.length === 0 || sequence.length > 500) {
            return res.status(400).json({ error: 'A valid project, title, and story sequence are required.' });
        }
        try {
            const url = await publishProject(projectId, title, sequence, publicDir);
            res.json({ success: true, url });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.get('/exports', async (req, res) => {
        try {
            const exportDir = path.join(publicDir, 'exports');
            if (!await fs.pathExists(exportDir)) return res.json([]);
            const dirs = await fs.readdir(exportDir);
            const builds = [];
            for (const dir of dirs) {
                if (await fs.pathExists(path.join(exportDir, dir, 'index.html'))) {
                    builds.push({ name: dir, url: `/exports/${dir}/index.html` });
                }
            }
            res.json(builds.reverse());
        } catch (e) { res.json([]); }
    });

    router.post('/delete_export', async (req, res) => {
        try {
            const name = typeof req.body?.name === 'string' ? req.body.name : '';
            if (!/^[a-z0-9_]{1,140}$/i.test(name)) return res.status(400).json({error:'Invalid name'});
            const exportPath = path.join(publicDir, 'exports', name);
            if (await fs.pathExists(exportPath)) {
                await fs.remove(exportPath);
                res.json({ success: true });
            } else {
                res.status(404).json({ error: 'Not found' });
            }
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    return router;
};

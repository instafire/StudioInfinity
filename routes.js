const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const { getDB } = require('./database');
const { publishProject } = require('./publisher');
const ffmpeg = require('fluent-ffmpeg');

module.exports = (upload, publicDir) => {

    // --- 1. PROJECT ROUTES ---
    router.get('/projects', async (req, res) => {
        try {
            const rows = await getDB().all('SELECT * FROM projects ORDER BY id DESC');
            res.json(rows);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/projects', async (req, res) => {
        try {
            await getDB().run('INSERT INTO projects (title) VALUES (?)', [req.body.title]);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/delete_project', async (req, res) => {
        try {
            const { id } = req.body;
            const videos = await getDB().all('SELECT filepath, thumbnail FROM videos WHERE project_id = ?', [id]);
            const clips = await getDB().all('SELECT filepath, thumbnail FROM clips WHERE project_id = ?', [id]);
            
            const filesToDelete = [];
            videos.forEach(v => {
                if(v.filepath) filesToDelete.push(path.join(publicDir, v.filepath));
                if(v.thumbnail) filesToDelete.push(path.join(publicDir, v.thumbnail));
            });
            clips.forEach(c => {
                if(c.filepath && !c.name.startsWith('FULL:')) filesToDelete.push(path.join(publicDir, c.filepath));
                if(c.thumbnail && !c.thumbnail.includes(c.source_video_id)) filesToDelete.push(path.join(publicDir, c.thumbnail));
            });

            for(const file of filesToDelete) {
                if(await fs.pathExists(file)) await fs.remove(file);
            }

            await getDB().run('DELETE FROM projects WHERE id = ?', [id]);
            await getDB().run('DELETE FROM videos WHERE project_id = ?', [id]);
            await getDB().run('DELETE FROM clips WHERE project_id = ?', [id]);
            await getDB().run('DELETE FROM edges WHERE project_id = ?', [id]);
            await getDB().run('DELETE FROM variables WHERE project_id = ?', [id]);
            try { await getDB().run('DELETE FROM analytics WHERE project_id = ?', [id]); } catch(e){} 

            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/project/settings', async (req, res) => {
        try {
            await getDB().run('UPDATE projects SET theme_color = ? WHERE id = ?', [req.body.color, req.body.id]);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // --- VARIABLE ROUTES ---
    router.get('/variables', async (req, res) => {
        try {
            const rows = await getDB().all('SELECT * FROM variables WHERE project_id = ? ORDER BY name ASC', [req.query.projectId || 1]);
            res.json(rows);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/variables', async (req, res) => {
        const { projectId, name, initialValue, description } = req.body;
        try {
            const exists = await getDB().get('SELECT * FROM variables WHERE project_id = ? AND name = ?', [projectId, name]);
            if (exists) {
                await getDB().run('UPDATE variables SET initial_value = ?, description = ? WHERE id = ?', [initialValue, description, exists.id]);
            } else {
                await getDB().run('INSERT INTO variables (project_id, name, initial_value, description) VALUES (?, ?, ?, ?)', [projectId, name, initialValue || 0, description || '']);
            }
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/variable/delete', async (req, res) => {
        try {
            await getDB().run('DELETE FROM variables WHERE id = ?', [req.body.id]);
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
        const projectId = req.body.projectId || 1;
        if (!req.file) return res.status(400).json({ error: "No file" });

        try {
            if (req.file.mimetype.startsWith('audio')) {
                return res.json({ success: true, type: 'audio', path: `/audio/${req.file.filename}`, name: req.file.originalname });
            }

            const filename = req.file.filename;
            const webPath = `/videos/${filename}`;
            const videoPath = req.file.path;

            const generateThumbnail = () => {
                return new Promise((resolve) => {
                    const thumbName = filename.replace(path.extname(filename), '') + `_${Date.now()}.jpg`;
                    ffmpeg(videoPath).screenshots({ timestamps: ['20%'], filename: thumbName, folder: path.join(publicDir, 'thumbnails'), size: '640x360' })
                    .on('end', () => resolve(`/thumbnails/${thumbName}`))
                    .on('error', () => resolve(null));
                });
            };

            ffmpeg.ffprobe(videoPath, async (err, metadata) => {
                const duration = metadata ? metadata.format.duration : 0;
                const thumbnail = await generateThumbnail();
                
                try {
                    const result = await getDB().run('INSERT INTO videos (project_id, filename, filepath, thumbnail, duration) VALUES (?, ?, ?, ?, ?)', [projectId, req.file.originalname, webPath, thumbnail, duration]);
                    const clipId = uuidv4();
                    await getDB().run('INSERT INTO clips (unique_id, project_id, name, filepath, thumbnail, source_video_id, duration, x, y) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [clipId, projectId, `FULL: ${req.file.originalname}`, webPath, thumbnail, result.lastID, duration, 100, 100]);
                    res.json({ success: true, type: 'video' });
                } catch(dbErr) { res.status(500).json({ error: 'Database save failed' }); }
            });
        } catch(err) { res.status(500).json({ error: 'Upload process failed' }); }
    });

    // --- 4. CLIP & LOGIC ROUTES ---
    router.post('/clip', async (req, res) => {
        const { projectId, sourceId, start, end, name, filter, speed, volume } = req.body;
        try {
            const video = await getDB().get('SELECT * FROM videos WHERE id = ?', [sourceId]);
            if (!video) return res.status(404).json({ error: 'Source video not found' });

            // FIX: Enforce float numbers to prevent strings in DB (Essential for Smart Skip math)
            const fStart = parseFloat(start);
            const fEnd = parseFloat(end);
            let duration = fEnd - fStart;
            
            // FIX: Ensure minimum valid duration for FFmpeg
            if(isNaN(duration) || duration <= 0) duration = 0.5;

            const clipId = uuidv4();
            const outputFilename = `clip_${clipId}.mp4`;
            const outputPath = path.join(publicDir, 'clips', outputFilename);
            
            let command = ffmpeg(path.join(publicDir, video.filepath)).setStartTime(fStart).setDuration(duration);
            if(speed && parseFloat(speed)!==1.0) { command.audioFilters(`atempo=${parseFloat(speed)}`); duration = duration/parseFloat(speed); command.videoFilters(`setpts=${1/parseFloat(speed)}*PTS`); }
            if(filter && filter!=='none') { if(filter==='bw') command.videoFilters('hue=s=0'); if(filter==='sepia') command.videoFilters('colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131'); if(filter==='vivid') command.videoFilters('eq=saturation=2'); }
            if(volume && parseFloat(volume)!==1.0) command.audioFilters(`volume=${parseFloat(volume)}`);

            command.videoCodec('libx264').audioCodec('aac').outputOptions('-preset ultrafast').output(outputPath)
                .on('end', async () => {
                    const webPath = `/clips/${outputFilename}`;
                    // FIX: Pass parsed floats to DB
                    await getDB().run('INSERT INTO clips (unique_id, project_id, name, filepath, thumbnail, source_video_id, duration, start_time, end_time, x, y, is_event_clip, is_game_over) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)', 
                        [clipId, projectId, name, webPath, video.thumbnail, sourceId, duration, fStart, fEnd, 150, 150]);
                    res.json({ success: true });
                })
                .on('error', (err) => res.status(500).json({ error: err.message }))
                .run();
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/create_event_clip', async (req, res) => {
        const { projectId, sourceId, start, end, name, choices } = req.body;
        try {
            const video = await getDB().get('SELECT * FROM videos WHERE id = ?', [sourceId]);
            if (!video) return res.status(404).json({ error: 'Source video not found' });

            const sourcePath = path.join(publicDir, video.filepath);
            const clipId = uuidv4();
            const outputFilename = `event_${clipId}.mp4`;
            const outputPath = path.join(publicDir, 'clips', outputFilename);
            
            // FIX: Robust Time Parsing for Event Clips
            const fStart = parseFloat(start);
            const fEnd = parseFloat(end);
            const duration = Math.max(0.5, fEnd - fStart);

            await new Promise((resolve, reject) => {
                ffmpeg(sourcePath).setStartTime(fStart).setDuration(duration).output(outputPath)
                    .on('end', resolve).on('error', reject).run();
            });

            const webPath = `/clips/${outputFilename}`;
            // FIX: Insert parsed floats and flag as is_event_clip
            await getDB().run('INSERT INTO clips (unique_id, project_id, name, filepath, thumbnail, source_video_id, duration, start_time, end_time, x, y, is_event_clip, is_game_over) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)', 
                [clipId, projectId, name, webPath, video.thumbnail, sourceId, duration, fStart, fEnd, 150, 150]);

            if (choices && choices.length > 0) {
                const triggerTime = Math.max(0, duration - 0.5); 
                for (const ch of choices) {
                    if(ch.label) {
                        await getDB().run('INSERT INTO edges (project_id, from_id, to_id, label, text_color, trigger_time, return_to_main, set_var, req_var, x, y) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [projectId, clipId, ch.toId, ch.label, ch.color, triggerTime, ch.returnToMain ? 1 : 0, ch.setVar, ch.reqVar, ch.x || 50, ch.y || 50]);
                    }
                }
            }
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });
    
    router.post('/update_event_logic', async (req, res) => {
        const { projectId, clipId, name, choices } = req.body;
        try {
            await getDB().run('UPDATE clips SET name = ? WHERE unique_id = ?', [name, clipId]);
            await getDB().run('DELETE FROM edges WHERE from_id = ?', [clipId]);
            
            const clip = await getDB().get('SELECT duration FROM clips WHERE unique_id = ?', [clipId]);
            const duration = clip ? clip.duration : 1;
            const triggerTime = Math.max(0, duration - 0.5);

            if(choices && choices.length > 0) {
                for(const ch of choices) {
                    if(ch.label) {
                        await getDB().run('INSERT INTO edges (project_id, from_id, to_id, label, text_color, trigger_time, return_to_main, set_var, req_var, x, y) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [projectId, clipId, ch.toId, ch.label, ch.color, triggerTime, ch.returnToMain?1:0, ch.setVar, ch.reqVar, ch.x||50, ch.y||50]);
                    }
                }
            }
            res.json({ success: true });
        } catch(err) { res.status(500).json({ error: err.message }); }
    });

    // UPDATED: Saves x, y positions and logic blocks
    router.post('/save_logic_block', async (req, res) => {
        const { projectId, fromId, logicId, triggerTime, choices, bgMusic, muteAudio } = req.body; 
        try {
            await getDB().run('UPDATE clips SET bg_music = ?, mute_audio = ? WHERE unique_id = ?', [bgMusic, muteAudio ? 1 : 0, fromId]);
            const newLogicId = logicId || uuidv4();
            if(logicId) await getDB().run('DELETE FROM edges WHERE logic_id = ?', [logicId]);
            else await getDB().run('DELETE FROM edges WHERE from_id = ? AND trigger_time BETWEEN ? AND ?', [fromId, triggerTime - 0.05, triggerTime + 0.05]);
            
            if (choices && Array.isArray(choices)) {
                for (const choice of choices) { 
                    await getDB().run('INSERT INTO edges (project_id, from_id, to_id, label, text_color, trigger_time, logic_id, return_to_main, set_var, req_var, x, y) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', 
                    [projectId, fromId, choice.toId || null, choice.label || 'Choice', choice.color || '#ffffff', triggerTime, newLogicId, choice.return ? 1 : 0, choice.setVar, choice.reqVar, choice.x || 50, choice.y || 50]); 
                }
            }
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/delete_logic_block', async (req, res) => { 
        const { logicId, fromId, triggerTime } = req.body; 
        try { 
            if (logicId) await getDB().run('DELETE FROM edges WHERE logic_id = ?', [logicId]); 
            else await getDB().run('DELETE FROM edges WHERE from_id = ? AND trigger_time BETWEEN ? AND ?', [fromId, triggerTime - 0.02, triggerTime + 0.02]); 
            res.json({ success: true }); 
        } catch(err) { res.status(500).json({error: err.message}); } 
    });

    router.post('/clip/positions', async (req, res) => {
        try {
            for(const u of req.body.updates) await getDB().run('UPDATE clips SET x = ?, y = ? WHERE unique_id = ?', [u.x, u.y, u.id]);
            res.json({ success: true });
        } catch(err) { res.status(500).json({error: err.message}); }
    });
    
    router.post('/clip/update', async (req, res) => {
        const { id, name, isGameOver } = req.body;
        try {
            await getDB().run('UPDATE clips SET name = ?, is_game_over = ? WHERE unique_id = ?', [name, isGameOver?1:0, id]);
            res.json({ success: true });
        } catch(err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/edge/create', async (req, res) => {
        const { projectId, fromId, toId } = req.body;
        try {
            const clip = await getDB().get('SELECT duration FROM clips WHERE unique_id = ?', [fromId]);
            const triggerTime = clip ? Math.max(0, clip.duration - 0.5) : 0;
            const logicId = uuidv4();

            await getDB().run(
                'INSERT INTO edges (project_id, from_id, to_id, label, trigger_time, logic_id, x, y) VALUES (?, ?, ?, ?, ?, ?, 50, 50)', 
                [projectId, fromId, toId, 'Next Scene', triggerTime, logicId]
            );
            res.json({ success: true });
        } catch(err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/edge/delete', async (req, res) => {
        try {
            await getDB().run('DELETE FROM edges WHERE id = ?', [req.body.id]);
            res.json({ success: true });
        } catch(err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/delete_video', async (req, res) => { 
        try {
            const vid = await getDB().get('SELECT * FROM videos WHERE id = ?', [req.body.id]); 
            if(vid) { 
                await fs.remove(path.join(publicDir, vid.filepath));
                await getDB().run('DELETE FROM videos WHERE id = ?', [req.body.id]); 
                await getDB().run('DELETE FROM clips WHERE source_video_id = ?', [req.body.id]); 
            } 
            res.json({ success: true }); 
        } catch(err) { res.status(500).json({ error: 'Failed' }); }
    });

    router.post('/delete_clip', async (req, res) => { 
        try {
            const clip = await getDB().get('SELECT * FROM clips WHERE unique_id = ?', [req.body.unique_id]); 
            if(clip && !clip.name.startsWith('FULL:')) { 
                await fs.remove(path.join(publicDir, clip.filepath));
                await getDB().run('DELETE FROM clips WHERE unique_id = ?', [req.body.unique_id]); 
                await getDB().run('DELETE FROM edges WHERE from_id = ? OR to_id = ?', [req.body.unique_id, req.body.unique_id]); 
            } 
            res.json({ success: true }); 
        } catch(err) { res.status(500).json({ error: 'Failed' }); }
    });

    router.post('/delete_clips_bulk', async (req, res) => {
        const { ids } = req.body;
        let count = 0;
        try {
            for (const id of ids) {
                const clip = await getDB().get('SELECT * FROM clips WHERE unique_id = ?', [id]);
                if (clip && !clip.name.startsWith('FULL:')) {
                    const filePath = path.join(publicDir, clip.filepath);
                    if (await fs.pathExists(filePath)) await fs.remove(filePath);
                    await getDB().run('DELETE FROM clips WHERE unique_id = ?', [id]);
                    await getDB().run('DELETE FROM edges WHERE from_id = ? OR to_id = ?', [id, id]);
                    count++;
                }
            }
            res.json({ success: true, count });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/clip/thumbnail', async (req, res) => {
        const { id, time } = req.body;
        try {
            const clip = await getDB().get('SELECT * FROM clips WHERE unique_id = ?', [id]);
            if (!clip) return res.status(404).json({ error: 'Clip not found' });
            const videoPath = path.join(publicDir, clip.filepath);
            const thumbName = `thumb_${id}_${Date.now()}.jpg`;
            await new Promise((resolve, reject) => {
                ffmpeg(videoPath).screenshots({ timestamps: [time], filename: thumbName, folder: path.join(publicDir, 'thumbnails'), size: '640x360' })
                    .on('end', resolve).on('error', reject);
            });
            const newThumbPath = `/thumbnails/${thumbName}`;
            await getDB().run('UPDATE clips SET thumbnail = ? WHERE unique_id = ?', [newThumbPath, id]);
            if (clip.name.startsWith('FULL:')) await getDB().run('UPDATE videos SET thumbnail = ? WHERE id = ?', [newThumbPath, clip.source_video_id]);
            res.json({ success: true, thumbnail: newThumbPath });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.get('/analytics/:id', async (req, res) => {
        try {
            const rows = await getDB().all('SELECT choice_label, COUNT(*) as count FROM analytics WHERE project_id = ? GROUP BY choice_label ORDER BY count DESC', [req.params.id]);
            res.json(rows);
        } catch (e) { res.json([]); }
    });

    router.post('/analytics/track', async (req, res) => {
        try {
            const { projectId, label, target } = req.body;
            await getDB().run('INSERT INTO analytics (project_id, choice_label, target_clip_id) VALUES (?, ?, ?)', [projectId, label, target]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/analytics/reset', async (req, res) => {
        try {
            await getDB().run('DELETE FROM analytics WHERE project_id = ?', [req.body.projectId]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/publish', async (req, res) => {
        const { projectId, title, sequence } = req.body;
        if (!projectId || !title || !sequence) return res.status(400).json({ error: 'Missing fields' });
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
            const { name } = req.body;
            if (!name || name.includes('..') || name.includes('/')) return res.status(400).json({error:'Invalid name'});
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
const fs = require('fs-extra');
const path = require('path');
const { getDB } = require('./database');
const { escapeHtml, normalizeThemeColor, resolvePublicAssetPath } = require('./lib/security');

/**
 * Publishes the project to a standalone HTML build.
 */
async function publishProject(projectId, title, sequence, publicDir) {
    const normalizedProjectId = Number(projectId);
    const safeTitle = typeof title === 'string' ? title.trim().slice(0, 120) : '';
    if (!Number.isSafeInteger(normalizedProjectId) || normalizedProjectId <= 0) throw new Error('Invalid project ID.');
    if (!safeTitle) throw new Error('A project title is required.');
    if (!Array.isArray(sequence) || sequence.length === 0 || sequence.length > 500 || sequence.some(item => !item || typeof item.id !== 'string')) {
        throw new Error('A valid story sequence is required.');
    }

    const db = getDB();
    const project = await db.get('SELECT * FROM projects WHERE id = ?', [normalizedProjectId]);
    if (!project) throw new Error('Project not found');

    const themeColor = normalizeThemeColor(project.theme_color);
    // Create a safe folder name
    const exportName = `${safeTitle.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_${normalizedProjectId}`;
    const exportPath = path.join(publicDir, 'exports', exportName);

    // 1. Gather Assets
    let allClips = await db.all('SELECT * FROM clips WHERE project_id = ?', [normalizedProjectId]);
    const edges = await db.all('SELECT * FROM edges WHERE project_id = ? ORDER BY trigger_time ASC', [normalizedProjectId]);
    const variables = await db.all('SELECT * FROM variables WHERE project_id = ?', [normalizedProjectId]);
    const projectClipIds = new Set(allClips.map(clip => clip.unique_id));
    if (sequence.some(item => !projectClipIds.has(item.id))) throw new Error('Story sequence contains a clip from another project.');
    if (edges.some(edge => !projectClipIds.has(edge.from_id) || (edge.to_id && !projectClipIds.has(edge.to_id)))) {
        throw new Error('Story graph contains an edge to a clip outside this project.');
    }
    const reservedVariableNames = new Set(['__proto__', 'constructor', 'prototype']);
    const exportVariables = variables.filter(variable => typeof variable.name === 'string' &&
        /^[a-z][a-z0-9_]{0,39}$/i.test(variable.name) && !reservedVariableNames.has(variable.name.toLowerCase()));
    const exportVariableNames = new Set(exportVariables.map(variable => variable.name));

    // Filter down to only clips used in the sequence or as options
    const usedClipIds = new Set();
    sequence.forEach(item => usedClipIds.add(item.id));
    edges.forEach(e => {
        if (e.to_id) usedClipIds.add(e.to_id);
        if (e.from_id && usedClipIds.has(e.from_id)) usedClipIds.add(e.from_id);
    });

    const clips = allClips.filter(c => usedClipIds.has(c.unique_id));
    const assetSources = new Map();
    for (const clip of clips) {
        const videoSource = await resolvePublicAssetPath(publicDir, clip.filepath);
        if (!videoSource) throw new Error('A story clip is missing or has an unsafe media path.');
        const thumbnailSource = clip.thumbnail ? await resolvePublicAssetPath(publicDir, clip.thumbnail) : null;
        const audioSource = clip.bg_music ? await resolvePublicAssetPath(publicDir, clip.bg_music) : null;
        assetSources.set(clip.unique_id, { videoSource, thumbnailSource, audioSource });
    }

    // --- SMART SKIP CALCULATION ---
    // This logic pre-calculates redundant video segments to skip them in the player
    clips.forEach(parentClip => {
        parentClip.skipRanges = [];
        
        // RULE 1: Only apply Smart Skip to MAIN MOVIE clips.
        // Event Clips (interactive scenes) must NEEVER be skipped.
        if (parentClip.is_event_clip !== 1 && parentClip.source_video_id) {
            
            // 1. Determine safe start/end times for the parent
            const pStart = parseFloat(parentClip.start_time) || 0;
            const pDuration = parseFloat(parentClip.duration) || 0;
            // If cut point is missing, assume full duration
            const pEnd = (parentClip.end_time && parseFloat(parentClip.end_time) > 0) 
                         ? parseFloat(parentClip.end_time) 
                         : (pStart + pDuration);

            const pSourceId = parentClip.source_video_id;

            allClips.forEach(subClip => {
                // Ignore self
                if (subClip.unique_id === parentClip.unique_id) return;
                
                // Must share exact source video ID
                if (String(subClip.source_video_id) !== String(pSourceId)) return;
                
                // OPTIONAL: Don't use other event clips as skip sources to keep things clean
                if (subClip.is_event_clip === 1) return;

                // 2. Determine safe start/end for the sub-clip
                const sStart = parseFloat(subClip.start_time) || 0;
                const sDuration = parseFloat(subClip.duration) || 0;
                const sEnd = (subClip.end_time && parseFloat(subClip.end_time) > 0)
                             ? parseFloat(subClip.end_time)
                             : (sStart + sDuration);

                // 3. Check Overlap
                // Is the sub-clip effectively inside the parent clip?
                if (sStart >= (pStart - 0.1) && sEnd <= (pEnd + 0.1)) {
                    const relStart = Math.max(0, sStart - pStart);
                    const relEnd = Math.min(pEnd, sEnd) - pStart;

                    // Ensure the skip is substantial enough (> 0.5s)
                    if (relEnd > relStart + 0.5) {
                        parentClip.skipRanges.push({
                            start: parseFloat(relStart.toFixed(2)),
                            end: parseFloat(relEnd.toFixed(2))
                        });
                    }
                }
            });

            // 4. Sort & Merge Overlapping Ranges
            if (parentClip.skipRanges.length > 0) {
                parentClip.skipRanges.sort((a,b) => a.start - b.start);
                const merged = [];
                let current = parentClip.skipRanges[0];
                for (let i = 1; i < parentClip.skipRanges.length; i++) {
                    const next = parentClip.skipRanges[i];
                    if (current.end >= next.start) {
                        current.end = Math.max(current.end, next.end);
                    } else {
                        merged.push(current);
                        current = next;
                    }
                }
                merged.push(current);
                parentClip.skipRanges = merged;
            }
        }
    });

    // 3. Prepare and copy files only after every required video asset passes validation.
    await fs.emptyDir(exportPath);
    await fs.ensureDir(path.join(exportPath, 'clips'));
    await fs.ensureDir(path.join(exportPath, 'audio'));

    for (const clip of clips) {
        const sources = assetSources.get(clip.unique_id);
        // Copy Video
        const filename = path.basename(sources.videoSource);
        await fs.copy(sources.videoSource, path.join(exportPath, 'clips', filename));
        clip.filepath = `clips/${filename}`;
        
        // Copy Thumbnail
        if (sources.thumbnailSource) {
            const thumbName = path.basename(sources.thumbnailSource);
            await fs.copy(sources.thumbnailSource, path.join(exportPath, 'clips', thumbName));
            clip.thumbnail = `clips/${thumbName}`;
        } else {
            clip.thumbnail = '';
        }

        // Copy Audio
        if (sources.audioSource) {
            const audName = path.basename(sources.audioSource);
            await fs.copy(sources.audioSource, path.join(exportPath, 'audio', audName));
            clip.bg_music = `audio/${audName}`;
        } else {
            clip.bg_music = '';
        }
    }

    // 4. Build Logic Blocks
    const logicBlocks = Object.create(null);
    edges.forEach(e => {
        if (!e.to_id) return;
        const key = e.logic_id || `time_${e.trigger_time}_${e.from_id}`;
        if (!logicBlocks[key]) {
            logicBlocks[key] = { 
                id: key, 
                from: e.from_id, 
                time: e.trigger_time, 
                choices: [] 
            };
        }
        logicBlocks[key].choices.push({
            to: e.to_id, 
            label: e.label, 
            color: normalizeThemeColor(e.text_color, '#ffffff'),
            return: !!e.return_to_main, 
            setVar: exportVariableNames.has(e.set_var) ? e.set_var : null,
            reqVar: exportVariableNames.has(e.req_var) ? e.req_var : null
        });
    });

    // 5. Generate HTML
    const htmlContent = generateHTMLTemplate(safeTitle, themeColor, clips, logicBlocks, sequence, exportVariables, normalizedProjectId);
    await fs.writeFile(path.join(exportPath, 'index.html'), htmlContent);

    return `/exports/${exportName}/index.html`;
}

function generateHTMLTemplate(title, themeColor, clips, logicBlocks, sequence, variables, projectId) {
    const safeTitle = escapeHtml(title);
    const safeThemeColor = normalizeThemeColor(themeColor);
    // Embed data directly into HTML
    const clipsB64 = Buffer.from(JSON.stringify(clips)).toString('base64');
    const blocksB64 = Buffer.from(JSON.stringify(Object.values(logicBlocks))).toString('base64');
    const playlistB64 = Buffer.from(JSON.stringify(sequence || [])).toString('base64');
    
    // Create initial game state from variables
    const initialState = Object.create(null);
    variables.filter(v => typeof v.name === 'string' && /^[a-z][a-z0-9_]{0,39}$/i.test(v.name) && !['__proto__', 'constructor', 'prototype'].includes(v.name.toLowerCase()))
        .forEach(v => initialState[v.name] = v.initial_value === 1);
    const stateB64 = Buffer.from(JSON.stringify(initialState)).toString('base64');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${safeTitle}</title>
    
    <script src="https://unpkg.com/vue@3/dist/vue.global.js"></script>
    <script src="https://cdn.tailwindcss.com"></script>
    
    <style>
        body { background: #000; color: #fff; font-family: 'Inter', sans-serif; overflow: hidden; user-select: none; }
        
        .video-container { width: 100vw; height: 100vh; position: relative; display: flex; align-items: center; justify-content: center; background: black; }
        video { max-width: 100%; max-height: 100%; object-fit: contain; }
        
        /* --- CONTROLS BAR --- */
        .controls-bar { 
            position: absolute; bottom: 0; left: 0; width: 100%; 
            background: linear-gradient(to top, rgba(0,0,0,0.9), transparent); 
            padding: 20px; display: flex; align-items: center; gap: 15px; 
            opacity: 0; transition: opacity 0.3s; z-index: 60; 
        }
        .video-container:hover .controls-bar { opacity: 1; }
        
        .timeline-track { 
            flex: 1; height: 10px; background: rgba(255,255,255,0.15); 
            border-radius: 5px; cursor: pointer; position: relative; overflow: hidden; 
            transition: height 0.2s;
        }
        .timeline-track:hover { height: 14px; }
        
        .timeline-fill { 
            height: 100%; background: ${safeThemeColor};
            border-radius: 5px; position: absolute; top: 0; left: 0; z-index: 20;
        }
        .timeline-marker { 
            width: 10px; height: 10px; background: #fbbf24; border-radius: 50%; 
            position: absolute; top: 50%; transform: translate(-50%, -50%); 
            z-index: 30; pointer-events: none; box-shadow: 0 0 6px #fbbf24; 
        }
        
        /* --- VISUAL SKIP INDICATORS --- */
        .timeline-skip-zone {
            position: absolute; top: 0; bottom: 0;
            background: repeating-linear-gradient(
                -45deg,
                rgba(220, 38, 38, 0.6),
                rgba(220, 38, 38, 0.6) 5px,
                rgba(220, 38, 38, 0.3) 5px,
                rgba(220, 38, 38, 0.3) 10px
            );
            z-index: 10;
            border-left: 2px solid #ef4444;
            border-right: 2px solid #ef4444;
            pointer-events: none;
            opacity: 0.8;
        }

        /* --- OVERLAYS --- */
        .overlay-layer { position: absolute; inset: 0; z-index: 50; display: flex; flex-direction: column; align-items: center; justify-content: center; pointer-events: auto; }
        .overlay-content { width: 100%; padding: 2rem; display: flex; flex-direction: column; align-items: center; }
        
        @keyframes popIn { 0% { opacity: 0; transform: scale(0.95); } 100% { opacity: 1; transform: scale(1); } }
        .animate-pop { animation: popIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards; }

        .start-screen { position: absolute; inset: 0; z-index: 50; background: url('https://source.unsplash.com/random/1920x1080?cinema') center/cover; display: flex; align-items: center; justify-content: center; }
        .start-overlay { background: rgba(0,0,0,0.85); inset: 0; position: absolute; }
        .start-content { position: relative; z-index: 10; text-align: center; }
        .play-btn-huge { font-size: 5rem; color: ${safeThemeColor}; cursor: pointer; transition: transform 0.2s; filter: drop-shadow(0 0 20px ${safeThemeColor}); }
        .play-btn-huge:hover { transform: scale(1.1); color: #fff; }

        .glitch { font-size: 3rem; font-weight: bold; color: #ef4444; text-shadow: 2px 2px #000; animation: glitch 1s infinite; margin-bottom: 2rem; }
        @keyframes glitch { 0%{transform:translate(0)} 20%{transform:translate(-2px,2px)} 40%{transform:translate(-2px,-2px)} 60%{transform:translate(2px,2px)} 80%{transform:translate(2px,-2px)} 100%{transform:translate(0)} }

        /* --- SMART SKIP NOTIFICATION --- */
        .skip-notify {
            position: absolute; top: 30px; right: 30px;
            background: rgba(0,0,0,0.8); border: 1px solid #ef4444;
            color: #ef4444; padding: 10px 20px; border-radius: 30px;
            font-size: 0.9rem; font-weight: 800; letter-spacing: 1px;
            display: flex; align-items: center; gap: 10px;
            box-shadow: 0 0 15px rgba(239, 68, 68, 0.4);
            animation: slideIn 0.3s ease-out; z-index: 70;
            text-transform: uppercase;
        }
        @keyframes slideIn { from { transform: translateX(20px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        .fade-leave-active { transition: opacity 0.5s; }
        .fade-leave-to { opacity: 0; }
    </style>
</head>
<body>
    <div id="app" v-cloak>
        <div class="video-container">
            <video ref="videoPlayer" 
                   @timeupdate="onTimeUpdate" 
                   @ended="onClipEnded" 
                   @click="togglePlay"
                   playsinline 
                   webkit-playsinline>
            </video>

            <transition name="fade">
                <div v-if="showSkipNotify" class="skip-notify">
                    <span>Smart Skip Active</span> ⏩
                </div>
            </transition>

            <div class="controls-bar" v-if="started && !isGameOver && !showChoices">
                <button @click="togglePlay" class="text-xl w-6 hover:text-blue-400 transition">{{ isPaused ? '▶' : '⏸' }}</button>
                
                <div class="timeline-track" @click="seek">
                    <div v-for="(rng, i) in currentSkipVisuals" :key="'skip-'+i" 
                         class="timeline-skip-zone" 
                         :style="{ left: rng.left + '%', width: rng.width + '%' }"
                         title="Smart Skip">
                    </div>

                    <div class="timeline-fill" :style="{width: progress+'%'}"></div>
                    
                    <div v-for="(m, i) in timelineMarkers" :key="i" 
                         class="timeline-marker" 
                         :style="{left: m.pct+'%'}" 
                         title="Decision Point">
                    </div>
                </div>
                
                <div class="text-xs font-mono text-slate-300 w-24 text-right">
                    {{ formatTime(displayTime) }} / {{ formatTime(displayDuration) }}
                </div>
                
                <button @click="toggleSpeed" class="text-xs font-bold px-2 py-1 bg-white/10 rounded hover:bg-white/20 border border-white/20 min-w-[60px]">
                    {{ playbackRate }}x
                </button>
                
                <div class="flex items-center gap-1">
                    <span class="text-sm">🔊</span>
                    <input type="range" min="0" max="1" step="0.1" v-model="volume" @input="updateVolume" class="w-16 accent-blue-500 h-1 cursor-pointer">
                </div>
            </div>

            <div v-if="showChoices" class="overlay-layer animate-pop" style="background: rgba(0,0,0,0.4); backdrop-filter: blur(4px);">
                <div class="overlay-content">
                    <h2 class="text-3xl font-bold mb-10 text-white drop-shadow-md tracking-widest uppercase">Make Your Choice</h2>
                    
                    <div class="flex flex-wrap justify-center gap-8">
                        <div v-for="(ch, idx) in currentChoices" 
                             @click="makeChoice(ch)"
                             class="relative w-64 h-36 md:w-80 md:h-44 group rounded-xl border-2 cursor-pointer overflow-hidden transition-all duration-300 hover:scale-105"
                             :class="{ 'opacity-50 grayscale pointer-events-none': isLocked(ch) }"
                             :style="{ 
                                borderColor: ch.color || 'rgba(255,255,255,0.2)',
                                boxShadow: '0 0 20px ' + (ch.color || 'rgba(255,255,255,0.2)')
                             }">
                             
                            <img :src="getClipThumb(ch.to)" 
                                 class="absolute inset-0 w-full h-full object-cover opacity-80 group-hover:opacity-100 transition duration-500 scale-100 group-hover:scale-110">
                            
                            <div class="absolute bottom-0 left-0 w-full p-3 text-center font-bold text-lg tracking-wide bg-gradient-to-t from-black via-black/80 to-transparent pt-10" 
                                 :style="{ color: ch.color || '#fff' }">
                                {{ ch.label }}
                            </div>

                            <div v-if="isLocked(ch)" class="absolute inset-0 flex items-center justify-center bg-black/70 backdrop-blur-sm">
                                <span class="text-4xl">🔒</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div v-if="isGameOver" class="overlay-layer bg-black/95">
                <h1 class="glitch">GAME OVER</h1>
                <div class="flex gap-4 pointer-events-auto">
                    <button @click="retryFromFail" class="px-8 py-3 bg-white text-black font-bold rounded-full hover:scale-105 transition shadow-[0_0_20px_rgba(255,255,255,0.3)]">
                        🔄 Try Again
                    </button>
                    <button @click="restartGame" class="px-8 py-3 border border-white/30 text-slate-400 font-bold rounded-full hover:text-white hover:border-white transition">
                        🏠 Menu
                    </button>
                </div>
            </div>

            <div v-if="!started" class="start-screen">
                <div class="start-overlay"></div>
                <div class="start-content">
                    <h1 class="text-4xl font-bold mb-2 tracking-widest uppercase text-white">${safeTitle}</h1>
                    <div class="play-btn-huge" @click="startStory">▶</div>
                    <div class="text-slate-400 mt-4 text-sm uppercase tracking-wider">Interactive Experience</div>
                </div>
            </div>
            
            <audio ref="bgm" loop></audio>
        </div>
    </div>

    <script>
        // Inject Base64 data from the build process
        const CLIPS = JSON.parse(atob('${clipsB64}')); 
        const BLOCKS = JSON.parse(atob('${blocksB64}')); 
        const PLAYLIST = JSON.parse(atob('${playlistB64}')); 
        const INIT_STATE = JSON.parse(atob('${stateB64}'));

        const { createApp } = Vue;
        
        createApp({
            data() {
                return { 
                    started: false, 
                    isPaused: false,
                    isSeeking: false, 
                    currentClip: null, 
                    activeBlocks: [], 
                    showChoices: false, 
                    currentChoices: [],
                    playlistIndex: 0,
                    historyStack: [], 
                    isGameOver: false,
                    failSafeState: null,
                    gameState: { ...INIT_STATE },
                    
                    // Smart Skip
                    showSkipNotify: false,
                    skipTimer: null,

                    // Player State
                    currentTime: 0,
                    duration: 0,
                    progress: 0,
                    playbackRate: 1.0,
                    volume: 1.0,
                    timelineMarkers: [],
                    
                    // Display Helpers
                    displayTime: 0,
                    displayDuration: 0
                }
            },
            computed: {
                currentSkipVisuals() {
                    // Don't show visuals for event clips or if duration invalid
                    if (!this.currentClip || this.currentClip.is_event_clip === 1 || !this.currentClip.skipRanges || this.duration <= 0) return [];
                    return this.currentClip.skipRanges.map(r => ({
                        left: (r.start / this.duration) * 100,
                        width: Math.max(1, ((r.end - r.start) / this.duration) * 100) 
                    }));
                }
            },
            methods: {
                startStory() {
                    this.started = true;
                    this.playlistIndex = 0;
                    this.failSafeState = null;
                    this.historyStack = [];
                    this.gameState = { ...INIT_STATE };
                    this.loadClip(PLAYLIST[0].id);
                },
                restartGame() { location.reload(); },
                isLocked(ch) {
                    if(!ch.reqVar) return false;
                    return !this.gameState[ch.reqVar];
                },
                getClipThumb(id) {
                    const c = CLIPS.find(x => x.unique_id === id);
                    return c && c.thumbnail ? c.thumbnail : '';
                },

                // --- PLAYER CONTROLS ---
                togglePlay() {
                    const v = this.$refs.videoPlayer;
                    if(v.paused) { v.play(); this.isPaused = false; }
                    else { v.pause(); this.isPaused = true; }
                },
                toggleSpeed() {
                    const speeds = [1.0, 1.5, 2.0, 0.5];
                    const idx = speeds.indexOf(this.playbackRate);
                    this.playbackRate = speeds[(idx + 1) % speeds.length];
                    if(this.$refs.videoPlayer) this.$refs.videoPlayer.playbackRate = this.playbackRate;
                },
                updateVolume() {
                    const v = this.$refs.videoPlayer;
                    const a = this.$refs.bgm;
                    if(v) v.volume = this.volume;
                    if(a) a.volume = this.volume * 0.3;
                },
                seek(e) {
                    if(!this.currentClip) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    const pct = (e.clientX - rect.left) / rect.width;
                    const v = this.$refs.videoPlayer;
                    if(v) {
                        const targetTime = pct * this.duration;
                        v.currentTime = targetTime;
                        
                        // Only force skip if it's NOT an event clip
                        const isEventClip = this.currentClip.is_event_clip === 1;
                        if (!isEventClip && !this.checkSkip(targetTime)) {
                            if (this.isPaused) v.play();
                            this.isPaused = false;
                        }
                    }
                },
                formatTime(t) {
                    if(!t || t < 0) return '0:00';
                    const m = Math.floor(t / 60);
                    const s = Math.floor(t % 60);
                    return m + ':' + s.toString().padStart(2, '0');
                },

                // --- LOGIC ENGINE ---
                loadClip(id, time = 0) {
                    const nextClip = CLIPS.find(c => c.unique_id === id);
                    if(!nextClip) return console.error("Clip not found:", id);

                    this.currentClip = nextClip;
                    this.showChoices = false;
                    this.isGameOver = false;
                    this.isPaused = false;
                    this.isSeeking = true;

                    const startTime = parseFloat(time) || 0;

                    this.activeBlocks = BLOCKS.filter(b => b.from === id)
                                              .sort((a,b) => a.time - b.time)
                                              .filter(b => b.time >= startTime); 

                    this.timelineMarkers = this.activeBlocks.map(b => ({
                        pct: (b.time / (nextClip.duration || 10)) * 100
                    }));

                    const v = this.$refs.videoPlayer;
                    v.src = nextClip.filepath;
                    
                    v.onloadedmetadata = () => {
                        v.currentTime = startTime;
                        v.muted = !!nextClip.mute_audio;
                        v.volume = this.volume;
                        v.playbackRate = this.playbackRate;
                        
                        this.duration = v.duration;
                        this.displayDuration = v.duration;

                        v.play().then(() => {
                            setTimeout(() => { this.isSeeking = false; }, 100);
                        }).catch(e => console.log("Autoplay blocked"));
                    };
                    
                    if (v.readyState >= 1) v.onloadedmetadata();

                    const a = this.$refs.bgm;
                    if(nextClip.bg_music) {
                        if(!a.src.includes(nextClip.bg_music)) {
                            a.src = nextClip.bg_music;
                            a.volume = this.volume * 0.3;
                            a.play().catch(e => {});
                        }
                    } else { a.pause(); }
                },

                checkSkip(time) {
                    if (!this.currentClip.skipRanges || this.showChoices || this.isSeeking) return false;
                    
                    for (let range of this.currentClip.skipRanges) {
                        if (time >= range.start && time < range.end) {
                            const v = this.$refs.videoPlayer;
                            v.currentTime = range.end + 0.15;
                            
                            this.showSkipNotify = true;
                            if(this.skipTimer) clearTimeout(this.skipTimer);
                            this.skipTimer = setTimeout(() => { this.showSkipNotify = false; }, 2000);
                            return true;
                        }
                    }
                    return false;
                },

                onTimeUpdate() {
                    const v = this.$refs.videoPlayer;
                    if(!v || !this.currentClip || this.isSeeking || !v.duration || v.duration === 0) return;
                    
                    this.currentTime = v.currentTime;
                    this.duration = v.duration;

                    if (this.currentTime >= this.duration - 0.2) {
                        this.onClipEnded();
                        return;
                    }

                    const isEventClip = this.currentClip.is_event_clip === 1;

                    // --- SMART SKIP LOGIC ---
                    // Prevent skipping in event clips
                    if (!isEventClip && this.checkSkip(this.currentTime)) return;

                    // UI PROGRESS
                    this.displayTime = this.currentTime;
                    this.progress = (this.currentTime / this.duration) * 100;

                    if(this.showChoices || this.isGameOver) return;

                    // MISSED BLOCKS CHECK
                    if(this.activeBlocks.length > 0) {
                        if (this.currentTime > this.activeBlocks[0].time + 1.5) {
                            this.activeBlocks.shift(); 
                        }
                    }

                    // TRIGGER CHOICES
                    if(this.activeBlocks.length > 0) {
                        const nextBlock = this.activeBlocks[0];
                        let shouldTrigger = false;

                        if (isEventClip) {
                            // FORCE EVENT CLIPS TO PLAY TO END
                            // Ignore specific block time and wait for clip end
                            if (this.currentTime >= this.duration - 0.5) {
                                shouldTrigger = true;
                            }
                        } else {
                            // NORMAL LOGIC for Main Movie
                            if (this.currentTime >= nextBlock.time && this.currentTime < nextBlock.time + 1.0) {
                                shouldTrigger = true;
                            }
                        }

                        if (shouldTrigger) {
                            v.pause();
                            this.isPaused = true;
                            this.currentChoices = nextBlock.choices;
                            this.showChoices = true;
                            this.activeBlocks.shift(); 
                        }
                    }
                },

                makeChoice(choice) {
                    if(this.isLocked(choice)) return;

                    fetch('/api/analytics/track', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ projectId: ${projectId}, label: choice.label, target: choice.to })
                    }).catch(e => console.warn('Tracking failed', e));

                    if(choice.setVar) this.gameState[choice.setVar] = true;

                    const targetClip = CLIPS.find(c => c.unique_id === choice.to);
                    if(!targetClip) return;

                    if (targetClip.is_game_over == 1 || targetClip.is_game_over === true) {
                        this.failSafeState = { clipId: this.currentClip.unique_id, time: 0 };
                    }

                    if(choice.return) {
                        // Return time logic
                        const relTime = this.currentTime;
                        this.historyStack.push({
                            clipId: this.currentClip.unique_id,
                            time: relTime + 0.5, 
                            remainingBlocks: [...this.activeBlocks]
                        });
                    }

                    this.loadClip(choice.to, 0);
                },

                onClipEnded() {
                    if(this.showChoices) return;
                    
                    if(this.activeBlocks.length > 0) {
                        const nextBlock = this.activeBlocks[0];
                        this.$refs.videoPlayer.pause();
                        this.currentChoices = nextBlock.choices;
                        this.showChoices = true;
                        this.activeBlocks.shift();
                        return;
                    }

                    if(this.currentClip.is_game_over == 1) {
                        this.isGameOver = true;
                        if(this.$refs.bgm) this.$refs.bgm.pause();
                        if (document.fullscreenElement) document.exitFullscreen();
                        return;
                    }
                    if(this.historyStack.length > 0) {
                        const state = this.historyStack.pop();
                        this.activeBlocks = state.remainingBlocks || [];
                        this.loadClip(state.clipId, state.time);
                        return;
                    }
                    this.playlistIndex++;
                    if(this.playlistIndex < PLAYLIST.length) {
                        this.loadClip(PLAYLIST[this.playlistIndex].id);
                    } else {
                        console.log("End of movie");
                        this.started = false;
                    }
                },

                retryFromFail() {
                    if (this.failSafeState) {
                        this.loadClip(this.failSafeState.clipId, this.failSafeState.time);
                        this.failSafeState = null;
                    } else {
                        this.startStory();
                    }
                }
            }
        }).mount('#app');
    </script>
</body>
</html>`;
}

module.exports = { generateHTMLTemplate, publishProject };

const { createApp } = Vue;

createApp({
    data() {
        return {
            // --- CORE VIEW STATE ---
            view: 'projects', 
            projects: [], 
            currentProject: null,
            projectColor: '#3b82f6',
            
            // --- DATA ARRAYS ---
            videos: [], 
            clips: [], 
            edges: [], 
            audioFiles: [], 
            variables: [], 
            
            // --- CLIPPER / UPLOAD STATE ---
            uploading: false, 
            processingClip: false, // NEW: Loading state for clip creation
            selectedFile: null, 
            selectedVidId: null, 
            videoUrl: '', 
            currentVidDuration: 0, 
            currentTime: 0, 
            clipStart: 0, 
            clipEnd: 0, 
            clipName: '', 
            clipFilter: 'none', 
            clipSpeed: 1, 
            clipVolume: 1,
            
            // --- EVENT CREATOR STATE ---
            eventChoices: [{label:'', toId:null, color:'#ffffff', returnToMain:false, setVar:'', reqVar:''}],
            previewEventClip: null, 
            showTestChoices: false, 
            testChoices: [], 
            testHistory: [], 
            testIsReturning: false,
            isEditingEvent: false, 
            editingEventId: null,

            // --- LOGIC EDITOR STATE ---
            logicSourceId: null, 
            logicCurrentTime: 0, 
            showLogicOverlay: false, 
            currentEditingBlock: null, 
            isTestMode: false, 
            historyStack: [], 
            zoomLevel: 100, 
            isPlayingSubClip: false,
            logicBgMusic: null, 
            logicMuteVideo: false,
            seenSegments: [], 
            smartSkipEnabled: true, 
            isManualSeeking: false,

            // --- GRAPH VIEW STATE ---
            isGraphMode: false, 
            isPublishGraphMode: false,
            pan: {x: 50, y: 50}, 
            zoom: 1, 
            isDraggingNode: false, 
            dragNodeId: null, 
            lastMouse: {x:0, y:0},
            // Graph Drawing State
            isDrawingLine: false,
            drawStartNode: null,
            tempLine: null, 

            // --- LIBRARY STATE ---
            librarySelectedClip: null,
            selectionMode: false, 
            selectedClipIds: [],

            // --- VARIABLE MANAGER STATE ---
            newVarName: '',
            newVarVal: 0,

            // --- PREVIEW / PUBLISH STATE ---
            statsData: [], 
            publishTitle: 'My Movie', 
            storySequence: [], 
            publishing: false, 
            publishUrl: '', 
            exportsList: [], 
            previewMode: false, 
            previewPlaylistIndex: 0, 
            previewClip: null, 
            previewActiveBlocks: [], 
            previewCurrentOptions: null, 
            previewShowChoices: false, 
            previewHistoryStack: [], 
            previewGameState: {}, 
            previewIsPlayingSubClip: false, 
            previewDuration: 0, 
            previewCurrentTime: 0, 
            previewIsPaused: false, 
            previewVolume: 1, 
            previewIsGameOver: false, 
            previewFailSafeState: null,
            showDebugPanel: false, 
            draggedSeqIndex: null,

            // --- UI ---
            toast: { show: false, msg: '', type: 'success' }
        }
    },
    computed: {
        // --- TIMELINE HELPERS ---
        playheadPercent() { return this.currentVidDuration ? (this.currentTime / this.currentVidDuration) * 100 : 0; },
        startPercent() { return this.currentVidDuration ? (this.clipStart / this.currentVidDuration) * 100 : 0; },
        endPercent() { return this.currentVidDuration ? (this.clipEnd / this.currentVidDuration) * 100 : 0; },
        
        // --- USAGE BARS (Clipper/Event View) ---
        sourceUsageSegments() {
            if(!this.selectedVidId || !this.currentVidDuration) return [];
            return this.clips.filter(c => 
                c.source_video_id == this.selectedVidId && 
                !c.name.startsWith('FULL:') && 
                c.unique_id !== this.editingEventId
            ).map(c => ({
                left: (c.start_time / this.currentVidDuration) * 100,
                width: Math.max(((c.end_time - c.start_time) / this.currentVidDuration) * 100, 0.5),
                name: c.name
            }));
        },

        // --- USAGE BARS (Logic View) ---
        logicUsageSegments() {
            if(!this.logicSourceClip || !this.logicSourceClip.duration) return [];
            if (!this.logicSourceClip.name.startsWith('FULL:')) return [];

            const sourceId = this.logicSourceClip.source_video_id;
            const totalDur = this.logicSourceClip.duration;

            return this.clips.filter(c => 
                c.source_video_id == sourceId && 
                !c.name.startsWith('FULL:') && 
                c.unique_id !== this.logicSourceId 
            ).map(c => ({
                left: (c.start_time / totalDur) * 100,
                width: Math.max(((c.end_time - c.start_time) / totalDur) * 100, 0.5),
                name: c.name
            }));
        },

        // --- PREVIEW VISUAL SKIPS ---
        previewSkipVisuals() {
            // MATCHED TO PUBLISHER: Don't show markers for event clips
            if (!this.previewClip || this.previewClip.is_event_clip === 1 || !this.previewClip.skipRanges || !this.previewDuration) return [];
            return this.previewClip.skipRanges.map(r => ({
                left: (r.start / this.previewDuration) * 100,
                width: Math.max(1, ((r.end - r.start) / this.previewDuration) * 100)
            }));
        },

        // --- LOGIC HELPERS ---
        logicSourceClip() { return this.clips.find(c => c.unique_id === this.logicSourceId); },
        logicPlayheadPercent() { return (this.logicSourceClip && this.logicSourceClip.duration) ? (this.logicCurrentTime / this.logicSourceClip.duration) * 100 : 0; },
        masterClips() { return this.clips.filter(c => c.name.startsWith('FULL:')); },
        eventClips() { return this.clips.filter(c => c.is_event_clip === 1); },
        subClips() { return this.clips.filter(c => !c.name.startsWith('FULL:') && c.is_event_clip !== 1); },
        
        existingLogicBlocks() {
            if(!this.logicSourceId) return [];
            const myEdges = this.edges.filter(e => e.from_id === this.logicSourceId);
            const blocks = {};
            myEdges.forEach(e => {
                const id = e.logic_id || 'legacy_'+e.trigger_time;
                if(!blocks[id]) blocks[id] = { id, triggerTime: e.trigger_time, choices: [] };
                blocks[id].choices.push({ toId: e.to_id, label: e.label, color: e.text_color, return: !!e.return_to_main, setVar: e.set_var, reqVar: e.req_var });
            });
            return Object.values(blocks).sort((a,b) => a.triggerTime - b.triggerTime);
        },

        // --- GRAPH COMPUTATIONS ---
        displayedGraphNodes() {
            if(this.isPublishGraphMode) {
                const sequenceIds = this.storySequence.map(s => s.id);
                const visitedIds = new Set(sequenceIds);
                const queue = [...sequenceIds];
                while(queue.length > 0) {
                    const currId = queue.shift();
                    const children = this.edges.filter(e => e.from_id === currId).map(e => e.to_id);
                    children.forEach(childId => {
                        if(childId && !visitedIds.has(childId)) { visitedIds.add(childId); queue.push(childId); }
                    });
                }
                return this.clips.filter(c => visitedIds.has(c.unique_id));
            } else {
                if(!this.logicSourceId) return [];
                const childrenIds = this.edges.filter(e => e.from_id === this.logicSourceId).map(e => e.to_id);
                const allIds = [this.logicSourceId, ...childrenIds];
                return this.clips.filter(c => allIds.includes(c.unique_id));
            }
        },
        displayedGraphEdges() {
            const nodes = this.displayedGraphNodes;
            const nodeIds = new Set(nodes.map(n => n.unique_id));
            
            if (this.isPublishGraphMode) {
                const graphEdges = this.edges
                    .filter(e => nodeIds.has(e.from_id) && nodeIds.has(e.to_id))
                    .map(e => this.createEdgeObj(e.id, e.from_id, e.to_id, e.label, !!e.return_to_main, false));
                for (let i = 0; i < this.storySequence.length - 1; i++) {
                    const fromId = this.storySequence[i].id;
                    const toId = this.storySequence[i+1].id;
                    if (nodeIds.has(fromId) && nodeIds.has(toId)) {
                        graphEdges.push(this.createEdgeObj(`seq-${i}`, fromId, toId, "Next Scene", false, true));
                    }
                }
                return graphEdges.filter(x=>x);
            } else {
                if(!this.logicSourceId) return [];
                return this.edges
                    .filter(e => e.from_id === this.logicSourceId && nodeIds.has(e.to_id))
                    .map(e => this.createEdgeObj(e.id, e.from_id, e.to_id, e.label, !!e.return_to_main, false)).filter(x=>x);
            }
        },
        filteredPublishClips() { return this.clips.filter(c => c.is_event_clip === 1 || this.edges.some(e => e.from_id === c.unique_id)); },
        maxStatCount() { return Math.max(...this.statsData.map(s => s.count), 1); },
        
        // --- PREVIEW HELPERS ---
        previewCurrentChoices(){ return this.previewCurrentOptions ? this.previewCurrentOptions.choices : []; },
        previewProgress(){ return this.previewDuration ? (this.previewCurrentTime/this.previewDuration)*100 : 0 },
        previewMarkers(){
            if(!this.previewDuration) return [];
            return this.previewActiveBlocks.map(b => ({ pct: (b.time/this.previewDuration)*100, count: b.choices.length }));
        }
    },
    mounted() { this.fetchProjects(); window.addEventListener('keydown', this.handleKeys); },
    beforeUnmount() { window.removeEventListener('keydown', this.handleKeys); },
    methods: {
        // --- NAVIGATION & UTILS ---
        navClass(v) { return `px-3 py-1 rounded-md font-bold transition text-xs ${this.view === v ? 'bg-blue-600 text-white shadow-lg' : 'text-slate-400 hover:text-white hover:bg-white/10'}` },
        formatTime(t){ const m=Math.floor(t/60); const s=Math.floor(t%60); return m+':'+s.toString().padStart(2,'0'); },
        formatDuration(s) { if(!s) return '0s'; const m = Math.floor(s/60); const sec = Math.floor(s%60); return `${m}:${sec.toString().padStart(2,'0')}`; },
        handleKeys(e) { if((this.view==='clipper' || this.view==='library' || this.view==='eventCreator') && e.code==='Space') { e.preventDefault(); const v = (this.view==='clipper') ? this.$refs.video : (this.view==='eventCreator' ? (this.previewEventClip ? this.$refs.testPlayer : this.$refs.eventVideo) : this.$refs.libraryPlayer); if(v) v.paused?v.play():v.pause(); } },
        showToast(msg, type='success') { this.toast={show:true, msg, type}; setTimeout(()=>this.toast.show=false, 3000); },
        copyToClipboard(text) { navigator.clipboard.writeText(text); this.showToast("ID Copied!"); },
        
        // --- PROJECT MANAGEMENT ---
        async fetchProjects() { const res = await fetch('/api/projects'); this.projects = await res.json(); },
        async createProject() { const title = prompt("Project Title:"); if(title) { await fetch('/api/projects', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({title})}); this.fetchProjects(); } },
        
        // --- DELETE PROJECT ---
        async deleteProject(p) {
            if(!confirm(`Are you sure you want to delete "${p.title}"?\nThis will permanently remove all videos and logic.`)) return;
            try {
                const res = await fetch('/api/delete_project', {
                    method: 'POST', 
                    headers: {'Content-Type': 'application/json'}, 
                    body: JSON.stringify({id: p.id})
                });
                const data = await res.json();
                if(data.success) {
                    this.showToast("Project Deleted");
                    this.fetchProjects();
                    if(this.currentProject && this.currentProject.id === p.id) {
                        this.currentProject = null;
                    }
                } else {
                    this.showToast("Delete Failed", "error");
                }
            } catch(e) {
                this.showToast("Error", "error");
            }
        },

        selectProject(p) { this.currentProject = p; this.projectColor = p.theme_color || '#3b82f6'; this.view = 'upload'; this.refreshData(); },
        async saveSettings() { await fetch('/api/project/settings', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({id:this.currentProject.id, color:this.projectColor})}); },
        
        async refreshData() { 
            const pid = this.currentProject.id; 
            const vRes = await fetch(`/api/videos?projectId=${pid}`); this.videos = await vRes.json(); 
            const sRes = await fetch(`/api/story?projectId=${pid}`); const d = await sRes.json(); this.clips = d.clips; this.edges = d.edges; 
            const aRes = await fetch('/api/audio'); this.audioFiles = await aRes.json(); 
            this.fetchVariables(); 
        },

        // --- VARIABLE MANAGEMENT ---
        async fetchVariables() {
            if(!this.currentProject) return;
            const res = await fetch(`/api/variables?projectId=${this.currentProject.id}`);
            this.variables = await res.json();
        },
        async addVariable() {
            if(!this.newVarName) return;
            const cleanName = this.newVarName.trim().replace(/\s+/g, '_').toLowerCase();
            await fetch('/api/variables', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ projectId: this.currentProject.id, name: cleanName, initialValue: this.newVarVal })
            });
            this.newVarName = '';
            this.fetchVariables();
            this.showToast("Variable Saved");
        },
        async deleteVariable(id) {
            if(!confirm("Delete variable definition?")) return;
            await fetch('/api/variable/delete', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ id, projectId: this.currentProject.id })
            });
            this.fetchVariables();
        },

        // --- UPLOAD & MEDIA ---
        handleFileSelect(e) { this.selectedFile = e.target.files[0]; },
        async uploadVideo() { if(!this.selectedFile) return; this.uploading = true; const fd = new FormData(); fd.append('file', this.selectedFile); fd.append('projectId', this.currentProject.id); try { await fetch('/api/upload', {method:'POST', body:fd}); this.showToast("Imported!"); this.refreshData(); this.view='clipper'; } catch(e){ this.showToast("Error", 'error'); } this.uploading = false; },
        async uploadAudio(e) { const file = e.target.files[0]; if (!file) return; const fd = new FormData(); fd.append('file', file); fd.append('projectId', this.currentProject.id); try { const res = await fetch('/api/upload', {method: 'POST', body: fd}); const data = await res.json(); if(data.success && data.type === 'audio') { this.showToast("Audio Uploaded!"); await this.refreshData(); this.logicBgMusic = data.path; this.playPreviewMusic(data.path); } } catch(err) { this.showToast("Upload Error", 'error'); } },
        async deleteVideo() { if(confirm("Delete video?")) { await fetch('/api/delete_video', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({id:this.selectedVidId, projectId:this.currentProject.id})}); this.selectedVidId=null; this.videoUrl=''; this.refreshData(); this.showToast("Deleted"); } },
        
        // --- CLIPPER ---
        loadVideo() { 
            const v = this.videos.find(x => x.id === this.selectedVidId); 
            if(v) { 
                this.videoUrl = v.filepath; 
                this.currentVidDuration = v.duration; 
                this.clipStart = 0;
                this.clipEnd = v.duration; 
                this.$nextTick(() => { if(this.$refs.video) this.$refs.video.load(); });
            } 
        },
        updateProgress() { if(this.$refs.video) this.currentTime = this.$refs.video.currentTime; },
        seekTimeline(e) { if(!this.currentVidDuration) return; const rect = e.target.getBoundingClientRect(); this.$refs.video.currentTime = ((e.clientX - rect.left)/rect.width)*this.currentVidDuration; },
        setStart() { const v = this.view==='clipper' ? this.$refs.video : this.$refs.eventVideo; this.clipStart = v.currentTime; }, 
        setEnd() { const v = this.view==='clipper' ? this.$refs.video : this.$refs.eventVideo; this.clipEnd = v.currentTime; },
        nudge(t, a) { const v = this.view==='clipper' ? this.$refs.video : this.$refs.eventVideo; if(t==='start') this.clipStart+=a; else this.clipEnd+=a; v.currentTime = t==='start'?this.clipStart:this.clipEnd; },
        
        async cutClip() { 
            if(!this.clipName) return alert("Name needed");
            if (this.clipEnd <= this.clipStart + 0.1) return this.showToast("Clip too short. Check Start/End.", "error");
            
            this.processingClip = true;
            try { 
                await fetch('/api/clip', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ projectId: this.currentProject.id, sourceId: this.selectedVidId, start: this.clipStart, end: this.clipEnd, name: this.clipName, filter: this.clipFilter, speed: this.clipSpeed, volume: this.clipVolume })}); 
                this.showToast("Clip Created!"); 
                this.refreshData(); 
            } catch(e) { 
                this.showToast("Error", 'error'); 
            } finally {
                this.processingClip = false;
            }
        },

        // --- EVENT CREATOR ---
        updateEventProgress() { if(this.$refs.eventVideo) this.currentTime = this.$refs.eventVideo.currentTime; },
        seekEventTimeline(e) { if(!this.currentVidDuration) return; const rect = e.target.getBoundingClientRect(); this.$refs.eventVideo.currentTime = ((e.clientX - rect.left)/rect.width)*this.currentVidDuration; },
        editEvent(c) { 
            this.isEditingEvent = true; 
            this.editingEventId = c.unique_id; 
            this.clipName = c.name; 
            this.videoUrl = c.filepath; 
            this.currentVidDuration = c.duration; 
            this.clipStart = c.start_time || 0;
            this.clipEnd = c.end_time || c.duration;
            this.selectedVidId = c.source_video_id; 
            const currentEdges = this.edges.filter(e => e.from_id === c.unique_id); 
            this.eventChoices = currentEdges.map(e => ({ label: e.label, toId: e.to_id, color: e.text_color || '#ffffff', returnToMain: !!e.return_to_main, setVar: e.set_var, reqVar: e.req_var })); 
            if (this.eventChoices.length === 0) this.eventChoices = [{label:'', toId:null, color:'#ffffff', returnToMain:false, setVar:'', reqVar:''}]; 
        },
        async createEventClip() { 
            if(!this.clipName) return alert("Name needed");
            if (this.clipEnd <= this.clipStart + 0.1) return this.showToast("Event duration too short.", "error");
            
            this.processingClip = true;
            try { 
                await fetch('/api/create_event_clip', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ projectId: this.currentProject.id, sourceId: this.selectedVidId, start: this.clipStart, end: this.clipEnd, name: this.clipName, choices: this.eventChoices }) }); 
                this.showToast("⚡ Event Created!"); 
                await this.refreshData(); 
                this.eventChoices = [{label:'', toId:null, color:'#ffffff', returnToMain:false, setVar:'', reqVar:''}]; 
            } catch(e) { 
                this.showToast("Error", 'error'); 
            } finally {
                this.processingClip = false;
            }
        },
        cancelEventEdit() { this.isEditingEvent = false; this.editingEventId = null; this.clipName = ''; this.eventChoices = [{label:'', toId:null, color:'#ffffff', returnToMain:false, setVar:'', reqVar:''}]; this.videoUrl = ''; },
        async saveEventChanges() { if(!this.editingEventId) return; try { await fetch('/api/update_event_logic', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ projectId: this.currentProject.id, clipId: this.editingEventId, name: this.clipName, choices: this.eventChoices }) }); this.showToast("Events Updated!"); await this.refreshData(); this.cancelEventEdit(); } catch(e) { this.showToast("Error", 'error'); } },
        async saveAndTestEvent() { if(!this.editingEventId) return; const tempId = this.editingEventId; await this.saveEventChanges(); const clip = this.eventClips.find(c => c.unique_id === tempId); if(clip) this.testEventClip(clip); },
        async testEventClip(clip) { await this.refreshData(); this.previewEventClip = clip; this.testHistory = []; this.showTestChoices = false; this.testChoices = this.edges.filter(e => e.from_id === clip.unique_id); this.testIsReturning = false; },
        closeTestEvent() { this.previewEventClip = null; this.testHistory = []; },
        checkTestLogic() { 
            if(!this.previewEventClip || this.showTestChoices || !this.$refs.testPlayer) return; 
            const vid = this.$refs.testPlayer;
            // Force playback logic for test mode too
            if (vid.duration && vid.duration > 0.5) {
                if(vid.currentTime >= vid.duration - 0.5) { 
                    const currentEdges = this.edges.filter(e => e.from_id === this.previewEventClip.unique_id); 
                    if(currentEdges.length > 0) { vid.pause(); this.testChoices = currentEdges; this.showTestChoices = true; } 
                }
            }
        },
        simulateChoice(opt) { const nextClip = this.clips.find(c => c.unique_id === opt.to_id); if(nextClip) { if(opt.return_to_main === 1) { this.testHistory.push(this.previewEventClip); this.testIsReturning = true; } else { this.testIsReturning = false; } this.previewEventClip = nextClip; this.showTestChoices = false; } else { this.showToast("Target clip not found!", "error"); } },
        handleTestEnd() { if(this.testHistory.length > 0) { const prev = this.testHistory.pop(); this.previewEventClip = prev; this.testIsReturning = false; this.showTestChoices = false; } },

        // --- LIBRARY ---
        toggleSelectionMode() { this.selectionMode = !this.selectionMode; this.selectedClipIds = []; if (!this.selectionMode) this.librarySelectedClip = null; },
        handleClipClick(clip) {
            if (this.selectionMode) {
                const idx = this.selectedClipIds.indexOf(clip.unique_id);
                if (idx > -1) this.selectedClipIds.splice(idx, 1);
                else this.selectedClipIds.push(clip.unique_id);
            } else { this.librarySelectedClip = clip; }
        },
        getItemClass(clip) {
            if (this.selectionMode) return this.selectedClipIds.includes(clip.unique_id) ? 'border-blue-500 bg-blue-500/10' : 'border-transparent hover:bg-white/5';
            return this.librarySelectedClip?.unique_id === clip.unique_id ? 'border-blue-500 bg-white/10' : 'border-transparent hover:bg-white/5';
        },
        async deleteSelectedClips() {
            if (!confirm(`Permanently delete ${this.selectedClipIds.length} clips?`)) return;
            try {
                const res = await fetch('/api/delete_clips_bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: this.currentProject.id, ids: this.selectedClipIds }) });
                const data = await res.json();
                if (data.success) { this.showToast(`Successfully deleted ${data.count} items`); this.selectedClipIds = []; this.selectionMode = false; this.refreshData(); }
            } catch (e) { this.showToast("Bulk delete failed", "error"); }
        },
        async deleteClip(uid) { if(confirm("Delete clip?")) { await fetch('/api/delete_clip', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({unique_id:uid, projectId:this.currentProject.id})}); this.refreshData(); } },
        async saveClipDetails() { 
            if(!this.librarySelectedClip) return; 
            await fetch('/api/clip/update', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ projectId:this.currentProject.id, id:this.librarySelectedClip.unique_id, name:this.librarySelectedClip.name, isGameOver: this.librarySelectedClip.is_game_over }) });
            this.showToast("Updated!"); 
        },
        async captureThumbnail() { if(!this.librarySelectedClip || !this.$refs.libraryPlayer) return; const time = this.$refs.libraryPlayer.currentTime; const res = await fetch('/api/clip/thumbnail', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({projectId:this.currentProject.id, id:this.librarySelectedClip.unique_id, time}) }); const data = await res.json(); if(data.success) { this.librarySelectedClip.thumbnail = data.thumbnail + '?t=' + Date.now(); this.showToast("Thumbnail Set!"); } },

        // --- LOGIC EDITOR ---
        loadLogicSource() { this.showLogicOverlay = false; this.currentEditingBlock = null; this.seenSegments = []; if(this.logicSourceId) { const c = this.logicSourceClip; if(c) { this.logicBgMusic = c.bg_music; this.logicMuteVideo = !!c.mute_audio; this.$nextTick(() => { if(this.$refs.logicPlayer) { this.$refs.logicPlayer.load(); this.$refs.logicPlayer.muted = this.logicMuteVideo; } this.playPreviewMusic(this.logicBgMusic); }); } } },
        toggleTestMode() { this.isTestMode = !this.isTestMode; this.showLogicOverlay = false; this.currentEditingBlock = null; if(this.isTestMode) this.refreshData(); },
        playPreviewMusic(url) { const a = this.$refs.bgmPreview; if(!a) return; if(url) { a.src = url; a.volume = 0.3; a.play().catch(e=>{}); } else { a.pause(); } },
        
        // --- SMART SKIP & LOGIC PLAYBACK ---
        mergeSeenSegments() {
            if (this.seenSegments.length < 2) return;
            this.seenSegments.sort((a, b) => a.start - b.start);
            const merged = [];
            let current = this.seenSegments[0];
            for (let i = 1; i < this.seenSegments.length; i++) {
                const next = this.seenSegments[i];
                if (current.end >= next.start - 0.5) { current.end = Math.max(current.end, next.end); } else { merged.push(current); current = next; }
            }
            merged.push(current);
            this.seenSegments = merged;
        },
        recordClipAsSeen(clipId, fromSourceId) {
            const subClip = this.clips.find(c => c.unique_id === clipId);
            if(subClip && subClip.source_video_id === fromSourceId && !subClip.name.startsWith("FULL:")) {
                this.seenSegments.push({ start: subClip.start_time, end: subClip.end_time });
                this.mergeSeenSegments();
            }
        },
        performSmartSkip(currentTime, player, activeBlocks = []) {
            if(!this.smartSkipEnabled || this.isManualSeeking) return;
            for(const seg of this.seenSegments) {
                const buffer = Math.min(0.5, (seg.end - seg.start) / 2);
                if(currentTime >= seg.start && currentTime < seg.end - buffer) {
                    let targetTime = seg.end;
                    const interactionInSegment = activeBlocks.find(b => (b.time || b.triggerTime) > currentTime && (b.time || b.triggerTime) < seg.end);
                    if (interactionInSegment) { targetTime = Math.max(currentTime, (interactionInSegment.time || interactionInSegment.triggerTime) - 0.5); }
                    if (Math.abs(player.currentTime - targetTime) > 0.5) { player.currentTime = targetTime; this.showToast("⏩ Skipped watched scene"); }
                    return;
                }
            }
        },
        updateLogicProgress() { 
            const v = this.$refs.logicPlayer; 
            if(!v) return; 
            this.logicCurrentTime = v.currentTime; 
            
            if(this.isTestMode && !this.isPlayingSubClip) { this.performSmartSkip(this.logicCurrentTime, v, this.existingLogicBlocks); }
            if(this.isPlayingSubClip) return; 
            
            if(this.isTestMode && !this.showLogicOverlay) { 
                const block = this.existingLogicBlocks.find(b => v.currentTime >= b.triggerTime && v.currentTime < b.triggerTime + 0.5); 
                if(block && block.choices && block.choices.length > 0) { v.pause(); this.currentEditingBlock = block; this.showLogicOverlay = true; } 
            } else if(!this.isTestMode && this.currentEditingBlock && Math.abs(this.logicCurrentTime - this.currentEditingBlock.triggerTime) < 0.5) { 
                this.showLogicOverlay = true; 
            } else if (!this.isTestMode) { this.showLogicOverlay = false; } 
        },
        handleOptionClick(opt) { if(this.isTestMode) { const targetClip = this.clips.find(c => c.unique_id === opt.toId); if(targetClip) { if(opt.return) { this.historyStack.push({ time: this.$refs.logicPlayer.currentTime + 0.5, src: this.$refs.logicPlayer.src }); } this.$refs.logicPlayer.src = targetClip.filepath; this.$refs.logicPlayer.muted = !!targetClip.mute_audio; this.$refs.logicPlayer.play(); this.playPreviewMusic(targetClip.bg_music); this.showLogicOverlay = false; this.isPlayingSubClip = true; if(opt.return) { this.$refs.logicPlayer.onended = () => { this.finishSubClip(targetClip.unique_id); }; } } } },
        finishSubClip(clipId) { 
            if (clipId && this.logicSourceClip) { this.recordClipAsSeen(clipId, this.logicSourceClip.source_video_id); }
            if(this.historyStack.length > 0) { const state = this.historyStack.pop(); this.$refs.logicPlayer.src = state.src; this.$refs.logicPlayer.currentTime = state.time; this.$refs.logicPlayer.play(); } 
            this.$refs.logicPlayer.onended = null; this.isPlayingSubClip = false; 
            if(this.logicSourceClip) { this.$refs.logicPlayer.muted = !!this.logicSourceClip.mute_audio; this.playPreviewMusic(this.logicSourceClip.bg_music); } 
        },
        jumpTime(e) { 
            if(!this.logicSourceClip) return; 
            this.isManualSeeking = true; setTimeout(() => this.isManualSeeking = false, 1500);
            const rect = e.target.getBoundingClientRect(); this.$refs.logicPlayer.currentTime = ((e.clientX - rect.left)/rect.width)*this.logicSourceClip.duration; 
        },
        createNewBlockAtCurrentTime() { this.$refs.logicPlayer.pause(); this.currentEditingBlock = { id: null, triggerTime: this.$refs.logicPlayer.currentTime, choices: [{toId:null, label:'', color:'#ffffff', return:false, setVar:'', reqVar:''}, {toId:null, label:'', color:'#ffffff', return:false, setVar:'', reqVar:''}] }; this.showLogicOverlay = true; },
        editBlock(block) { this.$refs.logicPlayer.pause(); this.$refs.logicPlayer.currentTime = block.triggerTime; this.currentEditingBlock = JSON.parse(JSON.stringify(block)); this.showLogicOverlay = true; },
        addOption() { if(this.currentEditingBlock.choices.length<4) this.currentEditingBlock.choices.push({toId:null, label:'', color:'#ffffff', return:false, setVar:'', reqVar:''}); },
        
        async saveLogicBlock() { if(!this.logicSourceId) return; try { const blockId = this.currentEditingBlock.id?.startsWith('legacy_') ? null : this.currentEditingBlock.id; await fetch('/api/save_logic_block', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ projectId: this.currentProject.id, fromId: this.logicSourceId, logicId: blockId, triggerTime: this.currentEditingBlock.triggerTime, returnToMain: this.currentEditingBlock.returnToMain, choices: this.currentEditingBlock.choices, bgMusic: this.logicBgMusic, muteAudio: this.logicMuteVideo }) }); this.showToast("Saved!"); await this.refreshData(); this.currentEditingBlock = null; this.showLogicOverlay = false; } catch(e) { this.showToast("Error", 'error'); } },
        async deleteLogicBlock() { if(!confirm("Delete?")) return; try { const blockId = this.currentEditingBlock.id?.startsWith('legacy_') ? null : this.currentEditingBlock.id; await fetch('/api/delete_logic_block', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ projectId: this.currentProject.id, logicId: blockId, fromId: this.logicSourceId, triggerTime: this.currentEditingBlock.triggerTime }) }); this.showToast("Deleted"); await this.refreshData(); this.currentEditingBlock = null; this.showLogicOverlay = false; } catch(e) { this.showToast("Error", 'error'); } },
        getClipThumb(id) {
    if (!id) return '';
    const c = this.clips.find(x => x.unique_id === id);
    return c && c.thumbnail ? c.thumbnail : ''; // Returns empty string if missing, handled by CSS fallback
},

        // --- GRAPH: VISUAL EDITOR ---
        startConnectionDrag(e, node) {
            e.stopPropagation(); 
            this.isDrawingLine = true;
            this.drawStartNode = node;
            const startX = (node.x || 0) + 180; 
            const startY = (node.y || 0) + 50;  
            this.tempLine = { x1: startX, y1: startY, x2: startX, y2: startY };
        },
        updateConnectionDrag(e) {
            if (!this.isDrawingLine) return;
            const rect = this.$refs.graphContainer.getBoundingClientRect();
            const rawX = e.clientX - rect.left;
            const rawY = e.clientY - rect.top;
            this.tempLine.x2 = (rawX - this.pan.x) / this.zoom;
            this.tempLine.y2 = (rawY - this.pan.y) / this.zoom;
        },
        async completeConnectionDrag(node) {
            if (!this.isDrawingLine || !this.drawStartNode) return;
            if (node.unique_id !== this.drawStartNode.unique_id) {
                await fetch('/api/edge/create', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ projectId: this.currentProject.id, fromId: this.drawStartNode.unique_id, toId: node.unique_id })
                });
                this.refreshData();
                this.showToast("Linked!");
            }
            this.stopConnectionDrag();
        },
        stopConnectionDrag() {
            this.isDrawingLine = false;
            this.drawStartNode = null;
            this.tempLine = null;
        },
        async deleteEdge(edgeId) {
            if(confirm("Remove this connection?")) {
                await fetch('/api/edge/delete', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ projectId: this.currentProject.id, id: edgeId }) });
                this.refreshData();
            }
        },

        // --- GRAPH: PAN & ZOOM ---
        openGraph() { if(!this.logicSourceId) return alert("Select a video first."); this.isGraphMode = true; this.pan = {x: 50, y: 50}; const root = this.displayedGraphNodes.find(n => n.unique_id === this.logicSourceId); if (root && (!root.x || root.x === 0)) this.autoLayout(); },
        autoLayout() { if(this.isPublishGraphMode) { const seqIds = this.storySequence.map(s => s.id); let spineX = 100; const spineY = 300; seqIds.forEach((sid, idx) => { const node = this.clips.find(c => c.unique_id === sid); if(node) { node.x = spineX; node.y = spineY; spineX += 500; } }); seqIds.forEach((sid, idx) => { const nextSid = seqIds[idx+1]; const parentNode = this.clips.find(c => c.unique_id === sid); if(!parentNode) return; const childrenEdges = this.edges.filter(e => e.from_id === sid); const branches = childrenEdges.map(e => this.clips.find(c => c.unique_id === e.to_id)).filter(c => c && c.unique_id !== nextSid); if(branches.length > 0) { const branchStartX = parentNode.x + 200; let branchY = parentNode.y - ((branches.length * 150) / 2); branches.forEach((child, bIdx) => { child.x = branchStartX; child.y = branchY + (bIdx * 120); if (Math.abs(child.y - spineY) < 80) child.y += 150; }); } }); } else { const root = this.displayedGraphNodes.find(n => n.unique_id === this.logicSourceId); if(!root) return; root.x = 100; root.y = window.innerHeight / 3; const nodes = this.displayedGraphNodes.filter(n => n.unique_id !== this.logicSourceId); if (nodes.length > 0) { const startY = root.y - ((nodes.length - 1) * 120) / 2; nodes.forEach((child, index) => { child.x = 450; child.y = startY + (index * 130); }); } } this.saveNodePositions(); },
        openPublishGraph() { if(this.storySequence.length === 0) return alert("Add sequence items first."); this.isPublishGraphMode = true; this.logicSourceId = this.storySequence[0].id; this.pan = {x: 50, y: 50}; setTimeout(() => { const root = this.displayedGraphNodes.find(n => n.unique_id === this.logicSourceId); if (root && (!root.x || root.x === 0)) this.autoLayout(); }, 100); },
        startPan(e) { if(e.target.closest('.graph-node')) return; this.isPanning = true; this.lastMouse = {x: e.clientX, y: e.clientY}; },
        onGraphMouseMove(e) { 
            if (this.isDrawingLine) { this.updateConnectionDrag(e); return; }
            if(this.isPanning) { this.pan.x += e.clientX - this.lastMouse.x; this.pan.y += e.clientY - this.lastMouse.y; this.lastMouse = {x: e.clientX, y: e.clientY}; } 
            if(this.isDraggingNode && this.dragNodeId) { const node = this.clips.find(c => c.unique_id === this.dragNodeId); if(node) { node.x += e.movementX / this.zoom; node.y += e.movementY / this.zoom; } } 
        },
        endPan() { 
            if (this.isDrawingLine) this.stopConnectionDrag();
            this.isPanning = false; this.isDraggingNode = false; this.dragNodeId = null; 
        },
        zoomGraph(e) { e.preventDefault(); this.zoom += e.deltaY * -0.001; this.zoom = Math.min(Math.max(0.5, this.zoom), 2); },
        startDragNode(e, node) { this.isDraggingNode = true; this.dragNodeId = node.unique_id; },
        selectNode(node) { this.isGraphMode = false; this.isPublishGraphMode = false; this.logicSourceId = node.unique_id; this.loadLogicSource(); this.view = 'logic'; },
        async saveNodePositions() { const updates = this.clips.map(c => ({ id: c.unique_id, x: c.x || 0, y: c.y || 0 })); await fetch('/api/clip/positions', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ projectId: this.currentProject.id, updates }) }); this.showToast("Layout Saved!"); },
        createEdgeObj(id, fromId, toId, label, isReturn, isSequence) {
            const fromNode = this.displayedGraphNodes.find(n => n.unique_id === fromId);
            const toNode = this.displayedGraphNodes.find(n => n.unique_id === toId);
            if (!fromNode || !toNode) return null;
            const startX = (fromNode.x || 0) + 180; const startY = (fromNode.y || 0) + 50;
            const endX = (toNode.x || 0); const endY = (toNode.y || 0) + 50;
            const dist = Math.abs(endX - startX) * 0.5;
            const path = `M ${startX} ${startY} C ${startX + dist} ${startY}, ${endX - dist} ${endY}, ${endX} ${endY}`;
            const midX = (startX + endX) / 2; const midY = (startY + endY) / 2;
            return { id, path, label, isReturn, isSequence, midX, midY };
        },

        // --- STATS & PUBLISH ---
        async fetchStats() { this.view = 'stats'; if(!this.currentProject) return; const res = await fetch(`/api/analytics/${this.currentProject.id}`); this.statsData = await res.json(); },
        async resetStats() { if(!confirm("Are you sure you want to reset all click statistics for this project? This cannot be undone.")) return; try { await fetch('/api/analytics/reset', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ projectId: this.currentProject.id }) }); this.showToast("Stats Reset!"); this.fetchStats(); } catch(e) { this.showToast("Error", 'error'); } },
        
        // NEW: DRAG & DROP SEQUENCE
        addToSequence(clip) { this.storySequence.push({ id: clip.unique_id, name: clip.name }); },
        removeFromSequence(idx) { this.storySequence.splice(idx, 1); },
        moveSequence(idx, dir) { if(idx + dir < 0 || idx + dir >= this.storySequence.length) return; const temp = this.storySequence[idx]; this.storySequence[idx] = this.storySequence[idx + dir]; this.storySequence[idx + dir] = temp; },
        
        onSeqDragStart(event, index) {
            this.draggedSeqIndex = index;
            event.dataTransfer.effectAllowed = 'move';
        },
        onSeqDrop(event, index) {
            if (this.draggedSeqIndex === null) return;
            const item = this.storySequence.splice(this.draggedSeqIndex, 1)[0];
            this.storySequence.splice(index, 0, item);
            this.draggedSeqIndex = null;
        },

        async fetchExports() { const res = await fetch('/api/exports'); this.exportsList = await res.json(); },
        async deleteExport(name) { if(confirm("Delete build?")) { await fetch('/api/delete_export', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name})}); this.fetchExports(); } },
        async publishProject() { if(this.storySequence.length === 0) return alert("Sequence empty."); this.publishing = true; try { const res = await fetch('/api/publish', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ projectId: this.currentProject.id, title:this.publishTitle, sequence: this.storySequence }) }); const data = await res.json(); this.publishUrl = data.url; this.showToast("Build Complete!"); this.fetchExports(); } catch(e) { this.showToast("Build Failed", 'error'); } this.publishing = false; },
        
        // --- PREVIEW PLAYER (MATCHED TO PUBLISHER) ---
        async startPreview() { 
            if(this.storySequence.length === 0) return alert("Add sequence items first."); 
            await this.refreshData(); 
            this.previewGameState = {};
            this.variables.forEach(v => { this.previewGameState[v.name] = v.initial_value === 1; });
            this.previewMode = true; 
            this.previewPlaylistIndex = 0; 
            this.previewHistoryStack = []; 
            this.previewIsPlayingSubClip = false; 
            this.previewIsGameOver = false; 
            this.previewFailSafeState = null; 
            this.seenSegments = []; 
            this.loadPreviewClip(this.storySequence[0].id); 
        },
        closePreview() { this.previewMode = false; if(this.$refs.previewPlayer) this.$refs.previewPlayer.pause(); if(this.$refs.previewBgm) this.$refs.previewBgm.pause(); },
        loadPreviewClip(id, forceTime=0) { 
            const nextClip = this.clips.find(c => c.unique_id === id); 
            if(!nextClip) {
                console.warn('Clip not found:', id);
                if (this.previewPlaylistIndex < this.storySequence.length - 1) {
                     this.previewPlaylistIndex++;
                     this.loadPreviewClip(this.storySequence[this.previewPlaylistIndex].id);
                } else {
                     this.showToast("Scene missing. Preview ended.", "error");
                     this.closePreview();
                }
                return;
            }
            this.previewClip = nextClip; 
            
            // --- SMART SKIP CALCULATION ---
            // STRICTLY MATCHING PUBLISHER.JS LOGIC
            this.previewClip.skipRanges = [];
            if (this.previewClip.source_video_id && this.previewClip.is_event_clip !== 1) { // IGNORE EVENT CLIPS
                const pStart = parseFloat(this.previewClip.start_time) || 0;
                const pEnd = (this.previewClip.end_time && parseFloat(this.previewClip.end_time) > 0) 
                             ? parseFloat(this.previewClip.end_time) 
                             : (pStart + (this.previewClip.duration || 10));

                this.clips.forEach(subClip => {
                    if (subClip.unique_id !== this.previewClip.unique_id && 
                        subClip.source_video_id === this.previewClip.source_video_id &&
                        subClip.is_event_clip !== 1 && // Don't use event clips as skip sources
                        !subClip.name.startsWith("FULL:")) {
                        
                        const sStart = parseFloat(subClip.start_time) || 0;
                        const sEnd = (subClip.end_time && parseFloat(subClip.end_time) > 0)
                                     ? parseFloat(subClip.end_time)
                                     : (sStart + (subClip.duration || 10));

                        if (sStart >= (pStart - 0.1) && sEnd <= (pEnd + 0.1)) {
                            const relStart = Math.max(0, sStart - pStart);
                            const relEnd = Math.min(pEnd, sEnd) - pStart;
                            if (relEnd > relStart + 0.5) {
                                this.previewClip.skipRanges.push({ start: relStart, end: relEnd });
                            }
                        }
                    }
                });
                this.previewClip.skipRanges.sort((a,b) => a.start - b.start);
            }

            this.previewShowChoices = false; 
            this.previewIsPaused = false;
            this.previewIsGameOver = false;
            const relevantEdges = this.edges.filter(e => e.from_id === id); 
            const blocks = {}; 
            relevantEdges.forEach(e => { const key = e.logic_id || e.trigger_time; if(!blocks[key]) blocks[key] = { id: key, time: e.trigger_time, choices: [] }; blocks[key].choices.push({ to: e.to_id, label: e.label, color: e.text_color, setVar: e.set_var, reqVar: e.req_var, return: !!e.return_to_main }); }); 
            this.previewActiveBlocks = Object.values(blocks).sort((a,b) => a.time - b.time); 
            if(forceTime > 0) this.previewActiveBlocks = this.previewActiveBlocks.filter(b => b.time > forceTime); 
            this.$nextTick(() => { 
                const v = this.$refs.previewPlayer; 
                if(!v) return; 
                v.src = nextClip.filepath; 
                v.load();
                v.currentTime = forceTime; 
                v.muted = !!nextClip.mute_audio; 
                v.volume = this.previewVolume;
                v.play(); 
                const a = this.$refs.previewBgm; 
                if(nextClip.bg_music){ 
                    if(!a.src.includes(nextClip.bg_music)){ 
                        a.src=nextClip.bg_music; 
                        a.volume = this.previewVolume * 0.3;
                        a.play().catch(e=>{}); 
                    } 
                } else { 
                    a.pause(); 
                } 
            }); 
        },
        onPreviewDurationChange() { this.previewDuration = this.$refs.previewPlayer.duration; },
        onPreviewTimeUpdate() { 
            const v = this.$refs.previewPlayer;
            if(!v) return;
            this.previewCurrentTime = v.currentTime;
            
            const isEventClip = this.previewClip.is_event_clip === 1;

            // --- SMART SKIP (Disabled for Event Clips) ---
            if (!isEventClip && !this.previewIsPlayingSubClip && this.previewClip.skipRanges && !this.isManualSeeking) {
                for(let range of this.previewClip.skipRanges) {
                    if (this.previewCurrentTime >= range.start && this.previewCurrentTime < range.end) {
                        v.currentTime = range.end + 0.1;
                        this.showToast("⏩ Smart Skip");
                        return;
                    }
                }
            }

            if(this.previewShowChoices || this.previewIsGameOver || !this.previewActiveBlocks.length || this.previewIsPlayingSubClip) return; 
            
            // --- FORCE EVENT PLAYBACK (Match Publisher) ---
            if (isEventClip) {
                // If it's an event clip, ignore any trigger times until we are at the end
                if (v.duration && v.currentTime < v.duration - 0.5) return;
            }

            // Normal Trigger Check
            if(v.currentTime >= this.previewActiveBlocks[0].time && v.currentTime < this.previewActiveBlocks[0].time + 1.0) { 
                v.pause(); 
                this.previewIsPaused = true;
                this.previewCurrentOptions = this.previewActiveBlocks.shift(); 
                this.previewShowChoices = true; 
            } else if (isEventClip && v.currentTime >= v.duration - 0.2) {
                // Failsafe for event clips at end of file
                v.pause();
                this.previewIsPaused = true;
                this.previewCurrentOptions = this.previewActiveBlocks[0]; 
                this.previewShowChoices = true;
            }
        },
        togglePreviewPlay() {
            const v = this.$refs.previewPlayer;
            if(v.paused) { v.play(); this.previewIsPaused = false; } else { v.pause(); this.previewIsPaused = true; }
        },
        seekPreview(e) {
            if(!this.previewDuration) return;
            this.isManualSeeking = true;
            setTimeout(() => this.isManualSeeking = false, 1500);
            const rect = e.currentTarget.getBoundingClientRect();
            const pct = (e.clientX - rect.left) / rect.width;
            this.$refs.previewPlayer.currentTime = pct * this.previewDuration;
        },
        updatePreviewVolume() {
            const v = this.$refs.previewPlayer;
            const a = this.$refs.previewBgm;
            if(v) v.volume = this.previewVolume;
            if(a) a.volume = this.previewVolume * 0.3;
        },
        makePreviewChoice(choice) { 
            if(this.isPreviewLocked(choice)) return; 
            if(this.currentProject && this.currentProject.id) {
                 fetch('/api/analytics/track', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ projectId: this.currentProject.id, label: choice.label, target: choice.to })
                }).catch(e => console.warn(e));
            }
            if(choice.setVar) this.previewGameState[choice.setVar] = true; 
            
            const targetClip = this.clips.find(c => c.unique_id === choice.to); 
            if(targetClip) { 
                if(targetClip.is_game_over == 1 || targetClip.is_game_over === true) {
                     this.previewFailSafeState = { clipId: this.previewClip.unique_id, time: 0 };
                }
                if(choice.return) { 
                    if (this.previewClip && this.previewClip.is_event_clip === 1) { 
                        this.previewHistoryStack.push({ clipId: this.previewClip.unique_id, time: 0, remainingBlocks: [...this.previewActiveBlocks] }); 
                    } else if(this.previewClip) { 
                        const currentT = this.$refs.previewPlayer.currentTime;
                        const dur = this.$refs.previewPlayer.duration || 100;
                        const returnTime = Math.min(currentT + 0.1, dur - 0.1);
                        this.previewHistoryStack.push({ clipId: this.previewClip.unique_id, time: returnTime, remainingBlocks: [...this.previewActiveBlocks] }); 
                    } 
                    this.previewIsPlayingSubClip = true; 
                } 
                this.loadPreviewClip(choice.to, 0); 
            } 
        },
        onPreviewEnded() { 
            if(this.previewShowChoices) return;
            if(this.previewClip && (this.previewClip.is_game_over == 1 || this.previewClip.is_game_over === true)) {
                this.previewIsGameOver = true;
                this.$refs.previewPlayer.pause();
                if(this.$refs.previewBgm) this.$refs.previewBgm.pause();
                return;
            }
            if(this.previewIsPlayingSubClip && this.previewHistoryStack.length > 0) { 
                if (this.previewClip && this.previewHistoryStack[this.previewHistoryStack.length-1].clipId) {
                     const parentClip = this.clips.find(c => c.unique_id === this.previewHistoryStack[this.previewHistoryStack.length-1].clipId);
                     if (parentClip) {
                         this.recordClipAsSeen(this.previewClip.unique_id, parentClip.source_video_id);
                     }
                }
                const prev = this.previewHistoryStack.pop(); 
                this.previewIsPlayingSubClip = false; 
                this.previewActiveBlocks = prev.remainingBlocks || []; 
                this.loadPreviewClip(prev.clipId, prev.time); 
                return; 
            } 
            this.previewPlaylistIndex++; 
            if(this.previewPlaylistIndex < this.storySequence.length) { this.loadPreviewClip(this.storySequence[this.previewPlaylistIndex].id); } else { this.closePreview(); this.showToast("End of Sequence"); } 
        },
        previewRestartFromFail() {
             if(this.previewFailSafeState) {
                 this.loadPreviewClip(this.previewFailSafeState.clipId, 0);
                 this.previewFailSafeState = null;
             } else {
                 alert("No save point found. Restarting from beginning.");
                 this.startPreview();
             }
        },
        isPreviewLocked(ch) { 
            if(!ch.reqVar) return false; 
            return !this.previewGameState[ch.reqVar]; 
        },
        getClipName(id) { const c = this.clips.find(clip => clip.unique_id === id); return c ? c.name : 'Unknown Clip'; }
    }
}).mount('#app');

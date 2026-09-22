const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

let dbInstance = null;

async function initDB() {
    if (dbInstance) return dbInstance;

    dbInstance = await open({ filename: './database.sqlite', driver: sqlite3.Database });

    // --- 1. CORE TABLES ---
    await dbInstance.exec(`CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, theme_color TEXT DEFAULT '#3b82f6', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);`);
    await dbInstance.exec(`CREATE TABLE IF NOT EXISTS videos (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, filename TEXT, filepath TEXT, thumbnail TEXT, duration REAL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);`);
    
    // --- 2. CLIP & LOGIC TABLES ---
    await dbInstance.exec(`CREATE TABLE IF NOT EXISTS clips (id INTEGER PRIMARY KEY AUTOINCREMENT, unique_id TEXT UNIQUE, project_id INTEGER, name TEXT, filepath TEXT, thumbnail TEXT, source_video_id INTEGER, duration REAL, start_time REAL DEFAULT 0, end_time REAL, logic_name TEXT, timeout_to_id TEXT, timeout_seconds REAL, bg_music TEXT, bg_music_url TEXT, mute_audio INTEGER DEFAULT 0, is_event_clip INTEGER DEFAULT 0, is_game_over INTEGER DEFAULT 0, x REAL DEFAULT 0, y REAL DEFAULT 0);`);
    
    // ADDED: x and y columns for button positioning
    await dbInstance.exec(`CREATE TABLE IF NOT EXISTS edges (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, from_id TEXT, to_id TEXT, label TEXT, text_color TEXT DEFAULT '#ffffff', trigger_time REAL, logic_id TEXT, return_to_main INTEGER DEFAULT 0, set_var TEXT, req_var TEXT, x REAL DEFAULT 50, y REAL DEFAULT 50);`);
    
    // --- 3. ANALYTICS TABLE ---
    await dbInstance.exec(`CREATE TABLE IF NOT EXISTS analytics (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, choice_label TEXT, target_clip_id TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP);`);

    // --- 4. VARIABLES TABLE ---
    await dbInstance.exec(`CREATE TABLE IF NOT EXISTS variables (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, name TEXT, initial_value INTEGER DEFAULT 0, description TEXT);`);

    // --- 5. MIGRATIONS ---
    const migrations = [
        `ALTER TABLE projects ADD COLUMN theme_color TEXT DEFAULT '#3b82f6'`,
        `ALTER TABLE clips ADD COLUMN bg_music TEXT`,
        `ALTER TABLE clips ADD COLUMN mute_audio INTEGER DEFAULT 0`,
        `ALTER TABLE edges ADD COLUMN logic_id TEXT`,
        `ALTER TABLE edges ADD COLUMN return_to_main INTEGER DEFAULT 0`,
        `ALTER TABLE edges ADD COLUMN set_var TEXT`,
        `ALTER TABLE edges ADD COLUMN req_var TEXT`,
        `ALTER TABLE edges ADD COLUMN text_color TEXT DEFAULT '#ffffff'`,
        `ALTER TABLE clips ADD COLUMN is_event_clip INTEGER DEFAULT 0`,
        `ALTER TABLE clips ADD COLUMN is_game_over INTEGER DEFAULT 0`,
        `ALTER TABLE clips ADD COLUMN x REAL DEFAULT 0`,
        `ALTER TABLE clips ADD COLUMN y REAL DEFAULT 0`,
        // NEW MIGRATIONS FOR BUTTON POSITIONS
        `ALTER TABLE edges ADD COLUMN x REAL DEFAULT 50`,
        `ALTER TABLE edges ADD COLUMN y REAL DEFAULT 50`
    ];
    
    for (let m of migrations) { 
        try { await dbInstance.exec(m); } catch (e) {} 
    }

    const proj = await dbInstance.get('SELECT * FROM projects');
    if (!proj) await dbInstance.run("INSERT INTO projects (title) VALUES ('Default Project')");

    console.log("✅ Database Linked & Schemas Verified");
    return dbInstance;
}

function getDB() {
    if (!dbInstance) throw new Error("Database not initialized. Call initDB() first.");
    return dbInstance;
}

module.exports = { initDB, getDB };
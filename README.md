# StudioInfinity 🎬

> An interactive video engine and visual branching storytelling studio.

StudioInfinity is an end-to-end interactive video creation platform. It allows creators, game developers, and filmmakers to design branching narrative videos, interactive movies, and gamebooks with a visual node graph editor, timeline clipping, choice triggers, variables, and one-click standalone HTML publishing.

---

## ✨ Features

- **Visual Node Graph Editor**: Connect clips, create branching choices, and visualize narrative flow interactively.
- **Precision Timeline Clipper**: Split video segments, trim clips, and set custom audio/background tracks.
- **Choice Points & Positioning**: Place interactive choice buttons anywhere on the screen with customizable coordinates and styling.
- **State & Variables Engine**: Track player state, choices, and conditions (`set_var`, `req_var`) to unlock different branching paths.
- **Smart Skip Calculations**: Automatically skip redundant video intervals between branching decisions.
- **Standalone HTML Publishing**: Export complete interactive experiences into self-contained web bundles ready for hosting on any static web server or CDN.
- **Local Storage & Database**: Backed by an automated SQLite database schema with built-in migrations.

---

## 🛠️ Tech Stack

- **Backend**: [Node.js](https://nodejs.org/), [Express](https://expressjs.com/)
- **Database**: [SQLite](https://sqlite.org/) via `sqlite3` and `sqlite`
- **Video Processing**: [Fluent FFmpeg](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg) with bundled `ffmpeg-static` and `ffprobe-static`
- **Frontend**: [Vue.js 3](https://vuejs.org/), [Tailwind CSS](https://tailwindcss.com/)

---

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v16 or higher recommended)
- [npm](https://www.npmjs.com/)

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/instafire/StudioInfinity.git
   cd StudioInfinity
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Start the application:**
   ```bash
   npm start
   ```
   Or run in development mode with nodemon:
   ```bash
   npm run dev
   ```

4. **Open in browser:**
   Navigate to [http://localhost:3000](http://localhost:3000)

---

## 📁 Project Structure

```text
StudioInfinity/
├── database.js          # SQLite database connection and schema migrations
├── publisher.js         # Interactive HTML export and bundling engine
├── routes.js            # Express REST API routes for projects, clips, and logic
├── server.js            # Main Express application entrypoint
├── public/              # Static frontend assets and media storage
│   ├── index.html       # Studio UI (Vue 3 + Tailwind CSS)
│   ├── js/
│   │   └── app.js       # Frontend application logic
│   ├── audio/           # Uploaded audio tracks
│   ├── clips/           # Generated video clips
│   ├── exports/         # Published standalone project exports
│   ├── thumbnails/      # Generated video thumbnails
│   └── videos/          # Source video uploads
└── package.json
```

---

## 📄 License

MIT License. See [LICENSE](LICENSE) for details.

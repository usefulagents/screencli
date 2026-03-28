# screencli

A screen recorder for your AI agent.

[![npm version](https://img.shields.io/npm/v/screencli)](https://www.npmjs.com/package/screencli)
[![license](https://img.shields.io/npm/l/screencli)](https://github.com/usefulagents/screencli/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/screencli)](https://nodejs.org)

One command records an AI-driven browser session and outputs a polished, shareable video — with auto-trim, zoom, click highlights, cursor trails, and gradient backgrounds. No screen-sharing, no retakes.

<!-- TODO: Add demo GIF here → ![screencli demo](https://screencli.sh/demo.gif) -->

## Quick Start

```bash
npx screencli record https://example.com -p "Click Sign Up, fill in the form, and submit"
```

That's it. The AI navigates your app, screencli records it, and you get a composed MP4 with studio-grade effects — uploaded to a shareable link.

## Features

- **AI-driven recording** — describe what to do in plain English, Claude handles the browser
- **Auto-trim** — idle time between actions is cut automatically
- **Auto-zoom** — camera follows the active element with smooth transitions
- **Click highlights** — visual pulse on every click
- **Cursor trail** — smooth cursor path overlay
- **Gradient backgrounds** — `midnight`, `ember`, `forest`, `nebula`, `slate`, `copper`
- **Platform exports** — one command for YouTube, Twitter, Instagram, TikTok, LinkedIn, or GitHub GIF
- **Cloud upload** — recordings get a shareable link automatically
- **Auth support** — log into private apps first, then let the agent take over

## Usage

```bash
# Record a demo with a prompt
npx screencli record https://myapp.com -p "Navigate to pricing and compare plans"

# Pick a gradient background
npx screencli record https://myapp.com -p "Toggle dark mode" --background sunset

# Record a private app (login first, then AI takes over)
npx screencli record https://app.internal.com -p "Show the dashboard" --login --auth myapp

# Export for Twitter
npx screencli export ./recordings/abc123 --preset twitter

# Export as a GIF for GitHub
npx screencli export ./recordings/abc123 --preset github-gif
```

## Export Presets

| Preset | Resolution | Aspect | Format |
|--------|-----------|--------|--------|
| `youtube` | 1920x1080 | 16:9 | mp4 |
| `twitter` | 1280x720 | 16:9 | mp4 |
| `instagram` | 1080x1920 | 9:16 | mp4 |
| `tiktok` | 1080x1920 | 9:16 | mp4 |
| `linkedin` | 1080x1080 | 1:1 | mp4 |
| `github-gif` | 800x450 | 16:9 | gif |

## AI Agent Skill

Give your AI agent the ability to record demos autonomously:

```bash
npx skills add https://github.com/usefulagents/screencli --skill screencli
```

Works with Claude Code, Cursor, Windsurf, and any agent that supports skills.

## Commands

| Command | Description |
|---------|-------------|
| `record [url] -p "..."` | Record an AI-driven browser demo |
| `export <dir> --preset <name>` | Export with platform presets |
| `login` | Sign in to screencli cloud |
| `logout` | Sign out |
| `whoami` | Show current user and plan |
| `recordings` | List your cloud recordings |
| `upload <dir>` | Upload a local recording |
| `delete <id>` | Delete a cloud recording |
| `render <id>` | Re-render with different settings |

## Requirements

- Node.js 18+
- FFmpeg (`brew install ffmpeg` on macOS)

## Links

- [Website](https://screencli.sh)
- [Cloud Dashboard](https://screencli.sh/dashboard)
- [AI Agent Skill](https://github.com/usefulagents/screencli/tree/main/skills/screencli)

## License

MIT

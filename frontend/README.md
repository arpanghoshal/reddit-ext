# Reddit Automated DM - Chrome Extension

Chrome extension frontend for the Reddit Automated DM.

## Setup

1. Make sure the backend server is running (see `../backend/README.md`)

2. Load the extension in Chrome:
   - Go to `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select this `frontend` folder

3. Configure the extension:
   - Click the extension icon and go to Settings
   - Enter your backend server URL (default: `http://localhost:3000`)
   - Test the connection
   - Save settings

## Usage

1. Navigate to a Reddit post or subreddit
2. Press `Alt+R` to toggle the sidebar
3. Follow the onboarding to set up your business context
4. Use the sidebar to generate and send DMs

## Keyboard Shortcuts

- `Alt+R` - Toggle sidebar
- `Alt+S` - Stop automation

## Structure

```text
frontend/
├── manifest.json        # Extension configuration
├── background/          # Service worker
│   └── background.js
├── content/             # Content script for Reddit
│   └── content.js
├── popup/               # Extension popup (quick stats + settings)
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
├── lib/                 # Shared libraries
│   ├── api.js           # Backend API client
│   └── templates.js     # Message templates
└── styles/              # Shared styles
    └── main.css
```

## Dashboard

The full dashboard UI is now in a separate app: `../dashboard-app/`

Run it with:

```bash
cd ../dashboard-app
npm install
npm run dev
```

Then open <http://localhost:5173> in your browser.

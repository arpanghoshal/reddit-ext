# Reddit Auto DM

A Chrome extension for gathering user insights from Reddit by sending thoughtful, AI-generated DMs.

## Architecture

This project consists of three parts:

| Component     | Location         | Description                                                        |
|---------------|------------------|--------------------------------------------------------------------|
| **Backend**   | `backend/`       | FastAPI server handling LLM generation, database ops, and API keys |
| **Extension** | `extension/`     | Chrome extension with sidebar UI and automation                    |
| **Dashboard** | `dashboard-app/` | React web app for analytics and management                         |

## Prerequisites

- **Python 3.11+** (for backend)
- **Node.js 18+** (for dashboard)
- **Chrome browser** (for extension)
- **Supabase account** - <https://supabase.com>
- **OpenRouter API key** - <https://openrouter.ai/keys>

## Quick Start

### 1. Backend Setup

```bash
cd backend

# Create and activate virtual environment
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate

# Install dependencies (choose one)
pip install -r requirements.txt
# OR with uv (faster)
uv sync

# Configure environment
cp .env.example .env
```

Edit `.env` with your credentials:

```env
# Required
OPENROUTER_API_KEY=sk-or-v1-your_key_here
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your_supabase_service_role_key

# Generate encryption keys with:
# python -c "import secrets; print(secrets.token_hex(32))"
COOKIE_ENCRYPTION_KEY=your_64_char_hex_key
ENCRYPTION_KEY=your_64_char_hex_key
```

Start the server:

```bash
# With uv (recommended)
uv run uvicorn src.main:app --reload --port 3000

# Or with pip/venv
uvicorn src.main:app --reload --port 3000
```

Verify it's running: <http://localhost:3000/health>

API docs available at: <http://localhost:3000/docs>

### 2. Load the Chrome Extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `extension` folder from this project
5. Pin the extension to your toolbar for easy access

### 3. Configure the Extension

1. Click the extension icon in Chrome toolbar
2. Go to **Settings**
3. Enter backend URL: `http://localhost:3000`
4. Click **Test Connection** to verify
5. Save settings

### 4. Dashboard Setup (Optional)

The dashboard provides analytics, queue management, and account settings.

```bash
cd dashboard-app
npm install
npm run dev      # Development server
npm run build    # Production build
```

Open <http://localhost:5173> in your browser (dev mode).

## Usage

1. Navigate to any Reddit post or subreddit
2. Press `Alt+R` to toggle the sidebar
3. Complete the onboarding to set up your business context
4. Use the sidebar to generate and send personalized DMs

### Keyboard Shortcuts

| Shortcut | Action          |
|----------|-----------------|
| `Alt+R`  | Toggle sidebar  |
| `Alt+S`  | Stop automation |

## Project Structure

```text
reddit_ext/
├── backend/                 # FastAPI server
│   ├── src/
│   │   ├── main.py         # Application entry
│   │   ├── routes/         # API endpoints
│   │   ├── services/       # Business logic
│   │   └── utils/          # Helpers (crypto, etc.)
│   ├── requirements.txt
│   └── .env.example
│
├── extension/              # Chrome extension
│   ├── manifest.json       # Extension config
│   ├── background/         # Service worker
│   ├── content/            # Reddit content script
│   ├── popup/              # Extension popup UI
│   └── styles/             # CSS
│
└── dashboard-app/          # React dashboard
    ├── src/
    └── package.json
```

## Troubleshooting

### Backend won't start

- Ensure Python 3.11+ is installed: `python --version`
- Check all required env variables are set
- Verify Supabase credentials are correct

### Extension not connecting

- Confirm backend is running on the configured port
- Check Chrome console for CORS errors
- Ensure `http://localhost:3000` is in `ALLOWED_ORIGINS` (or leave empty for dev)

### LLM generation failing

- Verify OpenRouter API key is valid
- Check API key has sufficient credits
- Review backend logs for specific errors

## Security Notes

- API keys are stored on the backend only, never in the extension
- Cookies are encrypted with AES-256-GCM
- Use environment variables, never commit `.env` files

## Documentation

- [Backend API Reference](backend/README.md)
- [Extension Guide](extension/README.md)

# Reddit Insight Gatherer

A Chrome extension for gathering user insights from Reddit by sending thoughtful, AI-generated DMs.

## Architecture

This project is divided into two parts:

### Frontend (Chrome Extension)
Located in `frontend/`. The Chrome extension that:
- Injects a sidebar on Reddit pages
- Extracts post data
- Handles the automation flow (navigating, clicking, typing)
- Communicates with the backend for LLM generation and data storage

### Backend (API Server)
Located in `backend/`. An Express.js server that:
- Stores API keys securely (OpenRouter, Supabase)
- Handles LLM generation via OpenRouter
- Manages database operations via Supabase
- Provides REST API endpoints for the extension

## Quick Start

### 1. Set up the Backend

```bash
cd backend
npm install
cp .env.example .env
# Edit .env with your API keys
npm run dev
```

### 2. Load the Extension

1. Go to `chrome://extensions/` in Chrome
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `frontend` folder
5. Configure the backend URL in extension settings

## Why This Architecture?

- **Security**: API keys are stored on the backend, not in the extension
- **Flexibility**: Backend can be deployed anywhere (local, cloud, etc.)
- **Maintainability**: Clear separation of concerns
- **Scalability**: Backend can be extended with additional features

## Documentation

- [Frontend README](frontend/README.md) - Extension setup and usage
- [Backend README](backend/README.md) - Server setup and API documentation

# Reddit Insight Backend (Python)

Backend API for the Reddit Insight Gatherer Chrome Extension, built with FastAPI.

## Requirements

- Python 3.10+
- pip

## Setup

1. Create a virtual environment:
```bash
cd backend_py
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
```

2. Install dependencies:
```bash
pip install -r requirements.txt
```

3. Copy the environment file and configure:
```bash
cp .env.example .env
# Edit .env with your configuration
```

4. Run the server:
```bash
# Development mode (with auto-reload)
uvicorn src.main:app --reload --port 3000

# Or using Python directly
python -m src.main
```

## API Endpoints

### Health & Status
- `GET /health` - Server health check
- `GET /api/status` - Configuration status

### LLM Generation
- `POST /api/generate` - Generate DM message from post
- `GET /api/models` - Get available AI models

### DM History
- `POST /api/dm` - Log sent DM
- `GET /api/dm/history` - Get DM history
- `GET /api/dm/subreddits` - Get top subreddits by DM count

### Automation Sessions
- `POST /api/session/start` - Start automation session
- `PATCH /api/session/{sessionId}` - Update session progress
- `GET /api/session/logs` - Get automation logs

### Analytics & Settings
- `GET /api/analytics` - Get analytics data
- `GET /api/settings` - Get user settings
- `POST /api/settings` - Save user settings

### Classification
- `POST /api/classify` - Classify single post
- `POST /api/classify/batch` - Classify multiple posts
- `GET /api/classification/stats` - Classification statistics

### Qualification
- `GET /api/qualify/{username}` - Qualify single user
- `POST /api/qualify/batch` - Qualify multiple users
- `GET /api/qualification/stats` - Qualification statistics
- `POST /api/filter` - Combined classify + qualify endpoint

### Queue Management
- `GET /api/queue` - Get queue items with filters
- `POST /api/queue` - Add item to queue
- `GET /api/queue/stats` - Queue statistics
- `GET /api/queue/next` - Get next item to send
- `GET /api/queue/{id}` - Get single queue item
- `PATCH /api/queue/{id}` - Update queue item
- `DELETE /api/queue/{id}` - Delete queue item
- `POST /api/queue/{id}/approve` - Approve queue item
- `POST /api/queue/{id}/reject` - Reject queue item
- `POST /api/queue/{id}/sent` - Mark as sent
- `POST /api/queue/{id}/failed` - Mark as failed
- `POST /api/queue/bulk-approve` - Bulk approve items
- `POST /api/queue/bulk-reject` - Bulk reject items

### Account Management
- `GET /api/accounts` - Get accounts with filters
- `POST /api/accounts` - Add new account
- `GET /api/accounts/{id}` - Get account details
- `PATCH /api/accounts/{id}` - Update account
- `DELETE /api/accounts/{id}` - Delete account
- `GET /api/accounts/{id}/cookies` - Get encrypted cookies
- `GET /api/accounts/{id}/can-send` - Check DM capability
- `POST /api/accounts/{id}/increment-dm` - Increment daily count
- `POST /api/accounts/{id}/check-shadowban` - Check shadowban status
- `GET /api/accounts/{id}/subreddits` - Get assigned subreddits
- `POST /api/accounts/{id}/subreddits` - Assign to subreddit
- `DELETE /api/accounts/{id}/subreddits/{subreddit}` - Remove from subreddit

### Rotation
- `GET /api/rotation/next/{subreddit}` - Select account for subreddit
- `GET /api/rotation/status` - Get rotation status
- `GET /api/rotation/next-available` - Get next available account

### Safety
- `GET /api/safety/events` - Get safety events
- `POST /api/safety/events` - Log safety event
- `GET /api/safety/health/{accountId}` - Get account health

### Rules
- `GET /api/rules` - Get rules
- `POST /api/rules` - Create rule
- `GET /api/rules/templates` - Get default rule templates
- `PATCH /api/rules/{id}` - Update rule
- `DELETE /api/rules/{id}` - Delete rule
- `POST /api/rules/evaluate` - Evaluate rules against post
- `POST /api/rules/test` - Test rule with sample data

### Conversations
- `GET /api/conversations` - Get conversations with filters
- `POST /api/conversations` - Create conversation
- `GET /api/conversations/stats` - Conversation statistics
- `GET /api/conversations/search` - Search conversations
- `GET /api/conversations/{id}` - Get conversation with messages
- `PATCH /api/conversations/{id}` - Update conversation
- `POST /api/conversations/{id}/messages` - Add message
- `GET /api/conversations/{id}/messages` - Get conversation messages
- `POST /api/conversations/sync` - Sync from Reddit chat data
- `POST /api/conversations/{id}/reply-suggestion` - Generate reply suggestion

## Project Structure

```
backend_py/
├── requirements.txt          # Python dependencies
├── .env.example              # Environment template
├── README.md                 # This file
└── src/
    ├── __init__.py
    ├── main.py               # FastAPI application entry point
    ├── routes/
    │   ├── __init__.py
    │   └── api.py            # All API route definitions
    ├── services/
    │   ├── __init__.py
    │   ├── supabase_service.py   # Database operations
    │   ├── llm.py                # LLM/OpenRouter integration
    │   ├── classification.py     # Post classification
    │   ├── qualification.py      # User qualification
    │   ├── queue.py              # DM queue management
    │   ├── accounts.py           # Reddit account management
    │   ├── rotation.py           # Account rotation/selection
    │   ├── safety.py             # Safety, humanization
    │   ├── rules.py              # Filter rules engine
    │   └── conversations.py      # Inbox conversation tracking
    └── utils/
        ├── __init__.py
        └── crypto.py             # AES-256-GCM encryption
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 3000) |
| `OPENROUTER_API_KEY` | OpenRouter API key for LLM |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_KEY` | Supabase anon key |
| `ALLOWED_ORIGINS` | Comma-separated CORS origins |
| `COOKIE_ENCRYPTION_KEY` | 64-char hex key for AES-256 |
| `ENCRYPTION_KEY` | Backup encryption key |

## Generate Encryption Key

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

## Interactive API Docs

Once running, visit:
- Swagger UI: http://localhost:3000/docs
- ReDoc: http://localhost:3000/redoc

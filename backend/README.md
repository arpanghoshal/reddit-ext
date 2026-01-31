# Reddit Insight Gatherer - Backend

Backend API server for the Reddit Insight Gatherer Chrome Extension.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file based on `.env.example`:
```bash
cp .env.example .env
```

3. Configure your environment variables in `.env`:
```
PORT=3000
OPENROUTER_API_KEY=your_openrouter_api_key
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your_supabase_anon_key
```

4. Start the server:
```bash
# Development (with auto-reload)
npm run dev

# Production
npm start
```

## API Endpoints

### Health & Status
- `GET /health` - Server health check
- `GET /api/status` - Check configuration status

### LLM Generation
- `POST /api/generate` - Generate a DM message
- `GET /api/models` - Get available AI models

### DM History
- `POST /api/dm` - Log a sent DM
- `GET /api/dm/history?limit=50` - Get DM history
- `GET /api/dm/subreddits?limit=10` - Get top subreddits

### Automation Sessions
- `POST /api/session/start` - Start a new automation session
- `PATCH /api/session/:sessionId` - Update session progress
- `GET /api/session/logs?limit=20` - Get automation logs

### Analytics
- `GET /api/analytics` - Get analytics data

### Settings
- `GET /api/settings` - Get user settings
- `POST /api/settings` - Save user settings

## Database Schema

The backend expects these Supabase tables:

### dm_history
```sql
create table dm_history (
  id uuid primary key default gen_random_uuid(),
  recipient_username text not null,
  post_url text,
  post_title text,
  subreddit text,
  message_content text not null,
  status text default 'sent',
  automation_type text default 'single',
  session_id text,
  created_at timestamptz default now()
);
```

### automation_logs
```sql
create table automation_logs (
  id uuid primary key default gen_random_uuid(),
  session_id text unique not null,
  subreddit text,
  total_posts int default 0,
  processed_count int default 0,
  success_count int default 0,
  failed_count int default 0,
  status text default 'running',
  created_at timestamptz default now(),
  completed_at timestamptz
);
```

### user_settings
```sql
create table user_settings (
  id uuid primary key default gen_random_uuid(),
  business_desc text,
  persona text,
  insight_types text[],
  tone text default 'Curious',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
```

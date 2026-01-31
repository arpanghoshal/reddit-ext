import express from 'express';
import * as supabase from '../services/supabase.js';
import * as llm from '../services/llm.js';

export const router = express.Router();

// --- LLM Routes ---

router.post('/generate', async (req, res, next) => {
    try {
        const { post, settings } = req.body;

        if (!post) {
            return res.status(400).json({ error: 'Post data is required' });
        }

        const message = await llm.generateQuestion({ post, settings: settings || {} });
        res.json({ success: true, message });
    } catch (error) {
        next(error);
    }
});

router.get('/models', (req, res) => {
    res.json({ models: llm.getAvailableModels() });
});

// --- DM History Routes ---

router.post('/dm', async (req, res, next) => {
    try {
        const result = await supabase.logDM(req.body);
        res.json({ success: true, data: result });
    } catch (error) {
        next(error);
    }
});

router.get('/dm/history', async (req, res, next) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const history = await supabase.getDMHistory(limit);
        res.json({ success: true, data: history });
    } catch (error) {
        next(error);
    }
});

router.get('/dm/subreddits', async (req, res, next) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        const data = await supabase.getDMsBySubreddit(limit);
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
});

// --- Automation Session Routes ---

router.post('/session/start', async (req, res, next) => {
    try {
        const result = await supabase.startAutomationSession(req.body);
        res.json({ success: true, ...result });
    } catch (error) {
        next(error);
    }
});

router.patch('/session/:sessionId', async (req, res, next) => {
    try {
        const { sessionId } = req.params;
        const result = await supabase.updateAutomationSession(sessionId, req.body);
        res.json({ success: true, data: result });
    } catch (error) {
        next(error);
    }
});

router.get('/session/logs', async (req, res, next) => {
    try {
        const limit = parseInt(req.query.limit) || 20;
        const logs = await supabase.getAutomationLogs(limit);
        res.json({ success: true, data: logs });
    } catch (error) {
        next(error);
    }
});

// --- Analytics Routes ---

router.get('/analytics', async (req, res, next) => {
    try {
        const analytics = await supabase.getAnalytics();
        res.json({ success: true, data: analytics });
    } catch (error) {
        next(error);
    }
});

// --- Settings Routes ---

router.get('/settings', async (req, res, next) => {
    try {
        const settings = await supabase.getSettings();
        res.json({ success: true, data: settings });
    } catch (error) {
        next(error);
    }
});

router.post('/settings', async (req, res, next) => {
    try {
        const result = await supabase.saveSettings(req.body);
        res.json({ success: true, data: result });
    } catch (error) {
        next(error);
    }
});

// --- Health/Status ---

router.get('/status', (req, res) => {
    res.json({
        supabaseConfigured: supabase.isConfigured(),
        openrouterConfigured: !!process.env.OPENROUTER_API_KEY
    });
});

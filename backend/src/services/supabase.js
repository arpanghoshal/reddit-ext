import { createClient } from '@supabase/supabase-js';

let supabase = null;

function getClient() {
    if (!supabase) {
        const url = process.env.SUPABASE_URL;
        const key = process.env.SUPABASE_KEY;

        if (!url || !key) {
            return null;
        }

        supabase = createClient(url, key);
    }
    return supabase;
}

export function isConfigured() {
    return !!process.env.SUPABASE_URL && !!process.env.SUPABASE_KEY;
}

export function generateSessionId() {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// --- DM History ---

export async function logDM(data) {
    const client = getClient();
    if (!client) {
        console.log('Supabase not configured - skipping DM logging');
        return null;
    }

    try {
        const { data: result, error } = await client
            .from('dm_history')
            .insert({
                recipient_username: data.recipientUsername,
                post_url: data.postUrl || null,
                post_title: data.postTitle || null,
                subreddit: data.subreddit || null,
                message_content: data.messageContent,
                status: data.status || 'sent',
                automation_type: data.automationType || 'single',
                session_id: data.sessionId || null
            })
            .select()
            .single();

        if (error) {
            console.error('Supabase logDM error:', error);
            return null;
        }

        console.log('DM logged to Supabase:', result);
        return result;
    } catch (error) {
        console.error('Failed to log DM:', error);
        return null;
    }
}

export async function getDMHistory(limit = 50) {
    const client = getClient();
    if (!client) {
        return [];
    }

    try {
        const { data, error } = await client
            .from('dm_history')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) {
            console.error('Supabase getDMHistory error:', error);
            return [];
        }

        return data;
    } catch (error) {
        console.error('Failed to get DM history:', error);
        return [];
    }
}

// --- Automation Logs ---

export async function startAutomationSession(data) {
    const client = getClient();
    const sessionId = generateSessionId();

    if (!client) {
        console.log('Supabase not configured - skipping session logging');
        return { sessionId, record: null };
    }

    try {
        const { data: result, error } = await client
            .from('automation_logs')
            .insert({
                session_id: sessionId,
                subreddit: data.subreddit || null,
                total_posts: data.totalPosts || 0,
                processed_count: 0,
                success_count: 0,
                failed_count: 0,
                status: 'running'
            })
            .select()
            .single();

        if (error) {
            console.error('Supabase startAutomationSession error:', error);
            return { sessionId, record: null };
        }

        console.log('Automation session started:', result);
        return { sessionId, record: result };
    } catch (error) {
        console.error('Failed to start automation session:', error);
        return { sessionId, record: null };
    }
}

export async function updateAutomationSession(sessionId, data) {
    const client = getClient();
    if (!client) {
        return null;
    }

    try {
        const updateData = {};

        if (data.processedCount !== undefined) updateData.processed_count = data.processedCount;
        if (data.successCount !== undefined) updateData.success_count = data.successCount;
        if (data.failedCount !== undefined) updateData.failed_count = data.failedCount;
        if (data.status) updateData.status = data.status;
        if (data.status === 'completed' || data.status === 'stopped') {
            updateData.completed_at = new Date().toISOString();
        }

        const { data: result, error } = await client
            .from('automation_logs')
            .update(updateData)
            .eq('session_id', sessionId)
            .select()
            .single();

        if (error) {
            console.error('Supabase updateAutomationSession error:', error);
            return null;
        }

        console.log('Automation session updated:', result);
        return result;
    } catch (error) {
        console.error('Failed to update automation session:', error);
        return null;
    }
}

export async function getAutomationLogs(limit = 20) {
    const client = getClient();
    if (!client) {
        return [];
    }

    try {
        const { data, error } = await client
            .from('automation_logs')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) {
            console.error('Supabase getAutomationLogs error:', error);
            return [];
        }

        return data;
    } catch (error) {
        console.error('Failed to get automation logs:', error);
        return [];
    }
}

// --- User Settings ---

export async function saveSettings(settings) {
    const client = getClient();
    if (!client) {
        console.log('Supabase not configured - settings saved locally only');
        return null;
    }

    try {
        const existing = await getSettings();

        const settingsData = {
            business_desc: settings.businessDesc || null,
            persona: settings.persona || null,
            insight_types: settings.insightTypes || [],
            tone: settings.tone || 'Curious',
            updated_at: new Date().toISOString()
        };

        let result, error;

        if (existing) {
            ({ data: result, error } = await client
                .from('user_settings')
                .update(settingsData)
                .eq('id', existing.id)
                .select()
                .single());
        } else {
            ({ data: result, error } = await client
                .from('user_settings')
                .insert(settingsData)
                .select()
                .single());
        }

        if (error) {
            console.error('Supabase saveSettings error:', error);
            return null;
        }

        console.log('Settings saved to Supabase:', result);
        return result;
    } catch (error) {
        console.error('Failed to save settings:', error);
        return null;
    }
}

export async function getSettings() {
    const client = getClient();
    if (!client) {
        return null;
    }

    try {
        const { data, error } = await client
            .from('user_settings')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

        if (error && error.code !== 'PGRST116') { // PGRST116 = no rows found
            console.error('Supabase getSettings error:', error);
            return null;
        }

        return data || null;
    } catch (error) {
        console.error('Failed to get settings:', error);
        return null;
    }
}

// --- Analytics Functions ---

export async function getAnalytics() {
    const client = getClient();
    if (!client) {
        return { totalDMs: 0, successRate: 0, todayCount: 0, weekCount: 0 };
    }

    try {
        const { data: dms, error } = await client
            .from('dm_history')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(1000);

        if (error) {
            return { totalDMs: 0, successRate: 0, todayCount: 0, weekCount: 0 };
        }

        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

        const todayDMs = dms.filter(dm => new Date(dm.created_at) >= today);
        const weekDMs = dms.filter(dm => new Date(dm.created_at) >= weekAgo);
        const successDMs = dms.filter(dm => dm.status === 'sent');

        return {
            totalDMs: dms.length,
            successRate: dms.length > 0 ? Math.round((successDMs.length / dms.length) * 100) : 0,
            todayCount: todayDMs.length,
            weekCount: weekDMs.length
        };
    } catch (error) {
        console.error('Failed to get analytics:', error);
        return { totalDMs: 0, successRate: 0, todayCount: 0, weekCount: 0 };
    }
}

export async function getDMsBySubreddit(limit = 10) {
    const client = getClient();
    if (!client) {
        return [];
    }

    try {
        const { data: dms, error } = await client
            .from('dm_history')
            .select('subreddit')
            .order('created_at', { ascending: false })
            .limit(500);

        if (error) {
            return [];
        }

        // Count by subreddit
        const counts = {};
        dms.forEach(dm => {
            if (dm.subreddit) {
                counts[dm.subreddit] = (counts[dm.subreddit] || 0) + 1;
            }
        });

        // Sort by count and take top N
        return Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
            .map(([subreddit, count]) => ({ subreddit, count }));
    } catch (error) {
        console.error('Failed to get DMs by subreddit:', error);
        return [];
    }
}

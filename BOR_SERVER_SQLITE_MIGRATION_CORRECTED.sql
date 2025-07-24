-- BOR-SERVER SQLITE MIGRATION (CORRECTED)
-- This enhances your existing bor-server SQLite database for platform integration
-- Run this on your bor-server SQLite database

-- =====================================================
-- STEP 1: ENHANCE EXISTING COMMENTS TABLE
-- =====================================================

-- Check current Comments table structure
PRAGMA table_info(Comments);

-- Add user authentication fields to existing Comments table
-- SQLite doesn't have IF NOT EXISTS for columns, so we'll use a different approach

-- Add new columns to Comments table for platform integration
ALTER TABLE Comments ADD COLUMN user_id TEXT; -- References Protocol accounts.id
ALTER TABLE Comments ADD COLUMN is_authenticated INTEGER DEFAULT 0; -- SQLite uses INTEGER for BOOLEAN
ALTER TABLE Comments ADD COLUMN session_id TEXT; -- Links to socket sessions

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_comments_user_id ON Comments(user_id);
CREATE INDEX IF NOT EXISTS idx_comments_authenticated ON Comments(is_authenticated) WHERE is_authenticated = 1;
CREATE INDEX IF NOT EXISTS idx_comments_session ON Comments(session_id);
CREATE INDEX IF NOT EXISTS idx_comments_agent_date ON Comments(agentId, createdAt DESC);

-- =====================================================
-- STEP 2: CREATE AIRESPONSES TABLE (If not exists)
-- =====================================================

-- Create AIResponses table based on the AIResponse model
-- Note: Sequelize usually pluralizes table names
CREATE TABLE IF NOT EXISTS AIResponses (
    id TEXT PRIMARY KEY,
    agentId TEXT NOT NULL,
    text TEXT NOT NULL,
    thought TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    -- Add platform integration fields
    responding_to_user_id TEXT, -- Which user triggered this response
    session_context TEXT, -- 'public' or appointment_id for private
    response_time_ms INTEGER DEFAULT 0, -- How long to generate response
    token_count INTEGER DEFAULT 0, -- Tokens used in response
    audio_url TEXT, -- Generated TTS audio URL
    animation_triggered TEXT -- Animation that was triggered
);

-- Add indexes for AIResponses
CREATE INDEX IF NOT EXISTS idx_airesponses_agent ON AIResponses(agentId, createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_airesponses_user ON AIResponses(responding_to_user_id);
CREATE INDEX IF NOT EXISTS idx_airesponses_session ON AIResponses(session_context);

-- =====================================================
-- STEP 3: AUTHENTICATION TABLES
-- =====================================================

-- Auth tokens table for local token validation
CREATE TABLE IF NOT EXISTS auth_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,
    user_id TEXT NOT NULL, -- References Protocol accounts.id
    agent_id TEXT, -- If token is agent-specific
    token_type TEXT DEFAULT 'bearer' CHECK (token_type IN ('bearer', 'api_key', 'session')),
    expires_at DATETIME NOT NULL,
    permissions TEXT DEFAULT '{}', -- JSON string of permissions
    device_info TEXT DEFAULT '{}', -- JSON string with device details
    last_used DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active INTEGER DEFAULT 1, -- SQLite uses INTEGER for BOOLEAN
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_token ON auth_tokens(token);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_active ON auth_tokens(is_active, expires_at) WHERE is_active = 1;

-- =====================================================
-- STEP 4: SOCKET SESSION MANAGEMENT
-- =====================================================

-- Socket sessions for real-time connection tracking
CREATE TABLE IF NOT EXISTS socket_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    socket_id TEXT UNIQUE NOT NULL,
    user_id TEXT, -- References Protocol accounts.id (NULL for anonymous)
    agent_id TEXT, -- Which agent they're connected to
    room_type TEXT DEFAULT 'public' CHECK (room_type IN ('public', 'private')),
    room_id TEXT, -- References Protocol rooms.id
    appointment_id TEXT, -- If this is a private session
    
    -- Connection details
    ip_address TEXT,
    user_agent TEXT,
    connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active INTEGER DEFAULT 1,
    
    -- Session metrics
    messages_sent INTEGER DEFAULT 0,
    responses_received INTEGER DEFAULT 0,
    connection_quality TEXT DEFAULT 'good' CHECK (connection_quality IN ('excellent', 'good', 'fair', 'poor')),
    
    -- Disconnect info
    disconnected_at DATETIME,
    disconnect_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_socket_sessions_socket ON socket_sessions(socket_id);
CREATE INDEX IF NOT EXISTS idx_socket_sessions_user ON socket_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_socket_sessions_active ON socket_sessions(is_active) WHERE is_active = 1;
CREATE INDEX IF NOT EXISTS idx_socket_sessions_room ON socket_sessions(room_id);
CREATE INDEX IF NOT EXISTS idx_socket_sessions_agent ON socket_sessions(agent_id);

-- =====================================================
-- STEP 5: RATE LIMITING SYSTEM
-- =====================================================

-- Rate limiting for abuse prevention
CREATE TABLE IF NOT EXISTS rate_limits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identifier TEXT NOT NULL, -- user_id, ip_address, or api_key
    identifier_type TEXT NOT NULL CHECK (identifier_type IN ('user', 'ip', 'api_key', 'socket')),
    action_type TEXT NOT NULL, -- 'message', 'api_call', 'login_attempt', 'booking'
    
    -- Rate limiting buckets
    requests_count INTEGER DEFAULT 0,
    window_start DATETIME DEFAULT CURRENT_TIMESTAMP,
    window_duration_seconds INTEGER DEFAULT 60, -- 1 minute window
    max_requests INTEGER DEFAULT 10,
    
    -- Penalties
    is_blocked INTEGER DEFAULT 0,
    block_until DATETIME,
    violation_count INTEGER DEFAULT 0,
    
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rate_limits_identifier ON rate_limits(identifier, identifier_type, action_type);
CREATE INDEX IF NOT EXISTS idx_rate_limits_blocked ON rate_limits(is_blocked, block_until) WHERE is_blocked = 1;

-- =====================================================
-- STEP 6: AGENT PERFORMANCE TRACKING
-- =====================================================

-- Real-time agent performance metrics
CREATE TABLE IF NOT EXISTS agent_performance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    -- Response metrics
    response_time_ms INTEGER, -- Time to generate response
    message_length INTEGER, -- Length of response
    audio_generation_time_ms INTEGER, -- Time to generate TTS
    animation_sync_time_ms INTEGER, -- Time to sync animation
    
    -- Context metrics
    context_tokens INTEGER, -- Tokens used in context
    response_tokens INTEGER, -- Tokens in response
    memory_queries INTEGER DEFAULT 0, -- Number of memory lookups
    
    -- Quality metrics
    user_reaction TEXT, -- 'positive', 'negative', 'neutral' (if detectable)
    technical_issues TEXT, -- JSON string of any technical problems
    
    -- Session context
    session_type TEXT DEFAULT 'public' CHECK (session_type IN ('public', 'private')),
    user_id TEXT, -- References Protocol accounts.id
    room_id TEXT -- References Protocol rooms.id
);

CREATE INDEX IF NOT EXISTS idx_agent_performance_agent ON agent_performance(agent_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_agent_performance_response_time ON agent_performance(response_time_ms);
CREATE INDEX IF NOT EXISTS idx_agent_performance_session ON agent_performance(session_type, timestamp DESC);

-- =====================================================
-- STEP 7: CONTENT MODERATION LOGS
-- =====================================================

-- Content moderation tracking
CREATE TABLE IF NOT EXISTS moderation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_type TEXT NOT NULL CHECK (content_type IN ('comment', 'ai_response', 'user_message')),
    content_id TEXT NOT NULL, -- ID of the content being moderated
    content_text TEXT NOT NULL,
    
    -- Moderation results
    flagged INTEGER DEFAULT 0,
    flag_reasons TEXT, -- JSON array of reasons
    confidence_score REAL DEFAULT 0, -- 0-1 confidence in moderation decision
    action_taken TEXT, -- 'allowed', 'blocked', 'warned', 'escalated'
    
    -- Context
    user_id TEXT, -- References Protocol accounts.id
    agent_id TEXT,
    session_id TEXT,
    
    -- Moderation metadata
    moderator_type TEXT DEFAULT 'automated' CHECK (moderator_type IN ('automated', 'human', 'hybrid')),
    moderator_id TEXT, -- Admin user if human moderated
    processing_time_ms INTEGER,
    
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_moderation_logs_flagged ON moderation_logs(flagged, created_at DESC) WHERE flagged = 1;
CREATE INDEX IF NOT EXISTS idx_moderation_logs_user ON moderation_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_moderation_logs_content ON moderation_logs(content_type, content_id);

-- =====================================================
-- STEP 8: SYSTEM HEALTH MONITORING
-- =====================================================

-- Real-time system health metrics
CREATE TABLE IF NOT EXISTS system_health (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    -- Server metrics
    active_connections INTEGER DEFAULT 0,
    authenticated_users INTEGER DEFAULT 0,
    anonymous_users INTEGER DEFAULT 0,
    active_agents INTEGER DEFAULT 0,
    
    -- Performance metrics
    average_response_time REAL DEFAULT 0,
    peak_response_time REAL DEFAULT 0,
    memory_usage_mb REAL DEFAULT 0,
    cpu_usage_percent REAL DEFAULT 0,
    
    -- Business metrics
    public_sessions INTEGER DEFAULT 0,
    private_sessions INTEGER DEFAULT 0,
    messages_per_minute REAL DEFAULT 0,
    revenue_per_hour REAL DEFAULT 0,
    
    -- Error tracking
    error_count INTEGER DEFAULT 0,
    warning_count INTEGER DEFAULT 0,
    critical_errors INTEGER DEFAULT 0,
    
    -- Agent-specific metrics
    agent_metrics TEXT DEFAULT '{}' -- JSON object with per-agent stats
);

CREATE INDEX IF NOT EXISTS idx_system_health_timestamp ON system_health(timestamp DESC);

-- =====================================================
-- STEP 9: SESSION ANALYTICS
-- =====================================================

-- Detailed session analytics for real-time tracking
CREATE TABLE IF NOT EXISTS session_analytics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL, -- Socket session ID
    user_id TEXT, -- Protocol user ID
    agent_id TEXT NOT NULL,
    session_type TEXT NOT NULL CHECK (session_type IN ('public', 'private')),
    
    -- Timing metrics
    session_start DATETIME DEFAULT CURRENT_TIMESTAMP,
    session_end DATETIME,
    total_duration_seconds INTEGER,
    active_duration_seconds INTEGER, -- Time actually chatting
    idle_duration_seconds INTEGER, -- Time inactive
    
    -- Interaction metrics
    total_messages INTEGER DEFAULT 0,
    user_messages INTEGER DEFAULT 0,
    agent_responses INTEGER DEFAULT 0,
    average_message_length REAL DEFAULT 0,
    
    -- Quality metrics
    response_satisfaction_score REAL DEFAULT 0, -- Based on user behavior
    technical_issues_count INTEGER DEFAULT 0,
    connection_drops INTEGER DEFAULT 0,
    
    -- Business metrics
    points_spent INTEGER DEFAULT 0,
    conversion_event TEXT, -- If user upgraded, booked, etc.
    
    -- Completion status
    completed_successfully INTEGER DEFAULT 0,
    early_termination_reason TEXT,
    
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_session_analytics_user ON session_analytics(user_id, session_start DESC);
CREATE INDEX IF NOT EXISTS idx_session_analytics_agent ON session_analytics(agent_id, session_start DESC);
CREATE INDEX IF NOT EXISTS idx_session_analytics_type ON session_analytics(session_type, session_start DESC);

-- =====================================================
-- STEP 10: DEFAULT RATE LIMIT CONFIGURATIONS
-- =====================================================

-- Insert default rate limit configurations
INSERT OR IGNORE INTO rate_limits (identifier, identifier_type, action_type, max_requests, window_duration_seconds)
VALUES 
    ('default_user', 'user', 'message', 30, 60),          -- 30 messages per minute per user
    ('default_user', 'user', 'api_call', 100, 60),        -- 100 API calls per minute per user
    ('default_ip', 'ip', 'login_attempt', 5, 300),        -- 5 login attempts per 5 minutes per IP
    ('default_ip', 'ip', 'message', 60, 60),              -- 60 messages per minute per IP (anonymous users)
    ('default_socket', 'socket', 'connection', 10, 60);   -- 10 connections per minute per socket

-- =====================================================
-- STEP 11: VERIFICATION AND SUMMARY
-- =====================================================

-- Count tables and show summary
SELECT 
    'BOR-SERVER SQLITE MIGRATION COMPLETED' as status,
    (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN (
        'auth_tokens', 'socket_sessions', 'rate_limits', 'agent_performance',
        'moderation_logs', 'system_health', 'session_analytics', 'AIResponses'
    )) as new_tables_created,
    (SELECT COUNT(*) FROM Comments) as total_comments,
    (SELECT COUNT(*) FROM AIResponses) as total_ai_responses,
    (SELECT COUNT(*) FROM auth_tokens) as auth_tokens_count,
    (SELECT COUNT(*) FROM socket_sessions) as socket_sessions_count,
    (SELECT COUNT(*) FROM rate_limits) as rate_limit_rules;

-- Show enhanced table structures
SELECT 
    'ENHANCED COMMENTS TABLE' as info,
    COUNT(*) as total_comments,
    COUNT(CASE WHEN user_id IS NOT NULL THEN 1 END) as authenticated_comments,
    COUNT(CASE WHEN user_id IS NULL THEN 1 END) as anonymous_comments
FROM Comments;

SELECT 
    'AIRESPONSES TABLE' as info,
    COUNT(*) as total_responses,
    COUNT(CASE WHEN responding_to_user_id IS NOT NULL THEN 1 END) as user_triggered_responses,
    AVG(response_time_ms) as avg_response_time_ms
FROM AIResponses;

-- Show system readiness
SELECT 
    '🎉 BOR-SERVER INTEGRATION COMPLETE! 🎉' as status,
    '✅ Authentication system ready' as auth_status,
    '✅ Real-time session tracking ready' as session_status,
    '✅ Rate limiting ready' as rate_limit_status,
    '✅ Performance monitoring ready' as performance_status,
    '✅ Content moderation ready' as moderation_status,
    '✅ Analytics tracking ready' as analytics_status;

-- Final instructions
SELECT 
    'NEXT STEPS:' as instruction,
    '1. Import AIResponse model in bor-server index.js if needed' as step_1,
    '2. Integrate JWT middleware with bor-server Express app' as step_2,
    '3. Update Socket.io handlers to use authentication' as step_3,
    '4. Apply rate limiting to API endpoints' as step_4,
    '5. Start performance monitoring' as step_5,
    '6. Begin frontend authentication integration' as step_6;
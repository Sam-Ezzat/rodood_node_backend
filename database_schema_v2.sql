-- Professional Database Schema V2.0
-- Optimized for high-performance chatbot operations with proper relationships

-- Users and Authentication
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('admin', 'user', 'manager')),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    last_login TIMESTAMP,
    metadata JSONB DEFAULT '{}'
);

-- Social Media Platforms
CREATE TABLE platforms (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL, -- 'facebook', 'instagram', 'whatsapp'
    api_version VARCHAR(20) NOT NULL,
    base_url VARCHAR(255) NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Pages/Accounts across platforms
CREATE TABLE pages (
    id SERIAL PRIMARY KEY,
    platform_id INTEGER REFERENCES platforms(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    page_id VARCHAR(100) NOT NULL, -- Facebook/Instagram page ID
    page_name VARCHAR(255) NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    token_expires_at TIMESTAMP,
    page_category VARCHAR(100),
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'suspended')),
    webhook_verified BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    metadata JSONB DEFAULT '{}',
    UNIQUE(platform_id, page_id)
);

-- AI Assistants configuration
CREATE TABLE assistants (
    id SERIAL PRIMARY KEY,
    assistant_id VARCHAR(100) UNIQUE NOT NULL, -- OpenAI assistant ID
    name VARCHAR(255) NOT NULL,
    model VARCHAR(50) DEFAULT 'gpt-4',
    instructions TEXT,
    tools JSONB DEFAULT '[]',
    file_ids JSONB DEFAULT '[]',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Page configurations with AI assistant mapping
CREATE TABLE page_configs (
    id SERIAL PRIMARY KEY,
    page_id INTEGER REFERENCES pages(id) ON DELETE CASCADE,
    assistant_id INTEGER REFERENCES assistants(id) ON DELETE SET NULL,
    greeting_message TEXT DEFAULT '',
    first_message TEXT NOT NULL,
    end_message TEXT NOT NULL,
    stop_message VARCHAR(10) DEFAULT '*',
    max_messages INTEGER DEFAULT 10,
    response_delay_seconds INTEGER DEFAULT 0,
    business_hours JSONB DEFAULT '{}', -- {"start": "09:00", "end": "17:00", "timezone": "UTC"}
    auto_responses JSONB DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(page_id)
);

-- Cross-platform account mapping (Instagram to Facebook)
CREATE TABLE platform_mappings (
    id SERIAL PRIMARY KEY,
    source_page_id INTEGER REFERENCES pages(id) ON DELETE CASCADE,
    target_page_id INTEGER REFERENCES pages(id) ON DELETE CASCADE,
    mapping_type VARCHAR(20) DEFAULT 'instagram_to_facebook',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(source_page_id, target_page_id)
);

-- Conversations
CREATE TABLE conversations (
    id SERIAL PRIMARY KEY,
    page_id INTEGER REFERENCES pages(id) ON DELETE CASCADE,
    sender_id VARCHAR(100) NOT NULL, -- User's PSID
    sender_name VARCHAR(255),
    platform_thread_id VARCHAR(100), -- Platform-specific thread ID
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'ended', 'transferred', 'archived')),
    conversation_type VARCHAR(20) DEFAULT 'customer' CHECK (conversation_type IN ('customer', 'lead', 'support')),
    language_code VARCHAR(10) DEFAULT 'en',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    ended_at TIMESTAMP,
    metadata JSONB DEFAULT '{}',
    UNIQUE(page_id, sender_id)
);

-- Messages with proper relationships
CREATE TABLE messages (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
    message_id VARCHAR(100), -- Platform message ID
    sender_type VARCHAR(10) CHECK (sender_type IN ('user', 'bot', 'agent')),
    content TEXT NOT NULL,
    message_type VARCHAR(20) DEFAULT 'text' CHECK (message_type IN ('text', 'image', 'video', 'audio', 'file', 'quick_reply')),
    attachments JSONB DEFAULT '[]',
    metadata JSONB DEFAULT '{}',
    sent_at TIMESTAMP DEFAULT NOW(),
    delivered_at TIMESTAMP,
    read_at TIMESTAMP,
    response_time_ms INTEGER, -- Time to generate response
    INDEX (conversation_id, sent_at)
);

-- AI Sessions for conversation context
CREATE TABLE ai_sessions (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
    assistant_id INTEGER REFERENCES assistants(id) ON DELETE CASCADE,
    thread_id VARCHAR(100), -- OpenAI thread ID
    run_id VARCHAR(100), -- OpenAI run ID
    context_messages JSONB DEFAULT '[]',
    session_state JSONB DEFAULT '{}',
    token_usage INTEGER DEFAULT 0,
    cost_usd DECIMAL(10,4) DEFAULT 0,
    started_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    ended_at TIMESTAMP,
    UNIQUE(conversation_id)
);

-- User sentiment and analytics
CREATE TABLE conversation_analytics (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
    sentiment_score DECIMAL(3,2), -- -1.00 to 1.00
    sentiment_label VARCHAR(20), -- 'positive', 'negative', 'neutral'
    engagement_score INTEGER, -- 1-10
    satisfaction_rating INTEGER, -- 1-5 if provided by user
    resolution_status VARCHAR(20) DEFAULT 'pending',
    tags JSONB DEFAULT '[]',
    analyzed_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(conversation_id)
);

-- Performance metrics and insights
CREATE TABLE metrics_daily (
    id SERIAL PRIMARY KEY,
    page_id INTEGER REFERENCES pages(id) ON DELETE CASCADE,
    metric_date DATE NOT NULL,
    total_conversations INTEGER DEFAULT 0,
    total_messages INTEGER DEFAULT 0,
    avg_response_time_ms INTEGER DEFAULT 0,
    avg_sentiment_score DECIMAL(3,2) DEFAULT 0,
    user_satisfaction_avg DECIMAL(3,2) DEFAULT 0,
    bot_handoff_rate DECIMAL(5,2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(page_id, metric_date)
);

-- System logs for debugging and monitoring
CREATE TABLE system_logs (
    id SERIAL PRIMARY KEY,
    log_level VARCHAR(10) CHECK (log_level IN ('DEBUG', 'INFO', 'WARN', 'ERROR')),
    component VARCHAR(50) NOT NULL, -- 'message_handler', 'ai_processor', 'webhook'
    message TEXT NOT NULL,
    context JSONB DEFAULT '{}',
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    page_id INTEGER REFERENCES pages(id) ON DELETE SET NULL,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Webhook events tracking
CREATE TABLE webhook_events (
    id SERIAL PRIMARY KEY,
    platform_id INTEGER REFERENCES platforms(id) ON DELETE CASCADE,
    event_type VARCHAR(50) NOT NULL,
    raw_payload JSONB NOT NULL,
    processed BOOLEAN DEFAULT false,
    processing_status VARCHAR(20) DEFAULT 'pending',
    error_message TEXT,
    received_at TIMESTAMP DEFAULT NOW(),
    processed_at TIMESTAMP,
    INDEX (platform_id, received_at),
    INDEX (processed, received_at)
);

-- Database indexes for performance
CREATE INDEX idx_conversations_page_sender ON conversations(page_id, sender_id);
CREATE INDEX idx_messages_conversation_time ON messages(conversation_id, sent_at DESC);
CREATE INDEX idx_ai_sessions_conversation ON ai_sessions(conversation_id);
CREATE INDEX idx_pages_user_status ON pages(user_id, status);
CREATE INDEX idx_page_configs_page ON page_configs(page_id);
CREATE INDEX idx_metrics_page_date ON metrics_daily(page_id, metric_date DESC);
CREATE INDEX idx_system_logs_component_time ON system_logs(component, created_at DESC);
CREATE INDEX idx_webhook_events_processing ON webhook_events(processed, received_at);

-- Functions for automatic timestamp updates
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for automatic timestamp updates
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_pages_updated_at BEFORE UPDATE ON pages
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_page_configs_updated_at BEFORE UPDATE ON page_configs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_conversations_updated_at BEFORE UPDATE ON conversations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_ai_sessions_updated_at BEFORE UPDATE ON ai_sessions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Insert default platforms
INSERT INTO platforms (name, api_version, base_url) VALUES
('facebook', 'v18.0', 'https://graph.facebook.com'),
('instagram', 'v18.0', 'https://graph.facebook.com'),
('whatsapp', 'v18.0', 'https://graph.facebook.com');

-- Views for common queries
CREATE VIEW active_conversations AS
SELECT 
    c.*,
    p.page_name,
    p.platform_id,
    COUNT(m.id) as message_count,
    MAX(m.sent_at) as last_message_at
FROM conversations c
JOIN pages p ON c.page_id = p.id
LEFT JOIN messages m ON c.id = m.conversation_id
WHERE c.status = 'active'
GROUP BY c.id, p.page_name, p.platform_id;

CREATE VIEW conversation_summary AS
SELECT 
    c.id,
    c.sender_id,
    p.page_name,
    COUNT(m.id) as total_messages,
    MAX(m.sent_at) as last_activity,
    AVG(m.response_time_ms) as avg_response_time,
    ca.sentiment_label,
    ca.sentiment_score
FROM conversations c
JOIN pages p ON c.page_id = p.id
LEFT JOIN messages m ON c.id = m.conversation_id
LEFT JOIN conversation_analytics ca ON c.id = ca.conversation_id
GROUP BY c.id, c.sender_id, p.page_name, ca.sentiment_label, ca.sentiment_score;
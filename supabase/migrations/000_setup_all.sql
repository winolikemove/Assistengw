-- ============================================
-- SantuyBot Migration: 000_setup_all
-- Enable required PostgreSQL extensions
-- ============================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enable pg_cron extension (available in Supabase)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Enable pg_net extension (required for net.http_post in pg_cron job)
CREATE EXTENSION IF NOT EXISTS pg_net;

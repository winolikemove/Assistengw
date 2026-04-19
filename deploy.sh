#!/usr/bin/env bash
set -euo pipefail

# SantuyBot - Deploy Script
# Deploy Edge Functions to Supabase

# Ganti dengan project ID kamu dari Supabase Dashboard
PROJECT_REF="YOUR_PROJECT_REF"

echo "========================================="
echo "  SantuyBot - Deploy to Supabase"
echo "========================================="
echo ""

# Check if supabase CLI is installed
if command -v supabase &> /dev/null; then
    SUPABASE_CMD="supabase"
elif command -v npx &> /dev/null; then
    SUPABASE_CMD="npx supabase"
else
    echo "Error: Supabase CLI not found."
    echo "Install it: https://supabase.com/docs/guides/cli"
    exit 1
fi

# Check if logged in
echo "Checking Supabase login..."
if ! $SUPABASE_CMD projects list &> /dev/null; then
    echo "Please login first: $SUPABASE_CMD login"
    exit 1
fi

# Deploy functions
echo ""
echo "Deploying Edge Functions..."
echo "----------------------------"

echo "  -> bot-webhook..."
$SUPABASE_CMD functions deploy bot-webhook --project-ref "$PROJECT_REF"
echo "  -> cron-handler..."
$SUPABASE_CMD functions deploy cron-handler --project-ref "$PROJECT_REF"
echo "  -> super-api..."
$SUPABASE_CMD functions deploy super-api --project-ref "$PROJECT_REF"

echo ""
echo "========================================="
echo "  Deployment complete!"
echo "========================================="
echo ""
echo "Set these environment variables in Supabase Dashboard:"
echo "  -> Settings -> Edge Functions -> Secrets"
echo ""
echo "Required secrets:"
echo "  TELEGRAM_BOT_TOKEN  = your Telegram bot token"
echo "  SUPABASE_SERVICE_ROLE_KEY = (auto-set)"
echo "  AI_API_KEY          = your OpenRouter API key"
echo "  AI_MODEL            = (optional, default: arcee-ai/trinity-large-preview:free)"
echo "  ALLOWED_USER_IDS    = (optional, comma-separated Telegram user IDs)"
echo "  CRON_SECRET         = (optional, custom secret for cron auth)"
echo ""

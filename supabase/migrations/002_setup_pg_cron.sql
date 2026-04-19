-- ============================================
-- SantuyBot Migration: 002_setup_pg_cron
-- Schedule pg_cron job for cron-handler edge function
-- ============================================

-- pg_cron job: call cron-handler every minute
SELECT cron.schedule(
  'send-telegram-reminders',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/cron-handler',
    headers := jsonb_build_object(
      'Authorization', 'Bearer YOUR_SERVICE_ROLE_KEY_HERE',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

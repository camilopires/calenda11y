-- Schedules calenda11y's tick with pg_cron + pg_net. Run this once per hosted
-- environment (not in migrations, so local development and CI never fire it).
--
-- 1. Store the site URL and cron secret in Supabase Vault (SQL editor):
--      select vault.create_secret('https://calenda11y.org', 'calenda11y_site_url');
--      select vault.create_secret('<the CRON_SECRET value>', 'calenda11y_cron_secret');
-- 2. Run this file.
--
-- Whether the tick actually did its work is recorded in the jobs and
-- job_runs tables (and shown in /admin/jobs), not in pg_net's own log.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('calenda11y-tick') where exists (select 1 from cron.job where jobname = 'calenda11y-tick');

select cron.schedule(
  'calenda11y-tick',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'calenda11y_site_url') || '/api/cron/tick',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'calenda11y_cron_secret'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

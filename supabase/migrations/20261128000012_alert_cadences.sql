-- Alerts: "daily" and "instant" (as they happen) join weekly and monthly.
-- On their own, because a new enum value can't be used in the transaction
-- that adds it.

alter type public.digest_cadence add value if not exists 'daily';
alter type public.digest_cadence add value if not exists 'instant';

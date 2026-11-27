-- A call-for-speakers link is written into calendar feeds as a URL value,
-- which can't be escaped; a line break would start a new property. The
-- forms store links in their standard form, and this keeps anything else
-- (a direct write, an old row) from holding control characters either.

update public.events set cfp_url = pg_catalog.regexp_replace(cfp_url, '[[:cntrl:]]', '', 'g')
where cfp_url ~ '[[:cntrl:]]';

alter table public.events
  add constraint events_cfp_url_plain check (cfp_url is null or cfp_url !~ '[[:cntrl:]]');

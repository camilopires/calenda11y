-- Local development and test data. All events are fictional.
-- Dates are relative to today, so the seed always has upcoming events.

insert into public.events (
  slug, title, summary, description, lang, all_day, starts_at, ends_at, start_date, end_date, timezone,
  format, country_code, city, venue, url, organiser, price,
  captions, sign_language, step_free, quiet_room, hearing_loop, remote_attendance, access_notes, status
)
select
  e.slug, e.title, e.summary, e.description, e.lang, e.all_day,
  case when e.all_day then null else ((current_date + e.day_offset)::timestamp + e.start_time) at time zone e.tz end,
  case when e.all_day then null else ((current_date + e.day_offset)::timestamp + e.start_time + e.duration) at time zone e.tz end,
  case when e.all_day then current_date + e.day_offset end,
  case when e.all_day then current_date + e.day_offset + e.days end,
  e.tz, e.format::public.event_format, e.country, e.city, e.venue, e.url, e.organiser, e.price::public.event_price,
  e.captions, e.sign_language, e.step_free, e.quiet_room, e.hearing_loop, e.remote, e.access_notes,
  e.status::public.event_status
from (values
  ('lisbon-inclusive-design-meetup', 'Lisbon Inclusive Design Meetup', 'An evening of short talks about designing products that work for disabled people.', 'Three short talks, then time to meet other designers and developers. Food and drinks are free.', 'en', false, 3, time '18:30', interval '2 hours', 0, 'Europe/Lisbon', 'in_person', 'PT', 'Lisbon', 'Rua das Flores 12', 'https://example.org/lisbon', 'Inclusive Design Lisboa', 'free', true, false, true, true, false, false, 'Step-free entrance on Rua das Flores. Quiet room on the first floor.', 'approved'),
  ('screen-reader-testing-basics', 'Screen reader testing basics', 'A hands-on online workshop on testing websites with NVDA and VoiceOver.', 'Bring a laptop with NVDA (Windows) or VoiceOver (Mac). We test a demo website together and fix what we find.', 'en', false, 5, time '15:00', interval '90 minutes', 0, 'UTC', 'online', null, null, null, 'https://example.org/sr-basics', 'Open A11y School', 'free', true, true, false, false, false, true, 'Live captions and British Sign Language interpretation.', 'approved'),
  ('berlin-a11y-stammtisch', 'Berlin a11y Stammtisch', 'Ein lockeres Treffen für alle, die sich für digitale Barrierefreiheit interessieren.', 'Wir treffen uns jeden Monat, um über Barrierefreiheit im Web zu sprechen.', 'de', false, 8, time '19:00', interval '3 hours', 0, 'Europe/Berlin', 'in_person', 'DE', 'Berlin', 'Café Kreuzberg', 'https://example.org/berlin', 'a11y Berlin', 'free', false, false, true, false, false, false, null, 'approved'),
  ('accessible-pdfs-clinic', 'Accessible PDFs clinic', 'Bring a PDF and learn how to tag it so screen readers can read it.', 'A practical session for content designers and communications teams.', 'en', false, 10, time '10:00', interval '2 hours', 0, 'Europe/London', 'hybrid', 'GB', 'Manchester', 'Northern Quarter Hub', 'https://example.org/pdfs', 'Content Access Network', 'paid', true, false, true, false, true, true, 'Hearing loop in the main room. Join online if you prefer.', 'approved'),
  ('toronto-a11y-camp', 'Toronto Accessibility Camp', 'A free one-day unconference about accessibility in technology.', 'Anyone can propose a session on the day. Lunch is provided.', 'en', true, 14, null, null, 1, 'America/Toronto', 'in_person', 'CA', 'Toronto', 'Downtown Library', 'https://example.org/toronto', 'A11y Camp Toronto', 'free', true, true, true, true, true, false, 'ASL interpretation in the main room. Quiet room available all day.', 'approved'),
  ('cognitive-accessibility-panel', 'Cognitive accessibility panel', 'Researchers and disabled people talk about making websites easier to understand.', 'A panel discussion with time for questions.', 'en', false, 12, time '17:00', interval '1 hour', 0, 'America/New_York', 'online', null, null, null, 'https://example.org/cognitive', 'Plain Web Collective', 'free', true, true, false, false, false, true, null, 'approved'),
  ('sydney-a11y-meetup', 'Sydney a11y meetup', 'Monthly talks on digital accessibility in Sydney.', 'Two talks and a networking session.', 'en', false, 16, time '18:00', interval '2 hours', 0, 'Australia/Sydney', 'in_person', 'AU', 'Sydney', 'Surry Hills Community Centre', 'https://example.org/sydney', 'A11y Sydney', 'free', true, false, true, false, false, false, null, 'approved'),
  ('tokyo-web-accessibility-night', 'Tokyo Web Accessibility Night', 'ウェブアクセシビリティについて話す夜の勉強会です。', '短いトークと交流会があります。', 'ja', false, 18, time '19:00', interval '2 hours', 0, 'Asia/Tokyo', 'hybrid', 'JP', 'Tokyo', 'Shibuya Studio', 'https://example.org/tokyo', 'A11y Tokyo', 'free', true, false, true, false, false, true, null, 'approved'),
  ('nairobi-inclusive-tech-day', 'Nairobi Inclusive Tech Day', 'A day of talks and workshops on inclusive technology in East Africa.', 'Talks, workshops and an accessibility fair with local organisations.', 'en', true, 21, null, null, 1, 'Africa/Nairobi', 'in_person', 'KE', 'Nairobi', 'iHub', 'https://example.org/nairobi', 'Inclusive Tech Kenya', 'free', true, true, true, true, false, false, 'Kenyan Sign Language interpretation for all talks.', 'approved'),
  ('design-systems-and-a11y', 'Design systems and accessibility', 'How to build accessibility into your design system from the start.', 'A talk followed by a Q&A.', 'en', false, 22, time '16:00', interval '1 hour', 0, 'Europe/Amsterdam', 'online', null, null, null, 'https://example.org/design-systems', 'Component Club', 'free', true, false, false, false, false, true, null, 'approved'),
  ('sao-paulo-acessibilidade-digital', 'Encontro de Acessibilidade Digital', 'Um encontro mensal sobre acessibilidade digital em São Paulo.', 'Palestras curtas e conversa.', 'pt-BR', false, 24, time '19:00', interval '2 hours', 0, 'America/Sao_Paulo', 'in_person', 'BR', 'São Paulo', 'Vila Madalena', 'https://example.org/sp', 'A11y SP', 'free', false, true, true, false, false, false, 'Interpretação em Libras.', 'approved'),
  ('wcag-22-in-practice', 'WCAG 2.2 in practice', 'A full-day training on the new success criteria in WCAG 2.2.', 'For developers and testers who already know WCAG 2.1.', 'en', false, 28, time '09:00', interval '7 hours', 0, 'Europe/Dublin', 'hybrid', 'IE', 'Dublin', 'Grand Canal Quay', 'https://example.org/wcag22', 'Access Training Ireland', 'paid', true, true, true, true, true, true, 'Irish Sign Language interpretation. Step-free venue.', 'approved'),
  ('multi-day-a11y-summit', 'Nordic Accessibility Summit', 'Two days of talks about accessibility in the Nordic countries.', 'Keynotes, workshops and a sponsor area.', 'en', true, 35, null, null, 2, 'Europe/Stockholm', 'hybrid', 'SE', 'Stockholm', 'Waterfront Congress Centre', 'https://example.org/nordic', 'Nordic A11y', 'paid', true, true, true, true, true, true, null, 'approved'),
  ('cancelled-meetup-paris', 'Paris accessibility meetup', 'Une soirée de présentations sur l''accessibilité numérique.', null, 'fr', false, 9, time '19:00', interval '2 hours', 0, 'Europe/Paris', 'in_person', 'FR', 'Paris', 'La Cantine', 'https://example.org/paris', 'A11y Paris', 'free', false, false, true, false, false, false, null, 'cancelled'),
  ('pending-event-not-public', 'Pending event that is not public', 'This event is waiting for review and must never appear on the site.', null, 'en', false, 6, time '12:00', interval '1 hour', 0, 'UTC', 'online', null, null, null, 'https://example.org/pending', 'Someone', 'free', false, false, false, false, false, false, null, 'pending'),
  ('rejected-event-not-public', 'Rejected event that is not public', 'This event was rejected and must never appear on the site.', null, 'en', false, 7, time '12:00', interval '1 hour', 0, 'UTC', 'online', null, null, null, 'https://example.org/rejected', 'Someone', 'free', false, false, false, false, false, false, null, 'rejected'),
  ('past-event-lisbon', 'Last month in Lisbon', 'A meetup that has already happened.', null, 'en', false, -20, time '18:30', interval '2 hours', 0, 'Europe/Lisbon', 'in_person', 'PT', 'Lisbon', 'Rua das Flores 12', 'https://example.org/past', 'Inclusive Design Lisboa', 'free', true, false, true, false, false, false, null, 'approved')
) as e(slug, title, summary, description, lang, all_day, day_offset, start_time, duration, days, tz,
       format, country, city, venue, url, organiser, price, captions, sign_language, step_free, quiet_room,
       hearing_loop, remote, access_notes, status);

-- More online events spread over the coming months, so pagination and the
-- month grid have something to show.
insert into public.events (slug, title, summary, lang, starts_at, ends_at, timezone, format, url, organiser, price, captions, status)
select
  'online-a11y-talk-' || n,
  'Online accessibility talk ' || n,
  'A monthly online talk about a different accessibility topic each time.',
  'en',
  (current_date + (n * 4))::timestamp + time '17:00',
  (current_date + (n * 4))::timestamp + time '18:00',
  'UTC', 'online', 'https://example.org/talk-' || n, 'A11y Talks Online', 'free', true, 'approved'
from generate_series(1, 30) as n;

-- Event types (an event can have several).
update public.events e set types = t.types::public.event_type[]
from (values
  ('lisbon-inclusive-design-meetup', '{meetup,talk}'),
  ('screen-reader-testing-basics', '{workshop}'),
  ('berlin-a11y-stammtisch', '{meetup}'),
  ('accessible-pdfs-clinic', '{workshop}'),
  ('toronto-a11y-camp', '{conference}'),
  ('cognitive-accessibility-panel', '{talk}'),
  ('sydney-a11y-meetup', '{meetup}'),
  ('tokyo-web-accessibility-night', '{meetup}'),
  ('nairobi-inclusive-tech-day', '{conference,workshop}'),
  ('design-systems-and-a11y', '{talk}'),
  ('sao-paulo-acessibilidade-digital', '{meetup}'),
  ('wcag-22-in-practice', '{training}'),
  ('multi-day-a11y-summit', '{conference,workshop}'),
  ('cancelled-meetup-paris', '{meetup}'),
  ('pending-event-not-public', '{other}'),
  ('rejected-event-not-public', '{other}'),
  ('past-event-lisbon', '{meetup}')
) as t(slug, types)
where e.slug = t.slug;

update public.events set types = '{talk}' where slug like 'online-a11y-talk-%';

-- Calls for speakers: one closing soon, one open, one with no date (closes
-- when the event starts) and one already closed.
update public.events set cfp_url = 'https://example.org/nordic/speak', cfp_closes_on = current_date + 5
where slug = 'multi-day-a11y-summit';
update public.events set cfp_url = 'https://example.org/tokyo/speak', cfp_closes_on = current_date + 12
where slug = 'tokyo-web-accessibility-night';
update public.events set cfp_url = 'https://example.org/nairobi/speak'
where slug = 'nairobi-inclusive-tech-day';
update public.events set cfp_url = 'https://example.org/wcag22/speak', cfp_closes_on = current_date - 3
where slug = 'wcag-22-in-practice';

insert into public.events_private (event_id, submitter_email, submitter_name)
select id, 'organiser+' || slug || '@example.org', 'Seed organiser'
from public.events;

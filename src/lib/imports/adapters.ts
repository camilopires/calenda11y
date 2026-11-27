import { eventbriteAdapter } from './eventbrite.ts';
import { icsAdapter } from './ics.ts';
import { lumaAdapter } from './luma.ts';
import { meetupAdapter } from './meetup.ts';
import { rssAdapter } from './rss.ts';
import type { Adapter, SourceType } from './types.ts';

export const ADAPTERS: Record<SourceType, Adapter> = {
  ics: icsAdapter,
  rss: rssAdapter,
  luma: lumaAdapter,
  eventbrite: eventbriteAdapter,
  meetup: meetupAdapter,
};

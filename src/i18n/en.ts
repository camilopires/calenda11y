/**
 * Every piece of interface text. To add a language, copy this file, translate
 * the values, and register it in t.ts. Event content is never translated here;
 * it keeps its own `lang`.
 */
export const en = {
  'site.name': 'calenda11y',
  'site.tagline': 'Accessibility events around the world',
  'site.description':
    'Find accessibility conferences, meetups and workshops around the world. Filter by country, add them to your calendar, or get a weekly email.',
  'skip.main': 'Skip to main content',
  'nav.label': 'Main',
  'nav.events': 'Events',
  'nav.calendar': 'Month view',
  'nav.submit': 'Add an event',
  'nav.subscribe': 'Subscribe',
  'nav.sponsor': 'Sponsor',
  'nav.about': 'About',
  'breadcrumbs.label': 'You are here',
  'breadcrumbs.home': 'Home',
  'footer.about':
    'calenda11y lists accessibility events from around the world. Anyone can add an event, and every event is checked by a person before it appears.',
  'footer.site': 'This site',
  'footer.help': 'Help and policies',
  'footer.accessibility': 'Accessibility statement',
  'footer.privacy': 'Privacy',
  'footer.glossary': 'Glossary',
  'footer.settings': 'Display settings',
  'footer.sponsors': 'Thanks to our sponsors',
  'footer.licence': 'Code under the MIT licence. Event data under CC BY 4.0.',
  'error.summary.title': 'There is a problem',
  'error.title.prefix': 'Error: ',
} as const;

export type MessageKey = keyof typeof en;

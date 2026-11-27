# Manual accessibility checklist

Run before each release. Record the date, who tested, and any problems in the release notes, and update the accessibility statement if anything changes. Automated tests (axe, focus, contrast, reflow, reading level) run in CI on every change. This list covers what they can't.

## Screen readers

Test each of the journeys below with:

- [ ] VoiceOver with Safari on macOS
- [ ] VoiceOver with Safari on iOS
- [ ] NVDA with Firefox or Chrome on Windows

## Journeys

1. [ ] Find an event: filter by country, open an event, read its time and access details, and add it to a calendar.
2. [ ] Use the month view: move between months and open an event from the grid.
3. [ ] Subscribe to a feed: follow the instructions for one calendar app.
4. [ ] Add an event: make a mistake on purpose, fix it from the error summary, change an answer on the check page, and send it.
5. [ ] Sign up for emails, confirm from the email, change your choices, then unsubscribe (from the email link and from the page).
6. [ ] Report a problem with an event.
7. [ ] Sponsor: choose a tier, complete Stripe Checkout in test mode, and add a profile with a logo. Note any barriers in Stripe's own pages for the statement.
8. [ ] Admin: sign in from an email link, publish and reject an event, accept changes from an import, and run an import source.

## For each journey, check

- [ ] Headings and landmarks make sense when listed (rotor, elements list).
- [ ] Every control is announced with its name, role and state.
- [ ] After sending a form, you hear where you are (error summary, confirmation or results).
- [ ] Nothing important is only visual.
- [ ] It works with JavaScript turned off.
- [ ] It works at 400% zoom, with the browser's minimum font size raised, and with Windows contrast themes.
- [ ] It works with voice control (Voice Control on macOS, or Dragon): every control can be named and activated.

## Content

- [ ] New interface text is in plain language, and new jargon or abbreviations are in the glossary.
- [ ] Event summaries being published are in plain language (the admin checklist).

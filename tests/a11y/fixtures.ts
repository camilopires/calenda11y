import AxeBuilder from '@axe-core/playwright';
import { test as base, expect, type Page } from '@playwright/test';
import { HtmlValidate } from 'html-validate';

/** Every WCAG level up to AAA, WCAG 2.1 and 2.2 additions, and axe best practice. */
export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag2aaa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

const htmlValidator = new HtmlValidate({
  extends: ['html-validate:recommended'],
  rules: {
    // Astro's output is minified onto one line and uses its own attribute style.
    'attribute-boolean-style': 'off',
    'attribute-empty-style': 'off',
    'void-style': 'off',
    'no-trailing-whitespace': 'off',
    'doctype-style': 'off',
    // Astro emits <script type="module"> for processed scripts.
    'script-type': 'off',
    // Explicit `type="submit"` is fine but not required.
    'no-implicit-button-type': 'off',
    'no-redundant-role': 'error',
    'form-dup-name': ['error', { shared: ['radio', 'checkbox', 'button', 'reset', 'submit'] }],
  },
});

export async function expectNoAxeViolations(page: Page, label = page.url()): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const summary = results.violations.map(
    (v) => `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.map((n) => n.target.join(' ')).join('\n    ')}`,
  );
  expect(summary, `axe violations on ${label}`).toEqual([]);
}

export async function expectValidHtml(page: Page, path: string): Promise<void> {
  const response = await page.request.get(path);
  const html = await response.text();
  const report = await htmlValidator.validateString(html);
  const messages = report.results.flatMap((r) =>
    r.messages.map((m) => `${m.ruleId}: ${m.message} (${m.selector ?? 'document'})`),
  );
  expect(messages, `HTML validation for ${path}`).toEqual([]);
}

/**
 * A `page` that fails the test if the browser reports a Content Security
 * Policy violation or a JavaScript error.
 */
export const test = base.extend<{ page: Page }>({
  page: async ({ page }, use) => {
    const problems: string[] = [];
    page.on('console', (msg) => {
      const text = msg.text();
      if (msg.type() === 'error' && /Content Security Policy|Refused to/i.test(text)) problems.push(`CSP: ${text}`);
    });
    page.on('pageerror', (err) => problems.push(`JS error: ${err.message}`));
    await use(page);
    expect(problems, 'CSP violations or page errors').toEqual([]);
  },
});

export { expect };

import { describe, expect, it } from 'vitest';
import { EVENT_TOPICS, TOPIC_LABELS, TOPIC_SLUGS, topicFromSlug } from '../../src/lib/events/model.ts';

describe('topics', () => {
  it('every topic has a label and a URL name that maps back to it', () => {
    expect(EVENT_TOPICS).toHaveLength(10);
    for (const t of EVENT_TOPICS) {
      expect(TOPIC_LABELS[t]).toBeTruthy();
      expect(TOPIC_SLUGS[t]).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(topicFromSlug(TOPIC_SLUGS[t])).toBe(t);
    }
  });

  it('accepts the stored spelling too, and nothing else', () => {
    expect(topicFromSlug('assistive-technology')).toBe('assistive_tech');
    expect(topicFromSlug('assistive_tech')).toBe('assistive_tech');
    expect(topicFromSlug('Testing')).toBeNull();
    expect(topicFromSlug('cooking')).toBeNull();
  });
});

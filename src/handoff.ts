export interface Review {
  title: string;
  agent: string;
  text: string;
}

/** Replaces `{name}` placeholders; unknown placeholders stay as they are. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    name in values ? String(values[name]) : placeholder,
  );
}

/** One prompt for the Engineering agent: the intro, then each review in its own tagged block. */
export function buildHandoff(intro: string, reviews: Review[]): string {
  const blocks = reviews.map(
    (review) => `<review from="${review.title}" agent="${review.agent}">\n${review.text.trim()}\n</review>`,
  );
  return [intro.trim(), ...blocks].join('\n\n');
}

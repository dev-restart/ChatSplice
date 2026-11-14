import type { ProjectBrowserExpectation } from '@chatsplice/protocol';
import type { Page } from 'playwright';
import { expect } from 'playwright/test';

/** Bounded, web-first expectations. Never accepts JavaScript or force-clicks. */
export async function assertBrowserState(
  page: Page,
  expectation: ProjectBrowserExpectation,
  timeout: number,
): Promise<void> {
  const options = { timeout };
  if (expectation.kind === 'url') {
    await expect(page).toHaveURL(expectation.url, options);
    return;
  }
  const target = page.locator(expectation.selector);
  if (expectation.kind === 'visible') await expect(target).toBeVisible(options);
  else if (expectation.kind === 'hidden') await expect(target).toBeHidden(options);
  else if (expectation.kind === 'value') {
    await expect(target).toHaveValue(expectation.value, options);
  } else if (expectation.exact === true) {
    await expect(target).toHaveText(expectation.text, options);
  } else {
    await expect(target).toContainText(expectation.text, options);
  }
}

/** Network evidence omits query strings, fragments and embedded credentials. */
export function browserLogUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '[non-http resource]';
    return `${url.origin}${url.pathname}`;
  } catch {
    return '[invalid resource URL]';
  }
}

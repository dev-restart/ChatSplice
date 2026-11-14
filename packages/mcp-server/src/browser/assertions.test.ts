import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';

const matchers = vi.hoisted(() => ({
  toHaveURL: vi.fn(async () => undefined),
  toBeVisible: vi.fn(async () => undefined),
  toBeHidden: vi.fn(async () => undefined),
  toHaveValue: vi.fn(async () => undefined),
  toHaveText: vi.fn(async () => undefined),
  toContainText: vi.fn(async () => undefined),
}));
vi.mock('playwright/test', () => ({ expect: () => matchers }));
import { assertBrowserState, browserLogUrl } from './assertions.js';

// Adapter tests, not a substitute for a real browser journey.
describe('bounded browser assertions', () => {
  const page = { locator: vi.fn(() => ({})) } as unknown as Page;
  it('delegates exact text and substring text to web-first matchers', async () => {
    await assertBrowserState(page, { kind: 'text', selector: '#result', text: 'Saved' }, 1500);
    expect(matchers.toContainText).toHaveBeenLastCalledWith('Saved', { timeout: 1500 });
    await assertBrowserState(
      page,
      { kind: 'text', selector: '#result', text: 'Saved', exact: true },
      2000,
    );
    expect(matchers.toHaveText).toHaveBeenLastCalledWith('Saved', { timeout: 2000 });
  });
  it('delegates state, value and URL conditions with a finite timeout', async () => {
    await assertBrowserState(page, { kind: 'visible', selector: '#result' }, 1000);
    expect(matchers.toBeVisible).toHaveBeenLastCalledWith({ timeout: 1000 });
    await assertBrowserState(page, { kind: 'hidden', selector: '#spinner' }, 1000);
    expect(matchers.toBeHidden).toHaveBeenLastCalledWith({ timeout: 1000 });
    await assertBrowserState(page, { kind: 'value', selector: '#name', value: 'demo' }, 1000);
    expect(matchers.toHaveValue).toHaveBeenLastCalledWith('demo', { timeout: 1000 });
    await assertBrowserState(page, { kind: 'url', url: 'http://localhost:5173/done' }, 1000);
    expect(matchers.toHaveURL).toHaveBeenLastCalledWith('http://localhost:5173/done', {
      timeout: 1000,
    });
  });
  it('propagates assertion failure rather than treating it as success', async () => {
    matchers.toBeVisible.mockRejectedValueOnce(new Error('not visible'));
    await expect(
      assertBrowserState(page, { kind: 'visible', selector: '#missing' }, 1000),
    ).rejects.toThrow('not visible');
  });
  it('excludes credentials, query and fragment from network URLs', () => {
    expect(browserLogUrl('https://user:password@example.com/api/items?token=secret#private')).toBe(
      'https://example.com/api/items',
    );
    expect(browserLogUrl('data:text/plain,secret')).toBe('[non-http resource]');
    expect(browserLogUrl('not a URL')).toBe('[invalid resource URL]');
  });
});

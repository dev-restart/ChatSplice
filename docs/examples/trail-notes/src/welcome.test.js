import { test } from 'node:test';
import assert from 'node:assert/strict';
import { welcomeTitle, trailCategories } from './welcome.js';

test('the home page shows the new heading', () => {
  assert.equal(welcomeTitle(), 'Plan your next hike');
});

test('trail categories stay available', () => {
  assert.equal(trailCategories.length, 3);
});

import { describe, expect, it } from 'vitest';

import { applyProjectOrder, moveProject, parseProjectOrder, stepProject } from './project-order.js';

const projects = ['a', 'b', 'c', 'd'].map((workspace_id) => ({ workspace_id }));
const ids = (items: { workspace_id: string }[]) => items.map((item) => item.workspace_id);

describe('project order', () => {
  it('applies a saved order and keeps unknown projects last in their original order', () => {
    expect(ids(applyProjectOrder(projects, ['c', 'a']))).toEqual(['c', 'a', 'b', 'd']);
    expect(ids(applyProjectOrder(projects, []))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('ignores saved ids of removed projects', () => {
    expect(ids(applyProjectOrder(projects, ['gone', 'd', 'b']))).toEqual(['d', 'b', 'a', 'c']);
  });

  it('moves a project before or after a target', () => {
    const order = ['a', 'b', 'c', 'd'];
    expect(moveProject(order, 'd', 'a', 'before')).toEqual(['d', 'a', 'b', 'c']);
    expect(moveProject(order, 'a', 'c', 'after')).toEqual(['b', 'c', 'a', 'd']);
    expect(moveProject(order, 'b', 'b', 'after')).toEqual(order);
    expect(moveProject(order, 'x', 'a', 'before')).toEqual(order);
  });

  it('steps one position and stops at the ends', () => {
    const order = ['a', 'b', 'c'];
    expect(stepProject(order, 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(stepProject(order, 'b', 1)).toEqual(['a', 'c', 'b']);
    expect(stepProject(order, 'a', -1)).toEqual(order);
    expect(stepProject(order, 'c', 1)).toEqual(order);
  });

  it('parses only a list of unique strings', () => {
    expect(parseProjectOrder('["a","b","a"]')).toEqual(['a', 'b']);
    expect(parseProjectOrder('{"a":1}')).toEqual([]);
    expect(parseProjectOrder('not json')).toEqual([]);
    expect(parseProjectOrder(null)).toEqual([]);
    expect(parseProjectOrder('["a",3,null]')).toEqual(['a']);
  });
});

import { expect, it } from 'vitest';
import { reorderTabs } from '../src/renderer/src/tab-order';

it('moves a dragged tab next to its target and ignores invalid drops', () => {
  const ids = ['a', 'b', 'c', 'd'];
  expect(reorderTabs(ids, 'd', 'a')).toEqual(['d', 'a', 'b', 'c']);
  expect(reorderTabs(ids, 'a', 'd')).toEqual(['b', 'c', 'd', 'a']);
  expect(reorderTabs(ids, 'b', 'c')).toEqual(['a', 'c', 'b', 'd']);
  expect(reorderTabs(ids, 'b', 'b')).toBeUndefined();
  expect(reorderTabs(ids, 'some dropped text', 'b')).toBeUndefined();
  expect(reorderTabs(ids, '', 'b')).toBeUndefined();
  expect(ids).toEqual(['a', 'b', 'c', 'd']);
});

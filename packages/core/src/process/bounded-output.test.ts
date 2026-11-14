import { describe, expect, it } from 'vitest';

import { BoundedOutputCapture } from './bounded-output.js';

describe('BoundedOutputCapture', () => {
  it('retains a UTF-8 character split across stream chunks', () => {
    const output = new BoundedOutputCapture(3);
    output.append(Buffer.from([0xea]));
    output.append(Buffer.from([0xb0, 0x80]));

    expect(output.value).toBe('가');
    expect(output.truncated).toBe(false);
  });

  it('drops an incomplete final character instead of exceeding the byte cap', () => {
    const output = new BoundedOutputCapture(5);
    output.append(Buffer.from('A가나', 'utf8'));

    expect(output.value).toBe('A가');
    expect(Buffer.byteLength(output.value, 'utf8')).toBeLessThanOrEqual(5);
    expect(output.truncated).toBe(true);
  });
});

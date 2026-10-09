import { describe, expect, it } from 'vitest';
import { WORKER_HANDLERS } from '../src/index.js';

describe('worker handlers', () => {
  it('includes the generate consumer and the scheduled functions', () => {
    expect(WORKER_HANDLERS).toEqual(['generate', 'sweeper', 'model_health']);
  });
});

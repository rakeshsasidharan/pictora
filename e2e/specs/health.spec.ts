import { expect, test } from '@playwright/test';

test('/api/health returns ok', async ({ request }) => {
  const response = await request.get('/api/health');

  expect(response.status()).toBe(200);
  const body: unknown = await response.json();
  expect(body).toMatchObject({ status: 'ok', sha: expect.any(String) });
});

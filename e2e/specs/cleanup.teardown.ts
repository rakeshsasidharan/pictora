import { test as teardown } from '@playwright/test';
import { deleteAllImages, isTesterAccount } from '../src/cleanup.js';
import { e2eConfig } from '../src/config.js';

// Runs once after every spec: deletes the images the run made, so the test account's gallery stays empty.
teardown('delete the images the run created', async ({ request }) => {
  if (!(await isTesterAccount(request))) {
    throw new Error(
      'The e2e user is not in the testers group (it was not offered the Mock model), so its gallery was ' +
        'left alone. Use a dedicated test account in the testers group (see e2e/README.md).',
    );
  }
  const deleted = await deleteAllImages(request, e2eConfig().baseUrl);
  console.log(`Deleted ${deleted} images from the test account's gallery.`);
});

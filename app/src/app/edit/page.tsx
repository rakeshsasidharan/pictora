import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { UploadImage } from '../../components/upload_image';
import { requireOnboarding } from '../../lib/onboarding';
import { sessionFromHeaders } from '../../lib/session';

export const metadata: Metadata = { title: 'Edit · Pictora' };
export const dynamic = 'force-dynamic';

/** Where an edit starts (EDIT-2): upload a photo or image of your own to change in words. */
export default async function EditPage() {
  const session = sessionFromHeaders(await headers());
  // The proxy sends signed-out visitors to sign in before they get here.
  if (!session) redirect('/');
  await requireOnboarding(session);
  return (
    <div className="edit-start">
      <h1>Edit an image</h1>
      <p>Upload a photo or image, then describe the change you want.</p>
      <UploadImage />
    </div>
  );
}

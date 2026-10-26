import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { Gallery } from '../../../components/gallery';
import { modelNames } from '../../../lib/gallery_models';
import { requireOnboarding } from '../../../lib/onboarding';
import { sessionFromHeaders } from '../../../lib/session';

export const metadata: Metadata = { title: 'Gallery · Pictora' };
export const dynamic = 'force-dynamic';

/** The private gallery (GAL-1): the grid loads its pages from `GET /api/images` in the browser. */
export default async function GalleryPage() {
  const session = sessionFromHeaders(await headers());
  // The proxy sends signed-out visitors to sign in before they get here.
  if (!session) redirect('/');
  await requireOnboarding(session);

  return (
    <div data-slot="gallery-page" className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Your images</h1>
      <Gallery modelNames={await modelNames()} />
    </div>
  );
}

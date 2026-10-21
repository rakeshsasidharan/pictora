import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { ImageDetailPage } from '../../../components/image_detail_page';
import { modelNames } from '../../../lib/gallery_models';
import { getImageDetail, type ImageDetailBody } from '../../../lib/images';
import { imagesDeps } from '../../../lib/images_deps';
import { requireOnboarding } from '../../../lib/onboarding';
import { sessionFromHeaders } from '../../../lib/session';

export const metadata: Metadata = { title: 'Image · Pictora' };
export const dynamic = 'force-dynamic';

/**
 * The detail view of one gallery image as a page (GAL-2): where narrow screens and direct links open it. Another
 * user's image, or one that doesn't exist, is a 404.
 */
export default async function GalleryImagePage({
  params,
}: {
  params: Promise<{ imageId: string }>;
}) {
  const session = sessionFromHeaders(await headers());
  // The proxy sends signed-out visitors to sign in before they get here.
  if (!session) redirect('/');
  await requireOnboarding(session);

  const { imageId } = await params;
  const detail = await getImageDetail(imagesDeps(), session, imageId);
  if (detail.status !== 200) notFound();

  return (
    <main className="gallery">
      <ImageDetailPage
        detail={detail.body as unknown as ImageDetailBody}
        modelNames={await modelNames()}
      />
    </main>
  );
}

import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { Gallery } from '../../../components/gallery';
import { filterFromParams, galleryUrl } from '../../../lib/gallery_filter';
import { modelNames } from '../../../lib/gallery_models';
import { jobsDeps } from '../../../lib/jobs_deps';
import { requireOnboarding } from '../../../lib/onboarding';
import { sessionFromHeaders } from '../../../lib/session';
import { toolCatalog } from '../../../lib/tool_catalog';

export const metadata: Metadata = { title: 'Gallery · Pictora' };
export const dynamic = 'force-dynamic';

/**
 * The private gallery (GAL-1): the grid loads its pages from `GET /api/images` in the browser, searched and
 * filtered as the address says (`?q=&tag=&collection=`, tech design 4.2).
 */
export default async function GalleryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = sessionFromHeaders(await headers());
  // The proxy sends signed-out visitors to sign in before they get here.
  if (!session) redirect('/');
  await requireOnboarding(session);

  const [names, tools, params] = await Promise.all([
    modelNames(),
    toolCatalog(jobsDeps(), session),
    searchParams,
  ]);
  const filter = filterFromParams(params);
  return (
    <div data-slot="gallery-page" className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Your images</h1>
      {/* A link to another filter, such as a tag in the detail view, starts the grid afresh. */}
      <Gallery key={galleryUrl(filter)} modelNames={names} tools={tools} initialFilter={filter} />
    </div>
  );
}

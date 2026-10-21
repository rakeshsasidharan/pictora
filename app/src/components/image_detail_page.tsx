'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ImageDetailBody } from '../lib/images';
import { GALLERY_PATH } from '../lib/site';
import { ImageDetail } from './image_detail';

/** The detail view as its own page (GAL-2), which goes back to the gallery once the image is deleted. */
export function ImageDetailPage({
  detail,
  modelNames,
}: {
  detail: ImageDetailBody;
  modelNames: Readonly<Record<string, string>>;
}) {
  const router = useRouter();
  return (
    <>
      <Link href={GALLERY_PATH}>Back to your images</Link>
      <ImageDetail
        imageId={detail.image.imageId}
        initial={detail}
        modelNames={modelNames}
        headingLevel={1}
        onDeleted={() => router.push(GALLERY_PATH)}
      />
    </>
  );
}

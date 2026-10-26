'use client';

import { ArrowLeftIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
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
    <div data-slot="image-detail-page" className="flex flex-col gap-4">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href={GALLERY_PATH}>
          <ArrowLeftIcon aria-hidden="true" />
          Back to your images
        </Link>
      </Button>
      <ImageDetail
        imageId={detail.image.imageId}
        initial={detail}
        modelNames={modelNames}
        headingLevel={1}
        onDeleted={() => router.push(GALLERY_PATH)}
      />
    </div>
  );
}

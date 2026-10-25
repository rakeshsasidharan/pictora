import Image from 'next/image';
import { cn } from '@/lib/utils';
import { APP_ICON_PATH } from '../lib/site';

/** The Pictora app icon (#117), decorative: the name beside it labels the link. */
export function PictoraIcon({ className }: { className: string }) {
  return (
    <Image
      src={APP_ICON_PATH}
      alt=""
      width={32}
      height={32}
      className={cn('shrink-0 rounded-md', className)}
      unoptimized
    />
  );
}

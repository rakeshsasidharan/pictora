import type { MetadataRoute } from 'next';
import { APP_ICON_PATH, SITE_DESCRIPTION } from '../lib/site';

/** The navy behind the icon's artwork, so the splash screen and title bar match the icon. */
export const BRAND_BACKGROUND = '#0f193b';

/**
 * The web app manifest, served at `/manifest.webmanifest` and linked from every page. The icons are made by
 * `app/scripts/generate_icons.mjs` (#117); the maskable one keeps the "P" inside Android's safe zone.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Pictora',
    short_name: 'Pictora',
    description: SITE_DESCRIPTION,
    start_url: '/',
    display: 'standalone',
    background_color: BRAND_BACKGROUND,
    theme_color: BRAND_BACKGROUND,
    icons: [
      { src: APP_ICON_PATH, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon_512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: '/icons/icon_maskable_512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}

'use client';

import { useEffect } from 'react';
import { markLanding } from '../lib/first_image';

/** Notes when this tab first loaded a page, for the time-to-first-image metric. Renders nothing. */
export function LandingMarker() {
  useEffect(() => markLanding(), []);
  return null;
}

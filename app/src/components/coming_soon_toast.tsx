'use client';

import { useEffect } from 'react';
import { issueUrl, type ComingSoonFeature } from '../lib/coming_soon';

/** How long the toast stays up. */
export const TOAST_MS = 5_000;

/** A toast saying "<Feature> coming soon", linked to the issue that builds it. */
export function ComingSoonToast({
  feature,
  onClose,
}: {
  feature: ComingSoonFeature;
  onClose: () => void;
}) {
  useEffect(() => {
    const timer = setTimeout(onClose, TOAST_MS);
    return () => clearTimeout(timer);
  }, [feature, onClose]);

  return (
    <div className="toast" role="status">
      <span>{feature.name} coming soon.</span>{' '}
      <a href={issueUrl(feature.issue)} target="_blank" rel="noopener">
        Follow issue #{feature.issue}
      </a>
      <button type="button" className="toast-close" aria-label="Dismiss" onClick={onClose}>
        ×
      </button>
    </div>
  );
}

/**
 * Where people reach us about the service, privacy requests and content reports. Shown in the footer and
 * substituted for `{{CONTACT_EMAIL}}` in the legal pages. It has to be a working mailbox before launch.
 */
export const CONTACT_EMAIL = 'contact@rpillai.dev';

/** The generate screen: where signed-in users land, and where sign-in from the landing page returns to. */
export const GENERATE_PATH = '/generate';

/** Where new users confirm their age and accept the terms before their first image (AUTH-4). */
export const ONBOARDING_PATH = '/onboarding';

/** Account settings: profile details, today's points and account deletion (AUTH-3). */
export const ACCOUNT_PATH = '/account';

/** Where an edit starts: uploading an image of your own (EDIT-2). */
export const EDIT_PATH = '/edit';

/** The edit panel for one of the user's images (EDIT-1), optionally starting from one of its versions. */
export function editImagePath(imageId: string, version?: number): string {
  const path = `${EDIT_PATH}/${encodeURIComponent(imageId)}`;
  return version === undefined ? path : `${path}?version=${version}`;
}

/** The private gallery of the user's images (GAL-1). */
export const GALLERY_PATH = '/gallery';

/** One image's detail view in the gallery (GAL-2); on wide screens the grid opens it as a modal instead. */
export function galleryImagePath(imageId: string): string {
  return `${GALLERY_PATH}/${encodeURIComponent(imageId)}`;
}

/** The generate screen filled in with a gallery image's settings and seed (GAL-3). */
export function rerunPath(imageId: string): string {
  return `${GENERATE_PATH}?rerun=${encodeURIComponent(imageId)}`;
}

/** Saves a version's original PNG through the app, so the link outlives any presigned URL (GAL-3). */
export function downloadPath(imageId: string, version: number): string {
  return `/api/images/${encodeURIComponent(imageId)}/versions/${version}/download`;
}

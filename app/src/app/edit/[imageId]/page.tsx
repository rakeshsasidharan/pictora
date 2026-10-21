import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { EditPanel } from '../../../components/edit_panel';
import { documentClient, tableName } from '../../../lib/dynamodb';
import { getImageDetail, type ImageDetailBody } from '../../../lib/images';
import { getMe, type MeBody } from '../../../lib/jobs';
import { jobsDeps } from '../../../lib/jobs_deps';
import { modelsResponse } from '../../../lib/models_response';
import { requireOnboarding } from '../../../lib/onboarding';
import { readPremiumPause } from '../../../lib/platform_spend';
import { registryLoader } from '../../../lib/registry';
import { sessionFromHeaders } from '../../../lib/session';

export const metadata: Metadata = { title: 'Edit · Pictora' };
export const dynamic = 'force-dynamic';

/**
 * The edit panel for one of the user's images (EDIT-1): its versions, the enabled models with a queue that can
 * edit, today's points, and any premium pause. `?version=<n>` selects the version to start from. Another user's
 * image, or one that doesn't exist, is a 404.
 */
export default async function EditImagePage({
  params,
  searchParams,
}: {
  params: Promise<{ imageId: string }>;
  searchParams: Promise<{ version?: string | string[] }>;
}) {
  const session = sessionFromHeaders(await headers());
  // The proxy sends signed-out visitors to sign in before they get here.
  if (!session) redirect('/');
  await requireOnboarding(session);

  const { imageId } = await params;
  const { version } = await searchParams;
  const deps = jobsDeps();
  const detail = await getImageDetail(deps, session, imageId);
  if (detail.status !== 200) notFound();

  const [enabled, me, pause] = await Promise.all([
    registryLoader().enabledModels(),
    getMe(deps, session).then((result) => result.body as unknown as MeBody),
    readPremiumPause(documentClient(), tableName(), deps.spendCapCents, new Date()),
  ]);
  const { models, premiumPausedUntil } = modelsResponse(
    enabled.filter((model) => model.capabilities.edit && deps.hasQueue(model.provider)),
    pause,
  );
  const requested = Number(Array.isArray(version) ? version[0] : version);
  return (
    <EditPanel
      detail={detail.body as unknown as ImageDetailBody}
      ownerSub={session.sub}
      models={models}
      points={{ left: me.pointsLeft, limit: me.dailyLimit }}
      initialVersion={Number.isInteger(requested) && requested > 0 ? requested : undefined}
      premiumPausedUntil={premiumPausedUntil}
    />
  );
}

import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { GenerateScreen } from '../../../components/generate_screen';
import { documentClient, tableName } from '../../../lib/dynamodb';
import { generateCatalog } from '../../../lib/generate_catalog';
import { readGenerateDefaults } from '../../../lib/generate_defaults';
import { rerunSettings } from '../../../lib/images';
import { getMe, type MeBody } from '../../../lib/jobs';
import { jobsDeps } from '../../../lib/jobs_deps';
import { requireOnboarding } from '../../../lib/onboarding';
import { sessionFromHeaders } from '../../../lib/session';

export const metadata: Metadata = { title: 'Create · Pictora' };
export const dynamic = 'force-dynamic';

/**
 * The generate screen (GEN-1 to GEN-11): the enabled models with a queue, the style presets, today's points, any
 * premium pause from the platform spend cap, and the user's defaults, which a new form starts from.
 * `?rerun=<imageId>` fills it with one of the user's generated images' settings and seed (GAL-3); an image the
 * user doesn't have is ignored.
 */
export default async function GeneratePage({
  searchParams,
}: {
  searchParams: Promise<{ rerun?: string | string[] }>;
}) {
  const session = sessionFromHeaders(await headers());
  // The proxy sends signed-out visitors to sign in before they get here.
  if (!session) redirect('/');
  await requireOnboarding(session);

  const { rerun } = await searchParams;
  const rerunId = Array.isArray(rerun) ? rerun[0] : rerun;
  const deps = jobsDeps();
  const [{ models, styles, premiumPausedUntil }, me, defaults, settings] = await Promise.all([
    generateCatalog(deps, session),
    getMe(deps, session).then((result) => result.body as unknown as MeBody),
    readGenerateDefaults(documentClient(), tableName(), session.sub),
    rerunId ? rerunSettings(deps, session, rerunId) : Promise.resolve(undefined),
  ]);
  return (
    <GenerateScreen
      // Moving between a rerun and an empty `/generate` only changes the search, which keeps the page mounted;
      // a new key starts the form afresh with the new settings.
      key={rerunId ?? ''}
      models={models}
      styles={styles}
      points={{ left: me.pointsLeft, limit: me.dailyLimit }}
      premiumPausedUntil={premiumPausedUntil}
      rerun={settings}
      defaults={defaults}
    />
  );
}

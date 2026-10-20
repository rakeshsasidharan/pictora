import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { GenerateScreen } from '../../components/generate_screen';
import { documentClient, tableName } from '../../lib/dynamodb';
import { getMe, type MeBody } from '../../lib/jobs';
import { jobsDeps } from '../../lib/jobs_deps';
import { modelsResponse } from '../../lib/models_response';
import { requireOnboarding } from '../../lib/onboarding';
import { readPremiumPause } from '../../lib/platform_spend';
import { registryLoader } from '../../lib/registry';
import { sessionFromHeaders } from '../../lib/session';

export const metadata: Metadata = { title: 'Create · Pictora' };
export const dynamic = 'force-dynamic';

/**
 * The generate screen (GEN-1 to GEN-10): the enabled models with a queue, the style presets, today's points, and
 * any premium pause from the platform spend cap.
 */
export default async function GeneratePage() {
  const session = sessionFromHeaders(await headers());
  // The proxy sends signed-out visitors to sign in before they get here.
  if (!session) redirect('/');
  await requireOnboarding(session);

  const deps = jobsDeps();
  const [enabled, me, pause] = await Promise.all([
    registryLoader().enabledModels(),
    getMe(deps, session).then((result) => result.body as unknown as MeBody),
    readPremiumPause(documentClient(), tableName(), deps.spendCapCents, new Date()),
  ]);
  // Models without a queue in this environment would only be refused by POST /api/jobs.
  const { models, styles, premiumPausedUntil } = modelsResponse(
    enabled.filter((model) => deps.hasQueue(model.provider)),
    pause,
  );
  return (
    <GenerateScreen
      models={models}
      styles={styles}
      points={{ left: me.pointsLeft, limit: me.dailyLimit }}
      premiumPausedUntil={premiumPausedUntil}
    />
  );
}

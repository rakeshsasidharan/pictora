import { AdminUser } from '../../../../components/admin_user';

/** One user's profile, with Suspend and Unsuspend (ADM-4). */
export default async function AdminUserPage({ params }: { params: Promise<{ sub: string }> }) {
  const { sub } = await params;
  return <AdminUser sub={sub} />;
}

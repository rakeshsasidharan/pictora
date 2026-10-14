import { headers } from 'next/headers';
import { SignInButtons } from '../components/sign_in_buttons';
import { sessionFromHeaders } from '../lib/session';

export default async function HomePage() {
  const session = sessionFromHeaders(await headers());
  return (
    <main>
      <h1>Pictora</h1>
      <p>Turn text prompts into images.</p>
      {session ? <p>You are signed in as {session.email}.</p> : <SignInButtons />}
    </main>
  );
}

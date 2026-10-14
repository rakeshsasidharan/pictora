/** The signed-in user, from verified Cognito tokens. */
export interface Session {
  sub: string;
  email: string;
  groups: string[];
}

/**
 * Request headers the proxy sets from verified tokens, for route handlers and server components. The proxy
 * deletes any the browser sent, so they can be trusted.
 */
export const SESSION_HEADERS = {
  sub: 'x-pictora-user-sub',
  email: 'x-pictora-user-email',
  groups: 'x-pictora-user-groups',
} as const;

export function setSessionHeaders(headers: Headers, session: Session): void {
  headers.set(SESSION_HEADERS.sub, session.sub);
  headers.set(SESSION_HEADERS.email, session.email);
  headers.set(SESSION_HEADERS.groups, session.groups.join(','));
}

export function deleteSessionHeaders(headers: Headers): void {
  for (const name of Object.values(SESSION_HEADERS)) headers.delete(name);
}

/** The session the proxy attached to this request, or undefined when nobody is signed in. */
export function sessionFromHeaders(headers: Pick<Headers, 'get'>): Session | undefined {
  const sub = headers.get(SESSION_HEADERS.sub);
  if (!sub) return undefined;
  const groups = headers.get(SESSION_HEADERS.groups);
  return {
    sub,
    email: headers.get(SESSION_HEADERS.email) ?? '',
    groups: groups ? groups.split(',') : [],
  };
}

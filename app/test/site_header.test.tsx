import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SiteHeader } from '../src/components/site_header';

describe('SiteHeader', () => {
  it('offers sign-in to visitors', () => {
    const html = renderToStaticMarkup(<SiteHeader />);
    expect(html).toContain('href="/auth/login"');
    expect(html).not.toContain('Sign out');
    expect(html).not.toContain('href="/gallery"');
  });

  it('shows the signed-in email and a sign-out form that posts to /auth/logout', () => {
    const html = renderToStaticMarkup(
      <SiteHeader session={{ sub: 's', email: 'user@example.com', groups: [] }} />,
    );
    expect(html).toContain('user@example.com');
    expect(html).toContain('href="/generate"');
    expect(html).toContain('href="/gallery"');
    expect(html).toContain('<form action="/auth/logout" method="post">');
    expect(html).toContain('Sign out');
    expect(html).not.toContain('href="/auth/login"');
    expect(html).not.toContain('href="/admin"');
  });

  it('links admins to the admin area', () => {
    const html = renderToStaticMarkup(
      <SiteHeader session={{ sub: 's', email: 'admin@example.com', groups: ['admins'] }} />,
    );
    expect(html).toContain('href="/admin"');
  });

  it('offers the theme switcher to everyone', () => {
    for (const session of [undefined, { sub: 's', email: 'user@example.com', groups: [] }]) {
      expect(renderToStaticMarkup(<SiteHeader session={session} />)).toContain(
        'aria-label="Theme"',
      );
    }
  });

  it('shows the Pictora icon and name inside the home link', () => {
    const html = renderToStaticMarkup(<SiteHeader />);
    const homeLink = html.match(/<a[^>]*href="\/"[^>]*>(.*?)<\/a>/)?.[1];
    expect(homeLink).toMatch(/^<img [^>]*alt=""[^>]*src="\/icons\/icon_192\.png"[^>]*\/>Pictora$/);
  });
});

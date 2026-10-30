// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LegalLinks } from '../src/components/legal_links';
import { SiteFooter } from '../src/components/site_footer';
import { CONTACT_EMAIL } from '../src/lib/site';

describe('SiteFooter', () => {
  afterEach(cleanup);

  it('links to the three legal pages', () => {
    render(<SiteFooter />);
    const nav = screen.getByRole('navigation', { name: 'Legal' });
    const links = within(nav)
      .getAllByRole('link')
      .map((link) => [link.textContent, link.getAttribute('href')]);
    expect(links).toEqual([
      ['Terms of service', '/terms'],
      ['Content policy', '/content-policy'],
      ['Privacy policy', '/privacy'],
    ]);
  });

  it('styles its links with the theme colours', () => {
    render(<SiteFooter />);
    expect(screen.getByRole('contentinfo').getAttribute('data-slot')).toBe('site-footer');
    for (const link of screen.getAllByRole('link')) expect(link.className).toContain('text-');
  });

  it('shows the contact email', () => {
    render(<SiteFooter />);
    expect(screen.getByRole('link', { name: CONTACT_EMAIL }).getAttribute('href')).toBe(
      `mailto:${CONTACT_EMAIL}`,
    );
  });
});

describe('LegalLinks', () => {
  afterEach(cleanup);

  it('can be reused with its own class, for the onboarding page', () => {
    const { container } = render(<LegalLinks className="justify-start" />);
    expect(container.querySelector('ul.justify-start')).not.toBeNull();
    expect(screen.getAllByRole('link')).toHaveLength(3);
  });
});

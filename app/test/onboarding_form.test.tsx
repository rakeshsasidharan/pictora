// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OnboardingForm } from '../src/components/onboarding_form';

const DOCUMENTS = [
  { title: 'Terms of service', path: '/terms' },
  { title: 'Content policy', path: '/content-policy' },
];

function renderForm(onDone = vi.fn()) {
  render(<OnboardingForm tosVersion="2026-10-14" documents={DOCUMENTS} onDone={onDone} />);
  return {
    onDone,
    age: screen.getByRole('checkbox', { name: /13 years old or older/ }),
    terms: screen.getByRole('checkbox', { name: /I accept the/ }),
    submit: screen.getByRole('button', { name: 'Continue' }),
  };
}

describe('OnboardingForm', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('links the terms and the content policy with the version', () => {
    renderForm();
    expect(screen.getByRole('link', { name: 'terms of service' }).getAttribute('href')).toBe(
      '/terms',
    );
    expect(screen.getByRole('link', { name: 'content policy' }).getAttribute('href')).toBe(
      '/content-policy',
    );
    expect(screen.getByText(/version 2026-10-14/)).toBeTruthy();
  });

  it('asks for both confirmations before submitting', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { age, terms, submit } = renderForm();

    fireEvent.click(submit);
    expect(screen.getByRole('alert').textContent).toMatch(/13 or older and accept the terms/);

    fireEvent.click(age);
    fireEvent.click(submit);
    expect(screen.getByRole('alert').textContent).toMatch(/Accept the terms of service/);

    fireEvent.click(age);
    fireEvent.click(terms);
    fireEvent.click(submit);
    expect(screen.getByRole('alert').textContent).toMatch(/Confirm that you are 13 or older to/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts both confirmations and the version, then moves on', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { age, terms, submit, onDone } = renderForm();
    fireEvent.click(age);
    fireEvent.click(terms);
    fireEvent.click(submit);

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith('/api/me/onboarding', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ageConfirmed: true, termsAccepted: true, tosVersion: '2026-10-14' }),
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the error the API answers with', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: 'The terms have changed.', code: 'terms_changed' }),
            {
              status: 409,
            },
          ),
      ),
    );
    const { age, terms, submit, onDone } = renderForm();
    fireEvent.click(age);
    fireEvent.click(terms);
    fireEvent.click(submit);
    expect((await screen.findByRole('alert')).textContent).toBe('The terms have changed.');
    expect(onDone).not.toHaveBeenCalled();
  });
});

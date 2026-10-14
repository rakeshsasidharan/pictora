import type { Metadata } from 'next';
import { LegalDocument } from '../../components/legal_document';

export const metadata: Metadata = { title: 'Terms of service · Pictora' };

export default function TermsPage() {
  return <LegalDocument slug="terms" />;
}

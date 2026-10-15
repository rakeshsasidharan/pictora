import type { Metadata } from 'next';
import { LegalDocument } from '../../components/legal_document';

export const metadata: Metadata = { title: 'Privacy policy · Pictora' };

export default function PrivacyPage() {
  return <LegalDocument slug="privacy" />;
}

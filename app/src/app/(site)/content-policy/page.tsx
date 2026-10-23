import type { Metadata } from 'next';
import { LegalDocument } from '../../../components/legal_document';

export const metadata: Metadata = { title: 'Content policy · Pictora' };

export default function ContentPolicyPage() {
  return <LegalDocument slug="content-policy" />;
}

import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { contextWithoutDomain, testStage } from './helpers.js';

describe('Certificate stack', () => {
  const stage = testStage('PictoraDev', { hostedZoneId: 'ZREALZONE' });
  const stack = stage.certificate;

  it('lives in us-east-1, where CloudFront reads certificates', () => {
    expect(stack?.region).toBe('us-east-1');
  });

  it('requests a DNS-validated certificate for the dev domain in the rpillai.dev zone', () => {
    if (!stack) throw new Error('dev has no certificate stack');
    Template.fromStack(stack).hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'dev.pictora.rpillai.dev',
      ValidationMethod: 'DNS',
      DomainValidationOptions: [
        { DomainName: 'dev.pictora.rpillai.dev', HostedZoneId: 'ZREALZONE' },
      ],
    });
  });

  it('requests the prod certificate for pictora.rpillai.dev (#33)', () => {
    const prod = testStage('PictoraProd', { hostedZoneId: 'ZREALZONE' }).certificate;
    if (!prod) throw new Error('prod has no certificate stack');
    expect(prod.region).toBe('us-east-1');
    Template.fromStack(prod).hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'pictora.rpillai.dev',
      DomainValidationOptions: [{ DomainName: 'pictora.rpillai.dev', HostedZoneId: 'ZREALZONE' }],
    });
  });

  it('is not created for an environment without a domain', () => {
    expect(testStage('PictoraProd', contextWithoutDomain('prod')).certificate).toBeUndefined();
  });
});

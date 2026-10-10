import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { testStage } from './helpers.js';

describe('Certificate stack', () => {
  const stage = testStage('PictoraDev', { hostedZoneId: 'ZREALZONE' });
  const stack = stage.certificate;

  it('lives in us-east-1, where CloudFront reads certificates', () => {
    expect(stack?.region).toBe('us-east-1');
  });

  it('requests a DNS-validated certificate for the dev domain in the rpillai.dev zone', () => {
    if (!stack) throw new Error('dev has no certificate stack');
    Template.fromStack(stack).hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'pictora.rpillai.dev',
      ValidationMethod: 'DNS',
      DomainValidationOptions: [{ DomainName: 'pictora.rpillai.dev', HostedZoneId: 'ZREALZONE' }],
    });
  });

  it('is not created for an environment without a domain', () => {
    expect(testStage('PictoraProd').certificate).toBeUndefined();
  });
});

import { Match, Template } from 'aws-cdk-lib/assertions';
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

  it.each([
    ['PictoraDev', 'dev'],
    ['PictoraProd', 'prod'],
  ] as const)(
    'retains the %s certificate on replacement and tags it Project=pictora, Stage=%s (#180)',
    (stageName, envName) => {
      const certificate = testStage(stageName, { hostedZoneId: 'ZREALZONE' }).certificate;
      if (!certificate) throw new Error(`${stageName} has no certificate stack`);
      const template = Template.fromStack(certificate);
      template.resourceCountIs('AWS::CertificateManager::Certificate', 1);
      template.hasResource('AWS::CertificateManager::Certificate', {
        DeletionPolicy: 'Retain',
        UpdateReplacePolicy: 'Retain',
        Properties: {
          Tags: Match.arrayWith([
            { Key: 'Project', Value: 'pictora' },
            { Key: 'Stage', Value: envName },
          ]),
        },
      });
    },
  );

  it('outputs the certificate ARN for the post-deploy cleanup', () => {
    if (!stack) throw new Error('dev has no certificate stack');
    const outputs = Template.fromStack(stack).findOutputs('CertificateArn');
    const certificateId = Object.keys(
      Template.fromStack(stack).findResources('AWS::CertificateManager::Certificate'),
    )[0];
    expect(outputs.CertificateArn?.Value).toEqual({ Ref: certificateId });
  });

  it('is not created for an environment without a domain', () => {
    expect(testStage('PictoraProd', contextWithoutDomain('prod')).certificate).toBeUndefined();
  });
});

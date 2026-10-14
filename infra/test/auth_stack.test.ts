import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { testStage } from './helpers.js';

const dev = Template.fromStack(testStage('PictoraDev').auth);
const prod = Template.fromStack(testStage('PictoraProd').auth);

function userPool(template: Template) {
  const [pool] = Object.values(template.findResources('AWS::Cognito::UserPool'));
  return pool;
}

describe('Auth stack: user pool', () => {
  it('uses email as the username, with verification and self sign-up', () => {
    const props = userPool(dev)?.Properties;
    expect(props).toMatchObject({
      UserPoolName: 'pictora-dev',
      UsernameAttributes: ['email'],
      AutoVerifiedAttributes: ['email'],
      UsernameConfiguration: { CaseSensitive: false },
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
      UserAttributeUpdateSettings: { AttributesRequireVerificationBeforeUpdate: ['email'] },
      AccountRecoverySetting: { RecoveryMechanisms: [{ Name: 'verified_email', Priority: 1 }] },
    });
    expect(props.Schema).toEqual([{ Name: 'email', Required: true, Mutable: true }]);
  });

  it('protects and keeps the prod pool, and lets dev be destroyed', () => {
    expect(userPool(prod)).toMatchObject({
      DeletionPolicy: 'Retain',
      Properties: { DeletionProtection: 'ACTIVE' },
    });
    expect(userPool(dev)).toMatchObject({
      DeletionPolicy: 'Delete',
      Properties: { DeletionProtection: 'INACTIVE' },
    });
  });

  it('has a managed login domain per environment', () => {
    dev.hasResourceProperties('AWS::Cognito::UserPoolDomain', { Domain: 'pictora-rpillai-dev' });
    prod.hasResourceProperties('AWS::Cognito::UserPoolDomain', { Domain: 'pictora-rpillai-prod' });
  });

  it('has the admins group', () => {
    dev.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: 'admins' });
  });
});

describe('Auth stack: Google provider', () => {
  it('reads the OAuth client from the hand-made secret and maps the email', () => {
    const [google] = Object.values(dev.findResources('AWS::Cognito::UserPoolIdentityProvider'));
    expect(google?.Properties).toMatchObject({
      ProviderName: 'Google',
      ProviderType: 'Google',
      AttributeMapping: { email: 'email', email_verified: 'email_verified' },
      ProviderDetails: { authorize_scopes: 'openid email profile' },
    });
    const details = JSON.stringify(google?.Properties.ProviderDetails);
    expect(details).toContain(':secret:pictora/dev/google-oauth:SecretString:clientId::}}');
    expect(details).toContain(':secret:pictora/dev/google-oauth:SecretString:clientSecret::}}');
  });

  it('uses the secret of its own environment', () => {
    const [google] = Object.values(prod.findResources('AWS::Cognito::UserPoolIdentityProvider'));
    expect(JSON.stringify(google?.Properties.ProviderDetails)).toContain(
      'pictora/prod/google-oauth',
    );
  });
});

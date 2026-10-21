import { Match, Template } from 'aws-cdk-lib/assertions';
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

describe('Auth stack: pre-sign-up trigger', () => {
  function preSignUpFunction(template: Template) {
    const functions = template.findResources('AWS::Lambda::Function', {
      Properties: { Environment: { Variables: { TABLE_NAME: Match.anyValue() } } },
    });
    const ids = Object.keys(functions);
    expect(ids).toHaveLength(1);
    return { id: ids[0] as string, props: Object.values(functions)[0]?.Properties };
  }

  it('attaches the abuse check to the user pool as its pre-sign-up trigger', () => {
    const { id } = preSignUpFunction(dev);
    expect(userPool(dev)?.Properties.LambdaConfig).toEqual({
      PreSignUp: { 'Fn::GetAtt': [id, 'Arn'] },
    });
    dev.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction',
      Principal: 'cognito-idp.amazonaws.com',
      FunctionName: { 'Fn::GetAtt': [id, 'Arn'] },
    });
  });

  it('runs on arm64 Node.js 22 within Cognito’s 5 s, with the table name', () => {
    const { props } = preSignUpFunction(prod);
    expect(props).toMatchObject({
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      Timeout: 4,
      Environment: { Variables: { TABLE_NAME: expect.anything() } },
    });
  });

  it('may only put and update items in the table', () => {
    dev.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          {
            Action: ['dynamodb:PutItem', 'dynamodb:UpdateItem'],
            Effect: 'Allow',
            Resource: Match.anyValue(),
          },
        ],
      },
    });
  });

  it('keeps its logs 30 days in dev and 90 in prod', () => {
    dev.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
    prod.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 90 });
  });
});

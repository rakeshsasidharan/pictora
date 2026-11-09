import { CfnOutput, RemovalPolicy, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import {
  Certificate,
  CertificateValidation,
  type ICertificate,
} from 'aws-cdk-lib/aws-certificatemanager';
import { HostedZone } from 'aws-cdk-lib/aws-route53';
import type { Construct } from 'constructs';
import { HOSTED_ZONE_NAME, type EnvName } from './stage_config.js';

/** CloudFront only accepts certificates from this region. */
export const CERTIFICATE_REGION = 'us-east-1';

/**
 * Tags on every Pictora certificate. The deploy role may delete only certificates tagged `Project=pictora`,
 * and the post-deploy cleanup (`.github/scripts/prune_certificates.sh`) matches both tags (tech design 14).
 */
export const CERTIFICATE_PROJECT_TAG = { key: 'Project', value: 'pictora' } as const;
export const CERTIFICATE_STAGE_TAG_KEY = 'Stage';

export interface CertificateStackProps extends StackProps {
  readonly envName: EnvName;
  readonly domain: string;
  readonly hostedZoneId: string;
}

/**
 * ACM certificate for the site domain, validated through DNS in the `rpillai.dev` zone (tech design 14).
 *
 * The certificate is retained on replacement: a domain change creates a new certificate while CloudFront
 * still uses the old one, so deleting the old one in this stack's cleanup would wait on the Web stack, which
 * can't start until this stack finishes. The deploy prunes unused retained certificates afterwards.
 */
export class CertificateStack extends Stack {
  readonly certificate: ICertificate;

  constructor(scope: Construct, id: string, props: CertificateStackProps) {
    super(scope, id, props);

    const zone = HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      zoneName: HOSTED_ZONE_NAME,
      hostedZoneId: props.hostedZoneId,
    });
    const certificate = new Certificate(this, 'Certificate', {
      domainName: props.domain,
      validation: CertificateValidation.fromDns(zone),
    });
    certificate.applyRemovalPolicy(RemovalPolicy.RETAIN);
    Tags.of(certificate).add(CERTIFICATE_PROJECT_TAG.key, CERTIFICATE_PROJECT_TAG.value);
    Tags.of(certificate).add(CERTIFICATE_STAGE_TAG_KEY, props.envName);
    this.certificate = certificate;

    // Read by the deploy's certificate cleanup, which never deletes the certificate in use here.
    new CfnOutput(this, 'CertificateArn', { value: certificate.certificateArn });
  }
}

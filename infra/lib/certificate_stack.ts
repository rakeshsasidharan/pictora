import { Stack, type StackProps } from 'aws-cdk-lib';
import {
  Certificate,
  CertificateValidation,
  type ICertificate,
} from 'aws-cdk-lib/aws-certificatemanager';
import { HostedZone } from 'aws-cdk-lib/aws-route53';
import type { Construct } from 'constructs';
import { HOSTED_ZONE_NAME } from './stage_config.js';

/** CloudFront only accepts certificates from this region. */
export const CERTIFICATE_REGION = 'us-east-1';

export interface CertificateStackProps extends StackProps {
  readonly domain: string;
  readonly hostedZoneId: string;
}

/** ACM certificate for the site domain, validated through DNS in the `rpillai.dev` zone (tech design 14). */
export class CertificateStack extends Stack {
  readonly certificate: ICertificate;

  constructor(scope: Construct, id: string, props: CertificateStackProps) {
    super(scope, id, props);

    const zone = HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      zoneName: HOSTED_ZONE_NAME,
      hostedZoneId: props.hostedZoneId,
    });
    this.certificate = new Certificate(this, 'Certificate', {
      domainName: props.domain,
      validation: CertificateValidation.fromDns(zone),
    });
  }
}

import { Stage, Tags, type StageProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { AuthStack } from './auth_stack.js';
import { CERTIFICATE_REGION, CertificateStack } from './certificate_stack.js';
import { DataStack } from './data_stack.js';
import { ENVIRONMENT_TAG, MonitoringStack } from './monitoring_stack.js';
import { stageConfig, type EnvName, type StageConfig } from './stage_config.js';
import { WebStack } from './web_stack.js';

export type { EnvName } from './stage_config.js';

export interface PictoraStageProps extends StageProps {
  readonly envName: EnvName;
}

/**
 * One deployable environment (tech design section 14), with settings from CDK context.
 * The `Certificate` stack exists only when the environment has a domain.
 */
export class PictoraStage extends Stage {
  readonly envName: EnvName;
  readonly config: StageConfig;
  readonly certificate?: CertificateStack;
  readonly data: DataStack;
  readonly auth: AuthStack;
  readonly web: WebStack;
  readonly monitoring: MonitoringStack;

  constructor(scope: Construct, id: string, props: PictoraStageProps) {
    super(scope, id, props);
    this.envName = props.envName;
    this.config = stageConfig(this.node, props.envName);
    const config = this.config;

    Tags.of(this).add('project', 'pictora');
    Tags.of(this).add(ENVIRONMENT_TAG, config.envName);

    if (config.domain) {
      this.certificate = new CertificateStack(this, 'Certificate', {
        env: { account: this.account, region: CERTIFICATE_REGION },
        crossRegionReferences: true,
        domain: config.domain,
        hostedZoneId: config.hostedZoneId,
      });
    }
    this.data = new DataStack(this, 'Data', { config });
    this.auth = new AuthStack(this, 'Auth', { config });
    this.web = new WebStack(this, 'Web', {
      crossRegionReferences: config.domain !== undefined,
      config,
      table: this.data.table,
      imagesBucket: this.data.imagesBucket,
      auth: this.auth,
      certificate: this.certificate?.certificate,
    });
    this.monitoring = new MonitoringStack(this, 'Monitoring', {
      config,
      appFunction: this.web.appFunction,
    });
  }
}

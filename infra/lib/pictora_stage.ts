import { Stage, type StageProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { DataStack } from './data_stack.js';

export type EnvName = 'dev' | 'prod';

export interface PictoraStageProps extends StageProps {
  readonly envName: EnvName;
}

/** One deployable environment (tech design section 14). */
export class PictoraStage extends Stage {
  readonly envName: EnvName;
  readonly data: DataStack;

  constructor(scope: Construct, id: string, props: PictoraStageProps) {
    super(scope, id, props);
    this.envName = props.envName;
    this.data = new DataStack(this, 'Data');
  }
}

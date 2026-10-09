import { App, type AppProps } from 'aws-cdk-lib';
import { PictoraStage } from './pictora_stage.js';

export const PRIMARY_REGION = 'us-west-2';

/** Builds the CDK app with the dev and prod stages. The account comes from the deploy credentials. */
export function createPictoraApp(props?: AppProps): App {
  const app = new App(props);
  const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: PRIMARY_REGION };

  new PictoraStage(app, 'PictoraDev', { envName: 'dev', env });
  new PictoraStage(app, 'PictoraProd', { envName: 'prod', env });

  return app;
}

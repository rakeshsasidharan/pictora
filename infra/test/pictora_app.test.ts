import { Stage } from 'aws-cdk-lib';
import { describe, expect, it } from 'vitest';
import { PRIMARY_REGION } from '../lib/pictora_app.js';
import { PictoraStage } from '../lib/pictora_stage.js';
import { testApp } from './helpers.js';

function pictoraStages(): PictoraStage[] {
  return testApp().node.children.filter((child): child is PictoraStage => Stage.isStage(child));
}

describe('Pictora CDK app', () => {
  it('synthesises the dev and prod stages with no AWS account or credentials', () => {
    const assembly = testApp().synth();

    expect(assembly.nestedAssemblies.map((nested) => nested.id)).toEqual([
      'assembly-PictoraDev',
      'assembly-PictoraProd',
    ]);
    const stackNames = (id: string) =>
      assembly.nestedAssemblies
        .find((nested) => nested.id === id)
        ?.nestedAssembly.stacks.map((stack) => stack.stackName)
        .sort();
    expect(stackNames('assembly-PictoraDev')).toEqual([
      'PictoraDev-Auth',
      'PictoraDev-Certificate',
      'PictoraDev-Data',
      'PictoraDev-Jobs',
      'PictoraDev-Monitoring',
      'PictoraDev-Web',
    ]);
    // Prod has no domain yet, so it has no certificate.
    expect(stackNames('assembly-PictoraProd')).toEqual([
      'PictoraProd-Auth',
      'PictoraProd-Data',
      'PictoraProd-Jobs',
      'PictoraProd-Monitoring',
      'PictoraProd-Web',
    ]);
  });

  it('pins both stages to the primary region and their environment name', () => {
    expect(pictoraStages().map((stage) => [stage.stageName, stage.envName, stage.region])).toEqual([
      ['PictoraDev', 'dev', PRIMARY_REGION],
      ['PictoraProd', 'prod', PRIMARY_REGION],
    ]);
  });

  it('reads the per-environment settings from cdk.json', () => {
    const [dev, prod] = pictoraStages();
    expect(dev?.config).toMatchObject({
      domain: 'pictora.rpillai.dev',
      dailyPoints: 1000,
      spendCapUsd: 20,
      queueConcurrency: 5,
    });
    expect(prod?.config).toMatchObject({ dailyPoints: 25, spendCapUsd: 100, queueConcurrency: 5 });
    expect(prod?.config.domain).toBeUndefined();
  });
});

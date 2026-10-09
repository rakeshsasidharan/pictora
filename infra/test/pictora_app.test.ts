import { Stage } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { createPictoraApp, PRIMARY_REGION } from '../lib/pictora_app.js';
import { PictoraStage } from '../lib/pictora_stage.js';

function pictoraStages(): PictoraStage[] {
  const app = createPictoraApp();
  return app.node.children.filter((child): child is PictoraStage => Stage.isStage(child));
}

describe('Pictora CDK app', () => {
  it('synthesises the dev and prod stages', () => {
    const assembly = createPictoraApp().synth();

    expect(assembly.nestedAssemblies.map((nested) => nested.id)).toEqual([
      'assembly-PictoraDev',
      'assembly-PictoraProd',
    ]);
    for (const nested of assembly.nestedAssemblies) {
      expect(nested.nestedAssembly.stacks.map((stack) => stack.stackName)).toEqual([
        `${nested.id.replace('assembly-', '')}-Data`,
      ]);
    }
  });

  it('pins both stages to the primary region and their environment name', () => {
    expect(pictoraStages().map((stage) => [stage.stageName, stage.envName, stage.region])).toEqual([
      ['PictoraDev', 'dev', PRIMARY_REGION],
      ['PictoraProd', 'prod', PRIMARY_REGION],
    ]);
  });

  it('starts each stage with a Data stack that has no resources yet', () => {
    for (const stage of pictoraStages()) {
      const template = Template.fromStack(stage.data);
      expect(Object.keys(template.toJSON().Resources ?? {})).toEqual([]);
    }
  });
});

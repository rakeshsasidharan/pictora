import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import type { PictoraStage } from '../lib/pictora_stage.js';
import { testStage } from './helpers.js';

function stacks(stage: PictoraStage) {
  return [stage.data, stage.auth, stage.jobs, stage.web, stage.monitoring];
}

describe.each([
  ['PictoraDev', 30],
  ['PictoraProd', 90],
] as const)('log retention in %s', (name, days) => {
  const stage = testStage(name);

  it(`keeps every Pictora log group for ${days} days`, () => {
    const retentions = stacks(stage).flatMap((stack) =>
      Object.values(Template.fromStack(stack).findResources('AWS::Logs::LogGroup')).map(
        (group) => group.Properties.RetentionInDays,
      ),
    );
    expect(retentions.length).toBeGreaterThan(0);
    expect(new Set(retentions)).toEqual(new Set([days]));
  });

  it('gives every Pictora function its own log group', () => {
    for (const stack of stacks(stage)) {
      const functions = Template.fromStack(stack).findResources('AWS::Lambda::Function');
      for (const [id, fn] of Object.entries(functions)) {
        // CDK's own singleton that empties dev buckets on delete can't take a log group.
        if (id.startsWith('CustomS3AutoDeleteObjects')) continue;
        expect(fn.Properties.LoggingConfig?.LogGroup, `${stack.stackName} ${id}`).toBeDefined();
      }
    }
  });
});

import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { testStage } from './helpers.js';

/** Asset hashes change with every aws-cdk-lib release; mask them so the snapshot tracks only our changes. */
function maskAssetHashes(template: unknown): unknown {
  return JSON.parse(JSON.stringify(template).replace(/[a-f0-9]{64}/g, '<asset-hash>'));
}

describe('PictoraDev stage', () => {
  it('matches the snapshot', () => {
    const stage = testStage('PictoraDev');
    const stacks = [stage.certificate, stage.data, stage.auth, stage.web, stage.monitoring];
    for (const stack of stacks) {
      if (!stack) throw new Error('missing stack');
      expect(maskAssetHashes(Template.fromStack(stack).toJSON())).toMatchSnapshot(stack.stackName);
    }
  });
});

import { findModel, loadSeedRegistry } from '@pictora/core';
import { describe, expect, it } from 'vitest';
import { batchDeps, pipelineDeps, tableContext, workerEnvironment } from '../src/deps.js';

function seedModel(id: string) {
  const model = findModel(loadSeedRegistry(), id);
  if (!model) throw new Error(`No seed model ${id}`);
  return model;
}

describe('workerEnvironment', () => {
  it('reads PICTORA_ENV, treating anything but dev as prod', () => {
    expect(workerEnvironment({ PICTORA_ENV: 'dev' })).toBe('dev');
    expect(workerEnvironment({ PICTORA_ENV: 'prod' })).toBe('prod');
    expect(workerEnvironment({})).toBe('prod');
    expect(workerEnvironment({ PICTORA_ENV: 'staging' })).toBe('prod');
  });
});

describe('worker deps', () => {
  it('needs the table name', () => {
    expect(() => tableContext({})).toThrow('TABLE_NAME is not set');
    expect(tableContext({ TABLE_NAME: 'pictora-dev' }).tableName).toBe('pictora-dev');
  });

  it('needs the images bucket, the OpenAI secret and the Gemini secret, and builds both adapters', () => {
    expect(() => pipelineDeps({ TABLE_NAME: 'pictora-dev' })).toThrow('IMAGES_BUCKET is not set');
    expect(() => pipelineDeps({ TABLE_NAME: 'pictora-dev', IMAGES_BUCKET: 'images' })).toThrow(
      'OPENAI_SECRET_ID is not set',
    );
    expect(() =>
      pipelineDeps({
        TABLE_NAME: 'pictora-dev',
        IMAGES_BUCKET: 'images',
        OPENAI_SECRET_ID: 'pictora/dev/openai',
      }),
    ).toThrow('GEMINI_SECRET_ID is not set');
    const env = {
      PICTORA_ENV: 'dev',
      TABLE_NAME: 'pictora-dev',
      IMAGES_BUCKET: 'images',
      OPENAI_SECRET_ID: 'pictora/dev/openai',
      GEMINI_SECRET_ID: 'pictora/dev/gemini',
      SPEND_CAP_CENTS: '2000',
    };
    expect(() => pipelineDeps({ ...env, SPEND_CAP_CENTS: undefined })).toThrow(
      'SPEND_CAP_CENTS is not set',
    );
    expect(() => pipelineDeps({ ...env, SPEND_CAP_CENTS: 'lots' })).toThrow(
      'SPEND_CAP_CENTS is not valid',
    );
    const deps = pipelineDeps(env);
    expect(deps).toMatchObject({
      tableName: 'pictora-dev',
      bucket: 'images',
      spend: { capCents: 2000, namespace: 'Pictora/dev' },
    });
    expect(deps.moderate).toBeTypeOf('function');
    const openai = deps.provider(seedModel('gpt-image-2'));
    expect(openai.generate).toBeTypeOf('function');
    expect(openai.edit).toBeTypeOf('function');
    const gemini = deps.provider(seedModel('gemini-3.1-flash-image'));
    expect(gemini.generate).toBeTypeOf('function');
    expect(gemini).not.toBe(openai);
    expect(deps.provider(seedModel('stable-image-core'))).not.toBe(gemini);
    expect(() => pipelineDeps({ ...env, GEMINI_BACKEND: 'vertexai' })).toThrow(
      'GEMINI_BACKEND must be one of api, vertex: vertexai',
    );
    expect(deps.newImageId()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('builds the batch Lambdas their batch adapters, with the same settings', () => {
    const env = {
      PICTORA_ENV: 'dev',
      TABLE_NAME: 'pictora-dev',
      IMAGES_BUCKET: 'images',
      OPENAI_SECRET_ID: 'pictora/dev/openai',
      GEMINI_SECRET_ID: 'pictora/dev/gemini',
      SPEND_CAP_CENTS: '2000',
    };
    expect(() => batchDeps({ TABLE_NAME: 'pictora-dev' })).toThrow('IMAGES_BUCKET is not set');
    const deps = batchDeps(env);
    expect(deps).toMatchObject({ tableName: 'pictora-dev', bucket: 'images' });
    expect(deps).not.toHaveProperty('provider');
    const openai = deps.batchProvider(seedModel('gpt-image-2'));
    expect(openai.submitBatch).toBeTypeOf('function');
    expect(deps.batchProvider(seedModel('gemini-3.1-flash-image'))).not.toBe(openai);
    expect(() => deps.batchProvider(seedModel('stable-image-core'))).toThrow(/No batch adapter/);
  });
});

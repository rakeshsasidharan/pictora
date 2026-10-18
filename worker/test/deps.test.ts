import { findModel, loadSeedRegistry } from '@pictora/core';
import { describe, expect, it } from 'vitest';
import { pipelineDeps, tableContext, workerEnvironment } from '../src/deps.js';

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

  it('needs the images bucket, the OpenAI secret for moderation and the Gemini secret', () => {
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
      TABLE_NAME: 'pictora-dev',
      IMAGES_BUCKET: 'images',
      OPENAI_SECRET_ID: 'pictora/dev/openai',
      GEMINI_SECRET_ID: 'pictora/dev/gemini',
    };
    const deps = pipelineDeps(env);
    expect(deps).toMatchObject({ tableName: 'pictora-dev', bucket: 'images' });
    expect(deps.moderate).toBeTypeOf('function');
    const gemini = deps.provider(seedModel('gemini-3.1-flash-image'));
    expect(gemini.generate).toBeTypeOf('function');
    expect(deps.provider(seedModel('stable-image-core'))).not.toBe(gemini);
    expect(() => pipelineDeps({ ...env, GEMINI_BACKEND: 'vertexai' })).toThrow(
      'GEMINI_BACKEND must be one of api, vertex: vertexai',
    );
    expect(deps.newImageId()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

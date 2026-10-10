import { describe, expect, it } from 'vitest';
import {
  ASPECTS,
  QUALITIES,
  STYLE_IDS,
  createJobRequestSchema,
  editJobRequestSchema,
  enhanceRequestSchema,
  generateJobRequestSchema,
  uploadRequestSchema,
} from '../src/index.js';

const IMAGE_ID = '01JA2B3C4D5E6F7G8H9J0K1M2N';
const UPLOAD_KEY = `uploads/3f1c2a9e-1b2c-4d5e-8f90-a1b2c3d4e5f6/${IMAGE_ID}`;

const validGenerate = {
  type: 'generate',
  prompt: 'A red fox in a snowy forest',
  style: 'watercolour',
  modelId: 'gemini-3.1-flash-image',
  aspect: '3:2',
  quality: 'standard',
  count: 2,
} as const;

const validEdit = {
  type: 'edit',
  imageId: IMAGE_ID,
  parentVersion: 1,
  instruction: 'Make it night',
  modelId: 'gemini-3.1-flash-image',
  quality: 'standard',
} as const;

describe('generateJobRequestSchema', () => {
  it('accepts a minimal request', () => {
    expect(generateJobRequestSchema.parse(validGenerate)).toEqual(validGenerate);
  });

  it('accepts every optional field', () => {
    const request = {
      ...validGenerate,
      enhancedPrompt: 'A red fox, soft morning light',
      avoid: 'people',
      seed: 42,
      transparentBackground: true,
    };
    expect(generateJobRequestSchema.parse(request)).toEqual(request);
  });

  it('trims the prompt', () => {
    expect(generateJobRequestSchema.parse({ ...validGenerate, prompt: '  fox  ' }).prompt).toBe(
      'fox',
    );
  });

  it('accepts a prompt of exactly 2,000 characters and rejects 2,001', () => {
    expect(
      generateJobRequestSchema.safeParse({ ...validGenerate, prompt: 'a'.repeat(2000) }).success,
    ).toBe(true);
    expect(
      generateJobRequestSchema.safeParse({ ...validGenerate, prompt: 'a'.repeat(2001) }).success,
    ).toBe(false);
  });

  it('rejects an empty or blank prompt', () => {
    expect(generateJobRequestSchema.safeParse({ ...validGenerate, prompt: '' }).success).toBe(
      false,
    );
    expect(generateJobRequestSchema.safeParse({ ...validGenerate, prompt: '   ' }).success).toBe(
      false,
    );
  });

  it('limits the enhanced prompt to 2,000 characters', () => {
    const request = { ...validGenerate, enhancedPrompt: 'a'.repeat(2001) };
    expect(generateJobRequestSchema.safeParse(request).success).toBe(false);
  });

  it('accepts an avoid field of 500 characters and rejects 501', () => {
    expect(
      generateJobRequestSchema.safeParse({ ...validGenerate, avoid: 'a'.repeat(500) }).success,
    ).toBe(true);
    expect(
      generateJobRequestSchema.safeParse({ ...validGenerate, avoid: 'a'.repeat(501) }).success,
    ).toBe(false);
  });

  it.each([1, 2, 3, 4])('accepts a count of %s', (count) => {
    expect(generateJobRequestSchema.safeParse({ ...validGenerate, count }).success).toBe(true);
  });

  it.each([0, 5, 1.5, '2'])('rejects a count of %s', (count) => {
    expect(generateJobRequestSchema.safeParse({ ...validGenerate, count }).success).toBe(false);
  });

  it('accepts every aspect, quality and style, and rejects other values', () => {
    for (const aspect of ASPECTS) {
      expect(generateJobRequestSchema.safeParse({ ...validGenerate, aspect }).success).toBe(true);
    }
    for (const quality of QUALITIES) {
      expect(generateJobRequestSchema.safeParse({ ...validGenerate, quality }).success).toBe(true);
    }
    for (const style of STYLE_IDS) {
      expect(generateJobRequestSchema.safeParse({ ...validGenerate, style }).success).toBe(true);
    }
    expect(generateJobRequestSchema.safeParse({ ...validGenerate, aspect: '4:3' }).success).toBe(
      false,
    );
    expect(generateJobRequestSchema.safeParse({ ...validGenerate, quality: 'max' }).success).toBe(
      false,
    );
    expect(
      generateJobRequestSchema.safeParse({ ...validGenerate, style: 'pixel-art' }).success,
    ).toBe(false);
  });

  it('rejects malformed model ids', () => {
    for (const modelId of ['', 'GPT-Image-2', 'gpt image', 'a'.repeat(65)]) {
      expect(generateJobRequestSchema.safeParse({ ...validGenerate, modelId }).success).toBe(false);
    }
  });

  it('rejects seeds outside 0 to 2^32 - 1', () => {
    expect(
      generateJobRequestSchema.safeParse({ ...validGenerate, seed: 4_294_967_295 }).success,
    ).toBe(true);
    expect(
      generateJobRequestSchema.safeParse({ ...validGenerate, seed: 4_294_967_296 }).success,
    ).toBe(false);
    expect(generateJobRequestSchema.safeParse({ ...validGenerate, seed: -1 }).success).toBe(false);
  });

  it('rejects unknown fields and missing required fields', () => {
    expect(generateJobRequestSchema.safeParse({ ...validGenerate, extra: true }).success).toBe(
      false,
    );
    const withoutModel: Record<string, unknown> = { ...validGenerate };
    delete withoutModel.modelId;
    expect(generateJobRequestSchema.safeParse(withoutModel).success).toBe(false);
  });
});

describe('editJobRequestSchema', () => {
  it('accepts an edit with up to 3 reference images', () => {
    const request = { ...validEdit, referenceKeys: [UPLOAD_KEY, UPLOAD_KEY, UPLOAD_KEY] };
    expect(editJobRequestSchema.parse(request)).toEqual(request);
  });

  it('rejects more than 3 reference images', () => {
    const request = {
      ...validEdit,
      referenceKeys: [UPLOAD_KEY, UPLOAD_KEY, UPLOAD_KEY, UPLOAD_KEY],
    };
    expect(editJobRequestSchema.safeParse(request).success).toBe(false);
  });

  it('rejects reference keys outside the uploads prefix', () => {
    for (const key of [
      `users/abc/${IMAGE_ID}/v1.png`,
      'uploads/abc/not-a-ulid',
      `uploads/../${IMAGE_ID}`,
    ]) {
      expect(editJobRequestSchema.safeParse({ ...validEdit, referenceKeys: [key] }).success).toBe(
        false,
      );
    }
  });

  it('rejects an image id that is not a ULID', () => {
    expect(editJobRequestSchema.safeParse({ ...validEdit, imageId: 'abc' }).success).toBe(false);
    expect(
      editJobRequestSchema.safeParse({ ...validEdit, imageId: IMAGE_ID.toLowerCase() }).success,
    ).toBe(false);
  });

  it('rejects a parent version below 1', () => {
    expect(editJobRequestSchema.safeParse({ ...validEdit, parentVersion: 0 }).success).toBe(false);
  });

  it('limits the instruction to 1 to 2,000 characters', () => {
    expect(editJobRequestSchema.safeParse({ ...validEdit, instruction: ' ' }).success).toBe(false);
    expect(
      editJobRequestSchema.safeParse({ ...validEdit, instruction: 'a'.repeat(2001) }).success,
    ).toBe(false);
  });
});

describe('createJobRequestSchema', () => {
  it('picks the generate or edit schema from the type', () => {
    expect(createJobRequestSchema.parse(validGenerate).type).toBe('generate');
    expect(createJobRequestSchema.parse(validEdit).type).toBe('edit');
  });

  it('rejects an unknown type, or fields from the other type', () => {
    expect(createJobRequestSchema.safeParse({ ...validGenerate, type: 'upscale' }).success).toBe(
      false,
    );
    expect(createJobRequestSchema.safeParse({ ...validEdit, type: 'generate' }).success).toBe(
      false,
    );
  });
});

describe('enhanceRequestSchema', () => {
  const valid = { prompt: 'a cat', style: 'anime', modelId: 'gpt-image-2' };

  it('accepts a valid request', () => {
    expect(enhanceRequestSchema.parse(valid)).toEqual(valid);
  });

  it('rejects long prompts, unknown styles and extra fields', () => {
    expect(enhanceRequestSchema.safeParse({ ...valid, prompt: 'a'.repeat(2001) }).success).toBe(
      false,
    );
    expect(enhanceRequestSchema.safeParse({ ...valid, style: 'sketch' }).success).toBe(false);
    expect(enhanceRequestSchema.safeParse({ ...valid, count: 1 }).success).toBe(false);
  });
});

describe('uploadRequestSchema', () => {
  it.each(['image/jpeg', 'image/png', 'image/webp'])('accepts %s', (contentType) => {
    expect(uploadRequestSchema.safeParse({ contentType, size: 1 }).success).toBe(true);
  });

  it('rejects other content types', () => {
    for (const contentType of ['image/gif', 'image/svg+xml', 'application/pdf']) {
      expect(uploadRequestSchema.safeParse({ contentType, size: 1000 }).success).toBe(false);
    }
  });

  it('accepts 1 byte to 10 MB and rejects anything else', () => {
    const tenMegabytes = 10 * 1024 * 1024;
    expect(
      uploadRequestSchema.safeParse({ contentType: 'image/png', size: tenMegabytes }).success,
    ).toBe(true);
    expect(
      uploadRequestSchema.safeParse({ contentType: 'image/png', size: tenMegabytes + 1 }).success,
    ).toBe(false);
    expect(uploadRequestSchema.safeParse({ contentType: 'image/png', size: 0 }).success).toBe(
      false,
    );
    expect(uploadRequestSchema.safeParse({ contentType: 'image/png', size: 1.5 }).success).toBe(
      false,
    );
  });
});

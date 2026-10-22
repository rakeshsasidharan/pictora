import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  JOB_SK,
  PROFILE_SK,
  TESTERS_GROUP,
  TOS_VERSION,
  imageKey,
  imageSk,
  jobPk,
  loadSeedRegistry,
  uploadKey,
  userPk,
  versionSk,
} from '@pictora/core';
import { modelsAvailableIn } from '@pictora/core/registry-store';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ImageDeleteDeps } from '../src/lib/images';
import type { JobsDeps } from '../src/lib/jobs';
import { SESSION_HEADERS, type Session } from '../src/lib/session';
import type { UploadsDeps } from '../src/lib/uploads';
import { DYNAMODB_ENDPOINT, localTable } from './dynamodb_local';

/** Deps for the cross-user checks, set once DynamoDB Local is up; without a session no route may reach them. */
const local = vi.hoisted(() => ({
  jobs: undefined as JobsDeps | undefined,
  images: undefined as ImageDeleteDeps | undefined,
  uploads: undefined as UploadsDeps | undefined,
}));

function unreachable(name: string): never {
  throw new Error(`${name} was used without a session`);
}

vi.mock('../src/lib/jobs_deps', () => ({ jobsDeps: () => local.jobs ?? unreachable('jobsDeps') }));
vi.mock('../src/lib/images_deps', () => ({
  imagesDeps: () => local.images ?? unreachable('imagesDeps'),
}));
vi.mock('../src/lib/uploads_deps', () => ({
  uploadsDeps: () => local.uploads ?? unreachable('uploadsDeps'),
}));
vi.mock('../src/lib/account_deps', () => ({ accountDeps: () => unreachable('accountDeps') }));
vi.mock('../src/lib/enhance_deps', () => ({ enhanceDeps: () => unreachable('enhanceDeps') }));
vi.mock('../src/lib/admin_deps', () => ({ adminDeps: () => unreachable('adminDeps') }));

const API_DIR = fileURLToPath(new URL('../src/app/api', import.meta.url));
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type Method = (typeof METHODS)[number];
type Handler = (request: NextRequest, context: { params: Promise<object> }) => Promise<Response>;

/** Public routes (tech design 7); every other route needs a session. */
const PUBLIC_ROUTES = new Set(['GET /api/health']);

const OWNER_IMAGE = '01JAAAAAAAAAAAAAAAAAAAAAAA';
const OWNER_JOB = '01JBBBBBBBBBBBBBBBBBBBBBBB';
const OWNER_UPLOAD = '01JCCCCCCCCCCCCCCCCCCCCCCC';
const MODLOG_ID = '01JDDDDDDDDDDDDDDDDDDDDDDD';

interface Route {
  method: Method;
  /** As tech design 7 writes it, for example `/api/images/:id`. */
  path: string;
  file: string;
  handler: Handler;
}

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name === 'route.ts' ? [path] : [];
  });
}

/** Every handler of every `/api` route file, found on disk so a new route can't be left out. */
async function apiRoutes(): Promise<Route[]> {
  const routes: Route[] = [];
  for (const file of routeFiles(API_DIR)) {
    const segments = relative(API_DIR, file).split(/[\\/]/).slice(0, -1);
    const path = `/api/${segments.map((segment) => segment.replace(/^\[(.+)\]$/, ':$1')).join('/')}`;
    const handlers = (await import(file)) as Partial<Record<Method, Handler>>;
    for (const method of METHODS) {
      const handler = handlers[method];
      if (handler) routes.push({ method, path, file, handler });
    }
  }
  return routes.sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
}

/** Values for path parameters that pass each route's format checks, so only the session is missing. */
const PARAM_VALUES: Record<string, string> = {
  id: OWNER_IMAGE,
  n: '1',
  sub: 'some-user',
  date: '2026-10-22',
};

function call(
  route: Route,
  options: {
    headers?: Record<string, string>;
    body?: unknown;
    params?: Record<string, string>;
  } = {},
): Promise<Response> {
  const params = Object.fromEntries(
    [...route.path.matchAll(/:(\w+)/g)].map(([, name = '']) => [
      name,
      options.params?.[name] ?? PARAM_VALUES[name] ?? 'x',
    ]),
  );
  const url = `https://pictora.example.dev${route.path.replace(/:(\w+)/g, (_, name: string) => params[name] ?? '')}`;
  const sendsBody = route.method !== 'GET' && route.method !== 'DELETE';
  const request = new NextRequest(url, {
    method: route.method,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...(sendsBody ? { body: JSON.stringify(options.body ?? {}) } : {}),
  });
  return route.handler(request, { params: Promise.resolve(params) });
}

const routes = await apiRoutes();
const key = (route: Pick<Route, 'method' | 'path'>) => `${route.method} ${route.path}`;
const protectedRoutes = routes.filter((route) => !PUBLIC_ROUTES.has(key(route)));

describe('every /api route', () => {
  it('is found on disk', () => {
    expect(routes.length).toBeGreaterThan(15);
    expect(routes.map(key)).toContain('GET /api/health');
  });

  it.each(protectedRoutes.map((route) => [key(route), route] as const))(
    '%s answers 401 without a session',
    async (_name, route) => {
      const response = await call(route, { body: { prompt: 'A fox' } });
      expect(response.status).toBe(401);
    },
  );

  it('answers the public health check without a session', async () => {
    const health = routes.find((route) => key(route) === 'GET /api/health');
    expect(health && (await call(health)).status).toBe(200);
  });

  it('appears in the endpoint audit table in tech design 12.1, which lists nothing else', () => {
    const design = readFileSync(new URL('../../docs/tech_design.md', import.meta.url), 'utf8');
    const section = design.split('### 12.1 Endpoint audit')[1]?.split(/\n## /)[0] ?? '';
    const audited = [...section.matchAll(/^\| (GET|POST|PUT|PATCH|DELETE) \| `([^`]+)` \|/gm)].map(
      ([, method, path]) => `${method} ${path}`,
    );
    expect(audited.sort()).toEqual(routes.map(key).sort());
  });
});

describe.skipIf(!DYNAMODB_ENDPOINT)('another user’s resources', () => {
  const table = localTable('pictora-api-access');
  const { client, tableName } = table;
  const owner: Session = { sub: `owner-${Date.now()}`, email: 'owner@example.com', groups: [] };
  // A tester, so the edit check gets past the Mock model to the ownership check.
  const other: Session = {
    sub: `other-${Date.now()}`,
    email: 'other@example.com',
    groups: [TESTERS_GROUP],
  };
  const enqueue = vi.fn<JobsDeps['enqueue']>(async () => undefined);
  const removePrefix = vi.fn<ImageDeleteDeps['removePrefix']>(async () => undefined);
  /** The owner's upload sits in the bucket. */
  const objects = new Map([[uploadKey(owner.sub, OWNER_UPLOAD), 2048]]);
  const now = () => new Date('2026-10-22T12:00:00Z');
  const presign = async (objectKey: string) => `https://signed.example/${objectKey}`;

  const headersFor = (session: Session) => ({
    [SESSION_HEADERS.sub]: session.sub,
    [SESSION_HEADERS.email]: session.email,
    [SESSION_HEADERS.groups]: session.groups.join(','),
  });
  const put = (item: Record<string, unknown>) =>
    client.send(new PutCommand({ TableName: tableName, Item: item }));
  const route = (method: Method, path: string) => {
    const found = routes.find((candidate) => key(candidate) === `${method} ${path}`);
    if (!found) throw new Error(`no route ${method} ${path}`);
    return found;
  };

  beforeAll(async () => {
    await table.create();
    vi.stubEnv('TABLE_NAME', tableName);
    vi.stubEnv('AWS_REGION', 'us-west-2');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'local');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'local');
    const storage: UploadsDeps['storage'] = {
      presignUpload: vi.fn(),
      size: async (objectKey) => objects.get(objectKey),
      read: async () => undefined,
      write: vi.fn(),
      remove: vi.fn(),
      presign,
    };
    local.jobs = {
      client,
      tableName,
      models: async () => modelsAvailableIn(loadSeedRegistry(), 'dev'),
      hasQueue: () => true,
      enqueue,
      presign,
      objectSize: storage.size,
      defaultDailyPoints: 25,
      spendCapCents: 2000,
      now,
      newJobId: () => '01JEEEEEEEEEEEEEEEEEEEEEEE',
    };
    local.images = { client, tableName, presign, removePrefix };
    local.uploads = {
      client,
      tableName,
      storage,
      moderate: vi.fn(),
      prepare: vi.fn(),
      now,
      newId: () => '01JFFFFFFFFFFFFFFFFFFFFFFF',
    };

    for (const session of [owner, other]) {
      await put({
        PK: userPk(session.sub),
        SK: PROFILE_SK,
        email: session.email,
        createdAt: '2026-10-20T09:00:00.000Z',
        status: 'active',
        activeJobs: 0,
        tosAcceptedAt: '2026-10-20T09:00:00.000Z',
        tosVersion: TOS_VERSION,
        ageConfirmed: true,
      });
    }
    await put({
      PK: userPk(owner.sub),
      SK: imageSk(OWNER_IMAGE),
      imageId: OWNER_IMAGE,
      latestVersion: 1,
    });
    await put({
      PK: userPk(owner.sub),
      SK: versionSk(OWNER_IMAGE, 1),
      imageId: OWNER_IMAGE,
      version: 1,
      s3Key: imageKey(owner.sub, OWNER_IMAGE, 1),
      thumbKey: `users/${owner.sub}/${OWNER_IMAGE}/v1_thumb.webp`,
      prompt: 'A fox',
      createdAt: '2026-10-22T11:00:00.000Z',
      width: 1024,
      height: 1024,
    });
    await put({
      PK: jobPk(OWNER_JOB),
      SK: JOB_SK,
      jobId: OWNER_JOB,
      userId: owner.sub,
      type: 'generate',
      status: 'succeeded',
      createdAt: '2026-10-22T11:00:00.000Z',
    });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    local.jobs = local.images = local.uploads = undefined;
    await table.drop();
  });

  const crossUser: [string, Method, string, { body?: unknown; params?: Record<string, string> }][] =
    [
      ['reads their job', 'GET', '/api/jobs/:id', { params: { id: OWNER_JOB } }],
      ['reads their image', 'GET', '/api/images/:id', {}],
      ['deletes their image', 'DELETE', '/api/images/:id', {}],
      ['downloads their image', 'GET', '/api/images/:id/versions/:n/download', {}],
      [
        'reports their image',
        'POST',
        '/api/reports',
        { body: { imageId: OWNER_IMAGE, version: 1, reason: 'hate' } },
      ],
      [
        'completes their upload',
        'POST',
        '/api/uploads/:id/complete',
        { params: { id: OWNER_UPLOAD } },
      ],
      [
        'edits their image',
        'POST',
        '/api/jobs',
        {
          body: {
            type: 'edit',
            imageId: OWNER_IMAGE,
            parentVersion: 1,
            instruction: 'Make it night',
            modelId: 'mock',
            quality: 'draft',
          },
        },
      ],
      [
        'uses their image as a reference',
        'POST',
        '/api/jobs',
        {
          body: {
            type: 'edit',
            imageId: OWNER_IMAGE,
            parentVersion: 1,
            instruction: 'Make it night',
            modelId: 'mock',
            quality: 'draft',
            referenceKeys: [uploadKey(owner.sub, OWNER_UPLOAD)],
          },
        },
      ],
    ];

  it.each(crossUser)('answers 404 when a user %s', async (_name, method, path, options) => {
    const response = await call(route(method, path), { ...options, headers: headersFor(other) });
    expect(response.status).toBe(404);
  });

  it('answers the owner, so the 404s above come from the ownership checks', async () => {
    const image = await call(route('GET', '/api/images/:id'), { headers: headersFor(owner) });
    expect(image.status).toBe(200);
    const job = await call(route('GET', '/api/jobs/:id'), {
      params: { id: OWNER_JOB },
      headers: headersFor(owner),
    });
    expect(job.status).toBe(200);
  });

  it('left the owner’s image, job and upload alone', async () => {
    expect(enqueue).not.toHaveBeenCalled();
    expect(removePrefix).not.toHaveBeenCalled();
    const image = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: userPk(owner.sub), SK: imageSk(OWNER_IMAGE) },
      }),
    );
    expect(image.Item).toBeDefined();
  });

  it.each([
    ['GET', '/api/admin/users/:sub', {}],
    ['POST', '/api/admin/users/:sub/suspend', {}],
    ['POST', '/api/admin/users/:sub/unsuspend', {}],
    ['GET', '/api/admin/stats', {}],
    ['GET', '/api/admin/moderation', {}],
    [
      'POST',
      '/api/admin/moderation/:date/:id/review',
      { body: { verdict: 'ok' }, params: { id: MODLOG_ID } },
    ],
  ] as const)(
    'answers 403 when a user outside admins calls %s %s',
    async (method, path, options) => {
      const response = await call(route(method, path), {
        ...options,
        params: { sub: owner.sub, ...('params' in options ? options.params : {}) },
        headers: headersFor(other),
      });
      expect(response.status).toBe(403);
    },
  );
});

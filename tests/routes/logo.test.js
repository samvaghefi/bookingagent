'use strict';

const request = require('supertest');
const express = require('express');

// ── Mutable state shared with multer mock closure ─────────────────────────────
// Reset per test via buildApp so the middleware uses the right file/error.
let mockReqFile;
let mockMulterError;

// ── Shared fixtures ───────────────────────────────────────────────────────────

const PNG_FILE = {
  fieldname: 'logo', originalname: 'logo.png',
  mimetype: 'image/png', buffer: Buffer.from('fake-png-data'), size: 100,
};
const JPG_FILE = {
  fieldname: 'logo', originalname: 'logo.jpg',
  mimetype: 'image/jpeg', buffer: Buffer.from('fake-jpg-data'), size: 100,
};
const INVALID_FILE = {
  fieldname: 'logo', originalname: 'doc.pdf',
  mimetype: 'application/pdf', buffer: Buffer.from('fake-pdf'), size: 100,
};

const PUBLIC_URL = 'https://project.supabase.co/storage/v1/object/public/business-logos/logos/biz-123/logo.png';

// ── Thenable Supabase chain (mirrors pattern from other route tests) ──────────
function chain(result) {
  const obj = { then: (res, rej) => Promise.resolve(result).then(res, rej) };
  ['select', 'eq', 'neq', 'in', 'not', 'order', 'update', 'insert', 'delete'].forEach(m => {
    obj[m] = () => chain(result);
  });
  obj.single      = () => Promise.resolve(result);
  obj.maybeSingle = () => Promise.resolve(result);
  return obj;
}

// ── App factory ───────────────────────────────────────────────────────────────

function buildApp({
  plan        = 'starter',
  bizLogoUrl  = null,
  file,
  multerError = null,
  uploadError = null,
} = {}) {
  mockReqFile    = file;
  mockMulterError = multerError;

  jest.resetModules();

  // Mock multer — controls what req.file looks like without real HTTP parsing
  jest.doMock('multer', () => {
    const multerFn = jest.fn().mockReturnValue({
      single: jest.fn().mockReturnValue((req, res, next) => {
        if (mockMulterError) return next(mockMulterError);
        if (mockReqFile !== undefined) req.file = mockReqFile;
        next();
      }),
    });
    multerFn.memoryStorage = jest.fn().mockReturnValue({});
    return multerFn;
  });

  // Mock auth — skip JWT validation and inject a test business
  jest.doMock('../../server/authMiddleware', () => (req, res, next) => {
    req.business = { id: 'biz-123' };
    next();
  });

  // Mock Supabase DB + Storage
  const mockUpload        = jest.fn().mockResolvedValue(uploadError ? { data: null, error: uploadError } : { data: {}, error: null });
  const mockGetPublicUrl  = jest.fn().mockReturnValue({ data: { publicUrl: PUBLIC_URL } });
  const mockRemove        = jest.fn().mockResolvedValue({ data: {}, error: null });
  const mockStorageFrom   = jest.fn().mockReturnValue({ upload: mockUpload, getPublicUrl: mockGetPublicUrl, remove: mockRemove });
  const mockCreateBucket  = jest.fn().mockResolvedValue({ data: {}, error: null });
  const bizData           = { data: { plan, logo_url: bizLogoUrl }, error: null };

  jest.doMock('@supabase/supabase-js', () => ({
    createClient: () => ({
      from: () => chain(bizData),
      storage: { createBucket: mockCreateBucket, from: mockStorageFrom },
    }),
  }));

  const router = require('../../server/logoRoutes');
  const app = express();
  app.use(express.json());
  app.use(router);

  return { app, mockUpload, mockGetPublicUrl, mockRemove, mockStorageFrom, mockCreateBucket };
}

// ── POST /api/business/logo ───────────────────────────────────────────────────

describe('POST /api/business/logo', () => {
  test('400 when no file is attached', () => {
    const { app } = buildApp({ file: undefined });
    return request(app).post('/api/business/logo').then(res => {
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/no file/i);
    });
  });

  test('400 when file is wrong mimetype', () => {
    const { app } = buildApp({ file: INVALID_FILE });
    return request(app).post('/api/business/logo').then(res => {
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/png|jpg/i);
    });
  });

  test('400 when multer rejects file as too large', () => {
    const { app } = buildApp({ multerError: { code: 'LIMIT_FILE_SIZE', message: 'Too large' } });
    return request(app).post('/api/business/logo').then(res => {
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/2mb|too large/i);
    });
  });

  test('403 for solo plan', () => {
    const { app } = buildApp({ plan: 'solo', file: PNG_FILE });
    return request(app).post('/api/business/logo').then(res => {
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/upgrade|starter/i);
    });
  });

  test('200 and returns logo_url on valid PNG upload', async () => {
    const { app, mockUpload, mockGetPublicUrl } = buildApp({ file: PNG_FILE });
    const res = await request(app).post('/api/business/logo');
    expect(res.status).toBe(200);
    expect(res.body.logo_url).toBe(PUBLIC_URL);
    expect(mockUpload).toHaveBeenCalledTimes(1);
    const [path, buf, opts] = mockUpload.mock.calls[0];
    expect(path).toMatch(/logos\/biz-123\/logo\.png/);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(opts.contentType).toBe('image/png');
    expect(opts.upsert).toBe(true);
    expect(mockGetPublicUrl).toHaveBeenCalledTimes(1);
  });

  test('200 and returns logo_url on valid JPG upload', async () => {
    const { app, mockUpload } = buildApp({ file: JPG_FILE });
    const res = await request(app).post('/api/business/logo');
    expect(res.status).toBe(200);
    expect(res.body.logo_url).toBe(PUBLIC_URL);
    const [path] = mockUpload.mock.calls[0];
    expect(path).toMatch(/logo\.jpg/);
  });

  test('200 for starter plan', () => {
    const { app } = buildApp({ plan: 'starter', file: PNG_FILE });
    return request(app).post('/api/business/logo').then(res => {
      expect(res.status).toBe(200);
    });
  });

  test('200 for pro plan', () => {
    const { app } = buildApp({ plan: 'pro', file: PNG_FILE });
    return request(app).post('/api/business/logo').then(res => {
      expect(res.status).toBe(200);
    });
  });

  test('500 when Supabase storage upload fails', () => {
    const { app } = buildApp({ file: PNG_FILE, uploadError: { message: 'Storage error' } });
    return request(app).post('/api/business/logo').then(res => {
      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/upload failed/i);
    });
  });

  test('tries to create bucket on each upload (idempotent)', async () => {
    const { app, mockCreateBucket } = buildApp({ file: PNG_FILE });
    await request(app).post('/api/business/logo');
    expect(mockCreateBucket).toHaveBeenCalledWith('business-logos', { public: true });
  });
});

// ── DELETE /api/business/logo ─────────────────────────────────────────────────

describe('DELETE /api/business/logo', () => {
  test('200 and removes logo when business has a logo', async () => {
    const { app, mockRemove } = buildApp({
      bizLogoUrl: 'https://project.supabase.co/storage/v1/object/public/business-logos/logos/biz-123/logo.png',
    });
    const res = await request(app).delete('/api/business/logo');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockRemove).toHaveBeenCalledTimes(1);
    expect(mockRemove).toHaveBeenCalledWith(['logos/biz-123/logo.png']);
  });

  test('200 gracefully when business has no logo', async () => {
    const { app, mockRemove } = buildApp({ bizLogoUrl: null });
    const res = await request(app).delete('/api/business/logo');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockRemove).not.toHaveBeenCalled();
  });

  test('200 still clears DB even if storage remove fails', async () => {
    jest.resetModules();
    mockReqFile    = undefined;
    mockMulterError = null;

    const bizData = { data: { plan: 'starter', logo_url: PUBLIC_URL }, error: null };
    const mockRemoveFail = jest.fn().mockRejectedValue(new Error('storage down'));

    jest.doMock('multer', () => {
      const m = jest.fn().mockReturnValue({ single: jest.fn().mockReturnValue((req, res, next) => next()) });
      m.memoryStorage = jest.fn().mockReturnValue({});
      return m;
    });
    jest.doMock('../../server/authMiddleware', () => (req, res, next) => {
      req.business = { id: 'biz-123' };
      next();
    });
    jest.doMock('@supabase/supabase-js', () => ({
      createClient: () => ({
        from: () => chain(bizData),
        storage: {
          createBucket: jest.fn().mockResolvedValue({ data: {}, error: null }),
          from: jest.fn().mockReturnValue({
            upload: jest.fn(),
            getPublicUrl: jest.fn().mockReturnValue({ data: { publicUrl: PUBLIC_URL } }),
            remove: mockRemoveFail,
          }),
        },
      }),
    }));

    const router = require('../../server/logoRoutes');
    const app = express();
    app.use(express.json());
    app.use(router);

    const res = await request(app).delete('/api/business/logo');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

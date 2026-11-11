'use strict';

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

const BUSINESS = {
  id: 'biz-1', email: 'owner@example.com', timezone: 'America/Toronto',
  team_members: [{ name: 'Sam' }, { name: 'Jordan Lee' }],
  google_access_token: null, google_refresh_token: null,
};

function buildApp({ business = BUSINESS, insertResult = { data: { id: 'blk-1' }, error: null }, deleted = [{ id: 'blk-1' }] } = {}) {
  jest.resetModules();
  const calls = { insert: [], deleteFilters: [] };
  const chain = result => {
    const self = {};
    ['select', 'eq', 'gte', 'lte', 'order', 'not', 'neq'].forEach(m => { self[m] = (...a) => { if (m === 'eq') calls.deleteFilters.push(a); return chain(result); }; });
    self.single = () => Promise.resolve(result);
    self.maybeSingle = () => Promise.resolve(result);
    self.then = (res, rej) => Promise.resolve(result).then(res, rej);
    return self;
  };
  jest.doMock('@supabase/supabase-js', () => ({
    createClient: () => ({
      from: () => ({
        select: () => chain({ data: [], error: null }),
        insert: row => { calls.insert.push(row); return chain(insertResult); },
        update: () => chain({ data: { id: 'blk-1' }, error: null }),
        delete: () => chain({ data: deleted, error: null }),
      }),
    }),
  }));
  jest.doMock('googleapis', () => ({ google: { auth: { OAuth2: jest.fn().mockImplementation(() => ({ generateAuthUrl: o => `https://accounts.google.com/o?state=${o.state}` })) }, calendar: jest.fn() } }));
  jest.doMock('../../server/authMiddleware', () => (req, res, next) => { req.business = { ...business }; next(); });
  const router = require('../../server/calendarRoutes');
  const app = express();
  app.use(express.json());
  app.use(router);
  return { app, calls, validateBlock: router.validateBlock };
}

describe('validateBlock', () => {
  const members = [{ name: 'Sam' }, { name: 'Jordan Lee' }];
  let validateBlock;
  beforeAll(() => { ({ validateBlock } = buildApp()); });

  test('one-time all-day block defaults end date to start date', () => {
    expect(validateBlock({ start_date: '2026-12-24', all_day: true }, members).values)
      .toMatchObject({ repeat: 'none', start_date: '2026-12-24', end_date: '2026-12-24', start_time: null, end_time: null });
  });
  test('weekly lunch break', () => {
    expect(validateBlock({ repeat: 'weekly', start_date: '2026-11-16', weekdays: [5, 1, 1, 9], start_time: '12:00', end_time: '13:00', note: ' Lunch ' }, members).values)
      .toMatchObject({ repeat: 'weekly', weekdays: [1, 5], end_date: null, start_time: '12:00', end_time: '13:00', note: 'Lunch' });
  });
  test('team member is matched to their real name', () => {
    expect(validateBlock({ start_date: '2026-11-16', all_day: true, team_member: 'jordan' }, members).values.team_member).toBe('Jordan Lee');
  });
  test.each([
    [{}, /start date/],
    [{ start_date: '2026-11-16', end_date: '2026-11-15', all_day: true }, /on or after/],
    [{ start_date: '2026-11-16', start_time: '13:00', end_time: '12:00' }, /after the start time/],
    [{ start_date: '2026-11-16', start_time: '13:00' }, /start and end time/],
    [{ repeat: 'weekly', start_date: '2026-11-16', all_day: true, weekdays: [] }, /day of the week/],
    [{ start_date: '2026-11-16', all_day: true, team_member: 'Chris' }, /not on your team/],
  ])('rejects %p', (body, msg) => expect(validateBlock(body, members).error).toMatch(msg));
});

describe('calendar routes', () => {
  test('POST /api/calendar/blocks saves for the signed-in shop only', async () => {
    const { app, calls } = buildApp();
    const res = await request(app).post('/api/calendar/blocks').send({ business_id: 'someone-else', start_date: '2026-11-16', all_day: true });
    expect(res.status).toBe(201);
    expect(calls.insert[0].business_id).toBe('biz-1');
  });

  test('POST /api/calendar/blocks 400 on bad input', async () => {
    const { app, calls } = buildApp();
    const res = await request(app).post('/api/calendar/blocks').send({ start_date: 'soon' });
    expect(res.status).toBe(400);
    expect(calls.insert).toHaveLength(0);
  });

  test('POST /api/calendar/blocks explains when the table is not set up yet', async () => {
    const { app } = buildApp({ insertResult: { data: null, error: { message: 'relation "public.calendar_blocks" does not exist' } } });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).post('/api/calendar/blocks').send({ start_date: '2026-11-16', all_day: true });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/being set up/);
  });

  test('DELETE /api/calendar/blocks/:id is scoped to the shop and 404s otherwise', async () => {
    const { app, calls } = buildApp({ deleted: [] });
    const res = await request(app).delete('/api/calendar/blocks/blk-9');
    expect(res.status).toBe(404);
    expect(calls.deleteFilters).toEqual(expect.arrayContaining([['id', 'blk-9'], ['business_id', 'biz-1']]));
  });

  test('POST /api/calendar/connect returns a Google URL with a signed, expiring state', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/calendar/connect');
    expect(res.status).toBe(200);
    const state = decodeURIComponent(res.body.url.split('state=')[1]);
    expect(state.startsWith('cal.')).toBe(true);
    const payload = jwt.verify(state.slice(4), process.env.JWT_SECRET);
    expect(payload).toMatchObject({ businessId: 'biz-1', purpose: 'calendar-connect' });
    expect(payload.exp - payload.iat).toBe(15 * 60);
  });

  test('GET /api/calendar/status never returns tokens', async () => {
    const { app } = buildApp({ business: { ...BUSINESS, google_access_token: 'a', google_refresh_token: 'r', google_calendar_email: 'sam@gmail.com' } });
    const res = await request(app).get('/api/calendar/status');
    expect(res.body).toEqual({ connected: true, email: 'sam@gmail.com' });
  });
});

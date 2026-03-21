'use strict';

jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
      insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'test-id' }, error: null }) }) }),
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
    }),
  }),
}));

const { generateSlug } = require('../../server/signupService');

describe('generateSlug', () => {
  test('lowercases the name', () => {
    expect(generateSlug('Sams Barbershop')).toBe('sams-barbershop');
  });

  test('replaces spaces with hyphens', () => {
    expect(generateSlug('cut and style')).toBe('cut-and-style');
  });

  test('collapses multiple spaces into one hyphen', () => {
    expect(generateSlug('the   barber')).toBe('the-barber');
  });

  test('strips special characters', () => {
    expect(generateSlug("Sam's Barbershop!")).toBe('sams-barbershop');
  });

  test('preserves numbers', () => {
    expect(generateSlug('Cuts4U')).toBe('cuts4u');
  });

  test('preserves existing hyphens', () => {
    expect(generateSlug('Cut-N-Style')).toBe('cut-n-style');
  });

  test('trims leading/trailing whitespace', () => {
    expect(generateSlug('  barber shop  ')).toBe('barber-shop');
  });

  test('handles accented characters by stripping them', () => {
    // Non-ASCII chars get stripped
    expect(generateSlug('Café Cuts')).toBe('caf-cuts');
  });

  test('single word becomes single slug', () => {
    expect(generateSlug('Barber')).toBe('barber');
  });

  test('all special chars with no letters returns empty string', () => {
    expect(generateSlug('!!!')).toBe('');
  });
});

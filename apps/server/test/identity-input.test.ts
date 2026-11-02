import { describe, expect, it } from 'vitest';
import { AppError } from '../src/platform/errors.js';
import { parseLoginInput, parseRegisterInput } from '../src/modules/identity/input.js';

const validRegisterInput = {
  username: 'Alice_1',
  email: 'a@example.com',
  password: 'twelve chars',
};

describe('parseRegisterInput', () => {
  it('normalizes username and email while preserving the password', () => {
    expect(parseRegisterInput({
      username: ' Alice_1 ',
      email: ' A@EXAMPLE.COM ',
      password: ' twelve chars ',
    })).toEqual({
      username: 'alice_1',
      email: 'a@example.com',
      password: ' twelve chars ',
    });
  });

  it('rejects unknown fields with an AppError', () => {
    try {
      parseRegisterInput({ ...validRegisterInput, price: '1' });
      throw new Error('Expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
        fields: { price: 'Unrecognized field' },
      });
    }
  });

  it('reports prototype-sensitive unknown keys without changing prototypes', () => {
    const input = JSON.parse('{"username":"alice","email":"a@example.com","password":"twelve chars","constructor":"x","toString":"x","__proto__":"x"}') as unknown;
    const originalObjectPrototype = Object.getPrototypeOf({});

    try {
      parseRegisterInput(input);
      throw new Error('Expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      if (!(error instanceof AppError)) throw error;
      expect(error.status).toBe(400);
      expect(error.fields).toBeDefined();
      for (const key of ['constructor', 'toString', '__proto__']) {
        expect(Object.hasOwn(error.fields!, key)).toBe(true);
        expect(error.fields![key]).toBe('Unrecognized field');
      }
      expect(Object.getPrototypeOf(error.fields)).toBeNull();
    }

    expect(Object.getPrototypeOf({})).toBe(originalObjectPrototype);
    expect(Object.prototype).not.toHaveProperty('x');
  });

  it('accepts password bounds of 12 and 72 UTF-8 bytes', () => {
    expect(parseRegisterInput({ ...validRegisterInput, password: 'x'.repeat(12) }).password).toHaveLength(12);
    expect(parseRegisterInput({ ...validRegisterInput, password: 'x'.repeat(72) }).password).toHaveLength(72);
  });

  it('counts UTF-8 bytes rather than password characters', () => {
    expect(() => parseRegisterInput({ ...validRegisterInput, password: 'é'.repeat(37) })).toThrow(AppError);
  });

  it('rejects malformed or oversized email addresses', () => {
    expect(() => parseRegisterInput({ ...validRegisterInput, email: 'bad email' })).toThrow(AppError);
    expect(() => parseRegisterInput({ ...validRegisterInput, email: `${'a'.repeat(243)}@example.com` })).toThrow(AppError);
  });

  it.each([null, [], 'text', 42, undefined])('rejects a non-object input: %s', (input) => {
    expect(() => parseRegisterInput(input)).toThrow(AppError);
  });

  it('rejects missing fields', () => {
    expect(() => parseRegisterInput({ username: 'alice', email: 'a@example.com' })).toThrow(AppError);
  });
});

describe('parseLoginInput', () => {
  it('normalizes username and preserves password whitespace', () => {
    expect(parseLoginInput({ username: ' Alice_1 ', password: ' secret password ' })).toEqual({
      username: 'alice_1',
      password: ' secret password ',
    });
  });

  it('rejects unknown fields', () => {
    expect(() => parseLoginInput({ username: 'alice', password: 'x'.repeat(12), email: 'a@example.com' })).toThrow(AppError);
  });

  it('rejects passwords outside the UTF-8 byte bounds', () => {
    expect(() => parseLoginInput({ username: 'alice', password: 'x'.repeat(11) })).toThrow(AppError);
    expect(() => parseLoginInput({ username: 'alice', password: 'x'.repeat(73) })).toThrow(AppError);
  });

  it.each([null, [], 'text', 42, undefined])('rejects a non-object input: %s', (input) => {
    expect(() => parseLoginInput(input)).toThrow(AppError);
  });
});

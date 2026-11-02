import { afterEach, expect, it } from 'vitest';
import { migrate, readSchemaVersion } from '../src/platform/migrate.js';
import { createHarness, type TestHarness } from './harness.js';
let h: TestHarness;
afterEach(async () => { await h?.close(); });
it('upgrades an existing foundation without changing opening cash or creating another default folder', async () => {
  h=await createHarness(); await migrate(h.ownerPool,1);
  const { registerUser }=await import('../src/modules/identity/registration.js');
  const original=await registerUser(h.appPool,{username:'upgrade',email:'upgrade@example.com',password:'upgrade password'},async()=> 'hash');
  await migrate(h.ownerPool);
  expect(await readSchemaVersion(h.appPool)).toBe(4);
  expect((await h.appPool.query('SELECT cash_balance,cash_sequence FROM accounts WHERE id=$1',[original.account.id])).rows).toEqual([{cash_balance:'1000000.00',cash_sequence:'1'}]);
  expect((await h.appPool.query('SELECT count(*)::int AS n FROM cash_movements')).rows).toEqual([{n:1}]);
  expect((await h.appPool.query('SELECT count(*)::int AS n FROM watchlist_folders')).rows).toEqual([{n:1}]);
});

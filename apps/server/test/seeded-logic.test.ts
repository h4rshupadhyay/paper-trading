import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHarness, type TestHarness } from './harness.js';
import { migrate } from '../src/platform/migrate.js';
import { submitOrder, cancelOrder, evaluatePending } from '../src/modules/trading/service.js';
import { reconcileAccount } from '../src/modules/accounts/reconciliation.js';
import { readPortfolio, sampleSnapshots } from '../src/modules/portfolio/service.js';
import { createAlert, createEntry, createFolder, deleteFolder, entries, evaluateAlerts, markRead, notifications } from '../src/modules/user-tools/service.js';

let h: TestHarness;
let userId: string;
let instrumentId: string;
const quiet = { refresh: async () => {} };
const page = { after: null, limit: 50 };
// This oracle uses integer units and rational rounding; it imports no application arithmetic.
const pow = (scale: number) => 10n ** BigInt(scale);
function units(value: string, scale: number): bigint {
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const result = BigInt(whole!) * pow(scale) + BigInt(fraction.padEnd(scale, '0'));
  return negative ? -result : result;
}
function decimal(value: bigint, scale: number): string {
  const sign = value < 0n ? '-' : ''; const magnitude = value < 0n ? -value : value;
  return `${sign}${magnitude / pow(scale)}.${(magnitude % pow(scale)).toString().padStart(scale, '0')}`;
}
function nearest(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  return quotient + (2n * (numerator % denominator) >= denominator ? 1n : 0n);
}
class Book {
  cash = 100000000n; quantity = 0n; native = 0n; base = 0n;
  purchasedNative = 0n; purchasedBase = 0n; allocatedNative = 0n; allocatedBase = 0n;
  fills = 0;
  trade(side: 'BUY' | 'SELL', quantity: string, price: string, fx = '1') {
    const q = units(quantity, 4), p = units(price, 8), f = units(fx, 12);
    const native = nearest(q * p, pow(4));
    const cents = nearest(q * p * f, pow(22));
    if (!cents) return { status: 'REJECTED', rejectionReason: 'SETTLEMENT_ZERO' };
    if (!native) return { status: 'REJECTED', rejectionReason: 'NATIVE_AMOUNT_ZERO' };
    if (side === 'BUY' && cents > this.cash) return { status: 'REJECTED', rejectionReason: 'INSUFFICIENT_FUNDS' };
    if (side === 'SELL' && q > this.quantity) return { status: 'REJECTED', rejectionReason: 'INSUFFICIENT_POSITION' };
    let allocatedNative = 0n, allocatedBase = 0n;
    if (side === 'BUY') {
      this.quantity += q; this.native += native; this.base += cents * pow(6);
      this.purchasedNative += native; this.purchasedBase += cents * pow(6); this.cash -= cents;
    } else {
      allocatedNative = nearest(this.native * q, this.quantity);
      allocatedBase = nearest(this.base * q, this.quantity);
      this.quantity -= q; this.native -= allocatedNative; this.base -= allocatedBase;
      this.allocatedNative += allocatedNative; this.allocatedBase += allocatedBase; this.cash += cents;
    }
    this.fills++;
    return { status: 'FILLED', settlement: decimal(cents, 2), native: decimal(native, 8),
      allocatedNative: decimal(allocatedNative, 8), allocatedBase: decimal(allocatedBase, 8),
      pl: decimal(side === 'SELL' ? cents * pow(6) - allocatedBase : 0n, 8) };
  }
}
async function seedUser() {
  const id = randomUUID(), name = `seed_${id.replaceAll('-', '').slice(0, 20)}`;
  await h.ownerPool.query('INSERT INTO users(id,username,email,password_hash) VALUES($1,$2,$3,\'unused\')', [id, name, `${name}@example.invalid`]);
  await h.ownerPool.query('INSERT INTO accounts(id,user_id,cash_balance,cash_sequence) VALUES($1,$1,1000000,1)', [id]);
  await h.ownerPool.query("INSERT INTO cash_movements(account_id,account_sequence,amount,resulting_balance,reason) VALUES($1,1,1000000,1000000,'OPENING_CREDIT')", [id]);
  await h.ownerPool.query("INSERT INTO watchlist_folders(user_id,name,is_default) VALUES($1,'Default',true)", [id]);
  return id;
}
async function quote(price: string, currency = 'INR', fx = '1', pence = false) {
  await h.ownerPool.query('UPDATE instruments SET currency=$2,multiplier=$3 WHERE id=$1', [instrumentId, currency, pence ? '0.01' : '1']);
  await h.ownerPool.query(`INSERT INTO latest_quotes(instrument_id,price,observed_at,fetched_at,session,raw_currency,raw_price,action_key,provider)
    VALUES($1,$2,clock_timestamp(),clock_timestamp(),'REGULAR',$3,$4,'none','fixture') ON CONFLICT(instrument_id) DO UPDATE SET
    price=EXCLUDED.price,observed_at=EXCLUDED.observed_at,fetched_at=EXCLUDED.fetched_at,session='REGULAR',raw_currency=EXCLUDED.raw_currency,raw_price=EXCLUDED.raw_price`,
  [instrumentId, price, pence ? 'GBp' : currency, pence ? decimal(units(price, 8) * 100n, 8) : price]);
  if (currency !== 'INR') await h.ownerPool.query(`INSERT INTO latest_fx_rates(currency,rate,observed_at,fetched_at,provider) VALUES($1,$2,clock_timestamp(),clock_timestamp(),'fixture')
    ON CONFLICT(currency) DO UPDATE SET rate=EXCLUDED.rate,observed_at=EXCLUDED.observed_at,fetched_at=EXCLUDED.fetched_at,provider='fixture'`, [currency, fx]);
}
const intent = (side: 'BUY' | 'SELL', quantity: string, extra: Record<string, unknown> = {}) => ({ instrumentId, side, type: 'MARKET', quantity, ...extra });
async function check(book: Book) {
  const account = (await h.appPool.query('SELECT cash_balance::text,cash_sequence::text FROM accounts WHERE user_id=$1', [userId])).rows[0]!;
  expect(account).toEqual({ cash_balance: decimal(book.cash, 2), cash_sequence: String(book.fills + 1) });
  const positions = (await h.appPool.query('SELECT quantity::text,native_cost::text,base_cost::text FROM positions WHERE account_id=$1', [userId])).rows;
  expect(positions).toEqual(book.quantity === 0n ? [] : [{ quantity: decimal(book.quantity, 4), native_cost: decimal(book.native, 8), base_cost: decimal(book.base, 8) }]);
  expect(book.cash >= 0n && book.quantity >= 0n && book.native >= 0n && book.base >= 0n).toBe(true);
  expect(book.native + book.allocatedNative).toBe(book.purchasedNative);
  expect(book.base + book.allocatedBase).toBe(book.purchasedBase);
  const ledger = (await h.appPool.query('SELECT amount::text,resulting_balance::text,account_sequence::text FROM cash_movements WHERE account_id=$1 ORDER BY cash_movements.account_sequence', [userId])).rows;
  let running = 0n;
  for (const [index, row] of ledger.entries()) {
    running += units(row.amount, 2); expect(row.resulting_balance).toBe(decimal(running, 2)); expect(row.account_sequence).toBe(String(index + 1));
  }
  expect(running).toBe(book.cash);
  expect((await h.appPool.query(`SELECT o.status,count(e.id)::int n FROM orders o LEFT JOIN executions e ON e.order_id=o.id WHERE o.account_id=$1 GROUP BY o.id`, [userId])).rows.every(row => row.n === (row.status === 'FILLED' ? 1 : 0))).toBe(true);
  expect(await reconcileAccount(h.appPool, userId)).toMatchObject({ balanced: true, ledgerMismatchCount: 0, executionMismatchCount: 0, positionMismatchCount: 0 });
}
async function market(book: Book, side: 'BUY' | 'SELL', quantity: string, price: string, fx = '1') {
  const expected = book.trade(side, quantity, price, fx);
  const result = await submitOrder(h.appPool, userId, intent(side, quantity), randomUUID(), quiet);
  expect(result.order).toMatchObject({ status: expected.status, ...(expected.status === 'REJECTED' ? { rejectionReason: expected.rejectionReason } : { baseSettlement: expected.settlement }) });
  if (expected.status === 'FILLED') expect((await h.appPool.query(`SELECT native_amount::text,allocated_native_cost::text,allocated_base_cost::text,realized_pl::text FROM executions WHERE order_id=$1`, [result.order.id])).rows[0]).toEqual({ native_amount: expected.native, allocated_native_cost: expected.allocatedNative, allocated_base_cost: expected.allocatedBase, realized_pl: expected.pl });
  await check(book); return result;
}
beforeEach(async () => {
  h = await createHarness(); await migrate(h.ownerPool); userId = await seedUser();
  instrumentId = (await h.ownerPool.query(`INSERT INTO instruments(symbol,name,exchange,currency,multiplier,kind,tradable,paused,provider)
    VALUES('SEED','Seeded fixture','NSE','INR',1,'EQUITY',true,false,'fixture') RETURNING id`)).rows[0]!.id;
  await quote('100');
});
afterEach(async () => { await h?.close(); });

it.each([0x51eed, 0xc0ffee, 0xdecaf])('LOGIC-001 seed %i: 40 state transitions agree with independent integer book', async seed => {
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const book = new Book();
  for (let step = 0; step < 40; step++) {
    const price = decimal(BigInt(1 + next() % 1500000), 4);
    const quantity = decimal(BigInt(1 + next() % 40000), 4);
    const side = step % 9 === 8 ? 'SELL' : next() % 3 === 0 ? 'SELL' : 'BUY';
    const q = step % 9 === 8 && book.quantity > 0n ? decimal(book.quantity, 4) : quantity;
    await quote(price); await market(book, side, q, price);
  }
  if (book.quantity) { await quote('19.99'); await market(book, 'SELL', decimal(book.quantity, 4), '19.99'); }
  expect(book.native).toBe(0n); expect(book.base).toBe(0n);
});

it.each(['BUY', 'SELL'] as const)('LOGIC-002 %s: literal weighted-cost residuals close exactly and allow reentry', async side => {
  const book = new Book();
  await quote('0.01'); await market(book, 'BUY', '3', '0.01');
  await quote('0.02'); await market(book, 'BUY', '4', '0.02');
  await quote('0.03'); await market(book, 'SELL', '1', '0.03');
  expect(decimal(book.native, 8)).toBe('0.09428571'); expect(decimal(book.base, 8)).toBe('0.09428571');
  expect(decimal(book.cash, 2)).toBe('999999.92');
  await market(book, 'SELL', '6', '0.03'); expect(decimal(book.cash, 2)).toBe('1000000.10');
  await market(book, side, '1', '0.03');
});

it.each((['BUY', 'SELL'] as const).flatMap(side => (['MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT'] as const).map(type => ({ side, type }))))('LOGIC-003 $side $type: inclusive crossing, no premature fill and durable normalized replay', async ({ side, type }) => {
  const book = new Book();
  if (side === 'SELL') await market(book, 'BUY', '2', '100');
  const extra = { type, ...(type.includes('LIMIT') ? { limitPrice: '100' } : {}), ...(type.startsWith('STOP') ? { stopPrice: '100' } : {}) };
  const k = randomUUID();
  const result = await submitOrder(h.appPool, userId, intent(side, '1.0000', extra), k, quiet);
  if (type !== 'MARKET') {
    await quote(type === 'LIMIT' ? (side === 'BUY' ? '100.00000001' : '99.99999999') : (side === 'BUY' ? '99.99999999' : '100.00000001'));
    await evaluatePending(h.appPool); await check(book);
    expect((await h.appPool.query('SELECT status FROM orders WHERE id=$1', [result.order.id])).rows[0]!.status).toBe('OPEN');
    await quote('100'); await Promise.all([evaluatePending(h.appPool), evaluatePending(h.appPool)]);
  }
  book.trade(side, '1', '100'); await check(book);
  await h.ownerPool.query('DELETE FROM latest_quotes WHERE instrument_id=$1', [instrumentId]);
  const replay = await submitOrder(h.appPool, userId, { ...intent(side, '1', extra), instrumentId: instrumentId.toUpperCase(), ...(extra.limitPrice ? { limitPrice: '100.00000000' } : {}), ...(extra.stopPrice ? { stopPrice: '100.00000000' } : {}) }, k, { refresh: async () => { throw Error('offline'); } });
  expect(replay).toMatchObject({ replayed: true, order: { id: result.order.id, status: 'FILLED' } }); await check(book);
});

it.each([
  { currency: 'INR', fx: '1', settlement: '0.03' }, { currency: 'USD', fx: '83.333333333333', settlement: '2.50' },
  { currency: 'GBP', fx: '100.125', settlement: '3.00' }, { currency: 'EUR', fx: '90.5', settlement: '2.72' },
  { currency: 'JPY', fx: '0.555555555555', settlement: '0.02' }, { currency: 'HKD', fx: '10.125', settlement: '0.30' },
])('LOGIC-004 $currency: fractional FX settlement and source-normalized round trip', async ({ currency, fx, settlement }) => {
  const book = new Book(); await quote('0.01', currency, fx, currency === 'GBP');
  const buy = await market(book, 'BUY', '3', '0.01', fx); expect(buy.order.baseSettlement).toBe(settlement);
  await quote('0.02', currency, fx, currency === 'GBP'); await market(book, 'SELL', '1', '0.02', fx); await market(book, 'SELL', '2', '0.02', fx);
  expect((await h.appPool.query('SELECT DISTINCT currency FROM executions WHERE account_id=$1', [userId])).rows).toEqual([{ currency }]);
});

it.each([
  { price: '49.99999999', q: '0.0001', settlement: null },
  { price: '50', q: '0.0001', settlement: '0.01' },
  { price: '999999999999.99999999', q: '0.0001', settlement: '100000000.00' },
])('LOGIC-005 edge $price x $q: half-cent and large decimal boundaries', async ({ price, q, settlement }) => {
  const book = new Book(); await quote(price); const result = await market(book, 'BUY', q, price);
  if (settlement === '0.01') expect(result.order.baseSettlement).toBe('0.01');
  else if (settlement) expect(result.order.rejectionReason).toBe('INSUFFICIENT_FUNDS');
  else expect(result.order.rejectionReason).toBe('SETTLEMENT_ZERO');
});

it('LOGIC-006 simultaneous mixed writes and duplicate keys settle one serial account history', async () => {
  const book = new Book(); await quote('0.17'); await market(book, 'BUY', '7', '0.17');
  const duplicateKey = randomUUID();
  const results = await Promise.all([
    submitOrder(h.appPool, userId, intent('BUY', '2'), duplicateKey, quiet),
    submitOrder(h.appPool, userId, intent('BUY', '2.0000'), duplicateKey, quiet),
    submitOrder(h.appPool, userId, intent('SELL', '3'), randomUUID(), quiet),
  ]);
  expect(results[0]!.order.id).toBe(results[1]!.order.id);
  expect(results.filter(result => result.replayed)).toHaveLength(1);
  book.trade('BUY', '2', '0.17'); book.trade('SELL', '3', '0.17'); await check(book);
  await expect(submitOrder(h.appPool, userId, intent('SELL', '2'), duplicateKey, quiet)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await check(book);
});

it('LOGIC-007 expired crossed stop-limit competes with cancellation without execution or resurrection', async () => {
  const book = new Book();
  const pending = await submitOrder(h.appPool, userId, intent('BUY', '1', { type: 'STOP_LIMIT', stopPrice: '110', limitPrice: '111', expiresAt: new Date(Date.now() + 60000).toISOString() }), randomUUID(), quiet);
  await quote('120'); await evaluatePending(h.appPool);
  expect((await h.appPool.query('SELECT status FROM orders WHERE id=$1', [pending.order.id])).rows[0]!.status).toBe('TRIGGERED');
  await h.ownerPool.query("UPDATE orders SET expires_at=now()-interval '1 second' WHERE id=$1", [pending.order.id]);
  await quote('111');
  const outcomes = await Promise.allSettled([cancelOrder(h.appPool, userId, pending.order.id), evaluatePending(h.appPool), evaluatePending(h.appPool)]);
  expect(outcomes.slice(1).every(outcome => outcome.status === 'fulfilled')).toBe(true);
  if (outcomes[0]!.status === 'rejected') expect(outcomes[0]!.reason).toMatchObject({ status: 409 });
  const status = (await h.appPool.query('SELECT status FROM orders WHERE id=$1', [pending.order.id])).rows[0]!.status;
  expect(['EXPIRED', 'CANCELLED']).toContain(status); await evaluatePending(h.appPool); await check(book);
  await expect(cancelOrder(h.appPool, userId, pending.order.id)).rejects.toMatchObject({ status: 409 });
});

it('LOGIC-008 missing observations and reversible instrument gates keep queued orders inert; disabled owners terminate them', async () => {
  const book = new Book();
  const pending = await submitOrder(h.appPool, userId, intent('BUY', '1', { type: 'LIMIT', limitPrice: '100' }), randomUUID(), quiet);
  for (const gate of ['quote', 'fx', 'paused', 'view-only']) {
    await quote('100', 'USD', '2');
    if (gate === 'quote') await h.ownerPool.query('DELETE FROM latest_quotes WHERE instrument_id=$1', [instrumentId]);
    if (gate === 'fx') await h.ownerPool.query("DELETE FROM latest_fx_rates WHERE currency='USD'");
    if (gate === 'paused') await h.ownerPool.query('UPDATE instruments SET paused=true WHERE id=$1', [instrumentId]);
    if (gate === 'view-only') await h.ownerPool.query('UPDATE instruments SET tradable=false WHERE id=$1', [instrumentId]);
    await evaluatePending(h.appPool); await check(book);
    expect((await h.appPool.query('SELECT status FROM orders WHERE id=$1', [pending.order.id])).rows[0]!.status).toBe('OPEN');
    await h.ownerPool.query('UPDATE instruments SET paused=false,tradable=true WHERE id=$1', [instrumentId]);
  }
  await h.ownerPool.query('UPDATE users SET active=false WHERE id=$1', [userId]); await evaluatePending(h.appPool);
  expect((await h.appPool.query('SELECT status,rejection_reason FROM orders WHERE id=$1', [pending.order.id])).rows[0]).toEqual({ status: 'REJECTED', rejection_reason: 'ACCOUNT_DISABLED' });
  await expect(submitOrder(h.appPool, userId, intent('BUY', '1'), randomUUID(), quiet)).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
  await h.ownerPool.query('UPDATE users SET active=true WHERE id=$1', [userId]); await check(book);
});

it('LOGIC-009 watchlist ownership and concurrent dedup coexist with independent one-shot inclusive alerts', async () => {
  const other = await seedUser();
  const foreign = await createFolder(h.appPool, other, 'Private');
  await expect(createEntry(h.appPool, userId, { instrumentId, folderId: foreign.id })).rejects.toMatchObject({ status: 404 });
  const attempts = await Promise.allSettled([createEntry(h.appPool, userId, { instrumentId }), createEntry(h.appPool, userId, { instrumentId })]);
  expect(attempts.filter(x => x.status === 'fulfilled')).toHaveLength(1);
  expect((await entries(h.appPool, userId, page)).items).toHaveLength(1);
  const research = await createFolder(h.appPool, userId, 'Research'); await createEntry(h.appPool, userId, { instrumentId, folderId: research.id });
  await deleteFolder(h.appPool, userId, research.id); expect((await entries(h.appPool, userId, page)).items).toHaveLength(1);
  for (const condition of ['ABOVE', 'BELOW'] as const) await createAlert(h.appPool, userId, { instrumentId, condition, targetPrice: '100' });
  await createAlert(h.appPool, other, { instrumentId, condition: 'BELOW', targetPrice: '99.99999999' });
  await Promise.all([evaluateAlerts(h.appPool), evaluateAlerts(h.appPool)]);
  const notices = (await notifications(h.appPool, userId, page)).items; expect(notices).toHaveLength(2);
  expect((await notifications(h.appPool, other, page)).items).toHaveLength(0);
  await expect(markRead(h.appPool, other, notices.map(n => n.id))).rejects.toMatchObject({ status: 404 });
  await quote('99.99999999'); await evaluateAlerts(h.appPool); await quote('101'); await evaluateAlerts(h.appPool);
  expect((await notifications(h.appPool, userId, page)).items).toHaveLength(2);
  expect((await notifications(h.appPool, other, page)).items).toHaveLength(1); await check(new Book());
});

it('LOGIC-010 retains prior snapshots while incomplete and recovers as stale without inventing prices', async () => {
  const book = new Book(); await market(book, 'BUY', '1', '100'); await sampleSnapshots(h.appPool);
  await quote('110'); await market(book, 'BUY', '1', '110');
  await h.ownerPool.query('DELETE FROM latest_quotes WHERE instrument_id=$1', [instrumentId]);
  expect(await readPortfolio(h.appPool, userId)).toMatchObject({ quality: 'incomplete', totalValue: null });
  await sampleSnapshots(h.appPool);
  expect((await h.appPool.query('SELECT account_sequence::text,total_value::text FROM portfolio_snapshots WHERE account_id=$1 ORDER BY sampled_at DESC LIMIT 1', [userId])).rows).toEqual([{ account_sequence: '2', total_value: '1000000.00' }]);
  expect((await h.appPool.query('SELECT valuation_dirty FROM accounts WHERE id=$1', [userId])).rows[0]!.valuation_dirty).toBe(true);
  await quote('120'); await h.ownerPool.query("UPDATE latest_quotes SET observed_at=now()-interval '2 minutes' WHERE instrument_id=$1", [instrumentId]);
  expect(await readPortfolio(h.appPool, userId)).toMatchObject({ quality: 'stale', totalValue: '1000030.00' });
  await sampleSnapshots(h.appPool);
  expect((await h.appPool.query('SELECT account_sequence::text,total_value::text,quality FROM portfolio_snapshots WHERE account_id=$1 ORDER BY sampled_at DESC LIMIT 1', [userId])).rows).toEqual([{ account_sequence: '3', total_value: '1000030.00', quality: 'stale' }]);
  await check(book);
});

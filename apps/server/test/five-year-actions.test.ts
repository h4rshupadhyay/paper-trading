import {beforeEach,afterEach,it,expect} from 'vitest';
import {createHarness,type TestHarness} from './harness.js';
import {migrate} from '../src/platform/migrate.js';
import {registerUser} from '../src/modules/identity/registration.js';
import {recordDemoTrade} from '../src/modules/demo/accounting.js';
import {recordAccountAction} from '../src/modules/demo/five-year-accounting.js';
import {reconcileAccount} from '../src/modules/accounts/reconciliation.js';
let h:TestHarness;
beforeEach(async()=>{h=await createHarness();await migrate(h.ownerPool);});
afterEach(async()=>{await h?.close();});
it('preserves split basis, credits entitled shares and reconciles a subsequent partial sale',async()=>{
  const user=await registerUser(h.appPool,{username:'actions',email:'actions@example.com',password:'actions password 123'},async()=> 'hash');
  const id=(await h.appPool.query('SELECT id FROM accounts WHERE user_id=$1',[user.user.id])).rows[0]!.id;
  const instrument=(await h.appPool.query("INSERT INTO instruments(symbol,name,exchange,currency,multiplier,kind,tradable,provider) VALUES('AAPL','Apple','NMS','USD',1,'EQUITY',true,'yfinance') RETURNING id")).rows[0]!.id;
  const c=await h.appPool.connect();
  const makeOrder=async(side:string,quantity:string)=>(await c.query("INSERT INTO orders(account_id,instrument_id,idempotency_key,intent_fingerprint,side,type,quantity,status) VALUES($1,$2,$3,repeat('a',64),$4,'MARKET',$5,'FILLED') RETURNING id",[id,instrument,'action-test-'+side,side,quantity])).rows[0]!.id;
  try{
    await recordDemoTrade(c,id,instrument,await makeOrder('BUY','10'),{symbol:'AAPL',side:'BUY',quantity:'10',price:'100',fx:'80',at:'2022-01-03T21:00:00Z',fxAt:'2022-01-03T00:00:00Z',sessionDate:'2022-01-03'});
    await recordAccountAction(c,id,instrument,{symbol:'AAPL',kind:'SPLIT',at:'2022-06-01T04:00:00Z',sessionDate:'2022-06-01',factor:'2',perShare:'0',fx:'1',fxAt:'2022-06-01T04:00:00Z'});
    expect((await c.query('SELECT quantity::text,native_cost::text,base_cost::text FROM positions')).rows[0]).toEqual({quantity:'20.0000',native_cost:'1000.00000000',base_cost:'80000.00000000'});
    await recordAccountAction(c,id,instrument,{symbol:'AAPL',kind:'DIVIDEND',at:'2022-06-01T04:00:00Z',sessionDate:'2022-06-01',factor:'1',perShare:'1',fx:'81',fxAt:'2022-06-01T00:00:00Z'});
    await recordDemoTrade(c,id,instrument,await makeOrder('SELL','5'),{symbol:'AAPL',side:'SELL',quantity:'5',price:'60',fx:'82',at:'2022-07-01T20:00:00Z',fxAt:'2022-07-01T00:00:00Z',sessionDate:'2022-07-01'});
  }finally{c.release();}
  expect((await h.appPool.query('SELECT cash_balance::text,cash_sequence::text FROM accounts')).rows[0]).toEqual({cash_balance:'946220.00',cash_sequence:'4'});
  expect((await h.appPool.query('SELECT quantity::text,native_cost::text,base_cost::text FROM positions')).rows[0]).toEqual({quantity:'15.0000',native_cost:'750.00000000',base_cost:'60000.00000000'});
  expect((await h.appPool.query("SELECT amount::text FROM cash_movements WHERE reason='DIVIDEND'")).rows[0]!.amount).toBe('1620.00');
  expect(await reconcileAccount(h.appPool,user.user.id)).toMatchObject({balanced:true});
  await h.ownerPool.query("UPDATE account_actions SET quantity_delta=quantity_delta+1 WHERE kind='SPLIT'");
  expect(await reconcileAccount(h.appPool,user.user.id)).toMatchObject({balanced:false,positionMismatchCount:1});
});

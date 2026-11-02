import {afterEach,expect,it} from 'vitest';
import {createHarness,type TestHarness} from './harness.js';
import {migrate} from '../src/platform/migrate.js';
import {registerUser} from '../src/modules/identity/registration.js';
import {reconcileAccount} from '../src/modules/accounts/reconciliation.js';
let h:TestHarness;afterEach(async()=>{await h?.close()});
it('independently reconciles cash, sequences and position costs, including detecting projection tampering',async()=>{
 h=await createHarness();await migrate(h.ownerPool);const {user,account}=await registerUser(h.appPool,{username:'reconcile',email:'reconcile@example.com',password:'reconcile password'},async()=> 'hash');
 expect(await reconcileAccount(h.appPool,user.id)).toMatchObject({balanced:true,cashDifference:'0.00',positionMismatchCount:0,executionMismatchCount:0,sequenceMatches:true});
 await h.ownerPool.query('UPDATE accounts SET cash_balance=cash_balance+1 WHERE id=$1',[account.id]);
 expect(await reconcileAccount(h.appPool,user.id)).toMatchObject({balanced:false,cashDifference:'1.00'});
});

it('audits execution settlements and both remaining position cost bases against the ledger',async()=>{
 h=await createHarness();await migrate(h.ownerPool);
 const {user,account}=await registerUser(h.appPool,{username:'audit_trade',email:'audit_trade@example.com',password:'audit trade password'},async()=> 'hash');
 const {FixtureProvider}=await import('../src/modules/market-data/provider.js');
 const {discoverInstruments,refreshInstrument}=await import('../src/modules/market-data/service.js');
 const {submitOrder}=await import('../src/modules/trading/service.js');
 const provider=new FixtureProvider();const instrument=(await discoverInstruments(h.appPool,'RELIANCE',provider))[0]!;
 await refreshInstrument(h.appPool,instrument.id,provider);
 await submitOrder(h.appPool,user.id,{instrumentId:instrument.id,side:'BUY',type:'MARKET',quantity:'2'},'audit-trade-key',{refresh:async()=>{}});
 expect(await reconcileAccount(h.appPool,user.id)).toMatchObject({balanced:true,positionMismatchCount:0,executionMismatchCount:0});
 await h.ownerPool.query('UPDATE positions SET native_cost=native_cost+1 WHERE account_id=$1',[account.id]);
 expect(await reconcileAccount(h.appPool,user.id)).toMatchObject({balanced:false,positionMismatchCount:1});
 await h.ownerPool.query("UPDATE cash_movements SET amount=amount+1 WHERE account_id=$1 AND reason='BUY'",[account.id]);
 expect(await reconcileAccount(h.appPool,user.id)).toMatchObject({balanced:false,cashDifference:'-1.00',executionMismatchCount:1});
});
it('detects a corrupted recorded running balance even when cash and movement sum still agree',async()=>{
 h=await createHarness();await migrate(h.ownerPool);const {user,account}=await registerUser(h.appPool,{username:'running_balance',email:'running_balance@example.com',password:'running balance password'},async()=> 'hash');
 await h.ownerPool.query('ALTER TABLE cash_movements DROP CONSTRAINT valid_cash_movement');
 await h.ownerPool.query('UPDATE cash_movements SET resulting_balance=resulting_balance+1 WHERE account_id=$1',[account.id]);
 expect(await reconcileAccount(h.appPool,user.id)).toMatchObject({balanced:false,ledgerMismatchCount:1,cashDifference:'0.00'});
});

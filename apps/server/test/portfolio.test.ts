import { randomUUID } from 'node:crypto';
import { beforeEach,afterEach,expect,it } from 'vitest';
import { createHarness,type TestHarness } from './harness.js';
import { migrate } from '../src/platform/migrate.js';
import { registerUser } from '../src/modules/identity/registration.js';
import { submitOrder } from '../src/modules/trading/service.js';
import { readPortfolio,sampleSnapshots } from '../src/modules/portfolio/service.js';
let h:TestHarness;let userId:string;let instrumentId:string;const quiet={refresh:async()=>{}};
async function setPrice(price:string){await h.ownerPool.query('UPDATE latest_quotes SET price=$2,raw_price=$2,observed_at=clock_timestamp() WHERE instrument_id=$1',[instrumentId,price]);}
async function buy(){return submitOrder(h.appPool,userId,{instrumentId,side:'BUY',type:'MARKET',quantity:'1'},randomUUID(),quiet);}
beforeEach(async()=>{
 h=await createHarness();await migrate(h.ownerPool);userId=(await registerUser(h.appPool,{username:'portfolio',email:'portfolio@test.example',password:'unused'},async()=>'unused')).user.id;
 instrumentId=(await h.ownerPool.query(`INSERT INTO instruments(symbol,name,exchange,currency,multiplier,kind,tradable,provider) VALUES('TEST','Test','NSE','INR',1,'EQUITY',true,'fixture') RETURNING id`)).rows[0].id;
 await h.ownerPool.query(`INSERT INTO latest_quotes(instrument_id,price,observed_at,session,raw_currency,raw_price,action_key,provider) VALUES($1,100,clock_timestamp(),'REGULAR','INR',100,'none','fixture')`,[instrumentId]);await buy();
});
afterEach(async()=>{await h?.close();});
async function waitGate(){const deadline=Date.now()+2000;while(!(await h.ownerPool.query(`SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=1480963298 AND NOT granted`)).rowCount){if(Date.now()>deadline)throw Error('Snapshot never reached gate');await new Promise(r=>setTimeout(r,5));}}
async function snapshotGate(){const gate=await h.ownerPool.connect();await gate.query('SELECT pg_advisory_lock(1480963298)');await h.ownerPool.query(`CREATE FUNCTION snapshot_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.total_value=1000000 THEN PERFORM pg_advisory_xact_lock(1480963298); END IF; RETURN NEW; END $$;CREATE TRIGGER snapshot_gate BEFORE INSERT ON portfolio_snapshots FOR EACH ROW EXECUTE FUNCTION snapshot_gate()`);return gate;}
it('does not replace a newer sample with an older valuation having the same account sequence',async()=>{
 const gate=await snapshotGate();let older:Promise<void>|undefined;
 try{
  older=sampleSnapshots(h.appPool);await waitGate();await setPrice('110');await sampleSnapshots(h.appPool);
  await gate.query('SELECT pg_advisory_unlock(1480963298)');await older;
  expect((await h.appPool.query('SELECT total_value::text FROM portfolio_snapshots')).rows).toEqual([{total_value:'1000010.00'}]);
 }finally{await gate.query('SELECT pg_advisory_unlock_all()');await older;gate.release();}
});
it('keeps post-valuation trades dirty and samples one consistent earlier account version',async()=>{
 const gate=await snapshotGate();let older:Promise<void>|undefined;
 try{
  older=sampleSnapshots(h.appPool);await waitGate();await setPrice('110');await buy();await gate.query('SELECT pg_advisory_unlock(1480963298)');await older;
  expect((await h.appPool.query('SELECT valuation_dirty FROM accounts')).rows[0].valuation_dirty).toBe(true);
  expect((await h.appPool.query('SELECT account_sequence::text,cash_balance::text,holdings_value::text,total_value::text FROM portfolio_snapshots')).rows[0]).toEqual({account_sequence:'2',cash_balance:'999900.00',holdings_value:'100.00',total_value:'1000000.00'});
  await sampleSnapshots(h.appPool);expect((await h.appPool.query('SELECT account_sequence::text,total_value::text FROM portfolio_snapshots')).rows).toEqual([{account_sequence:'3',total_value:'1000010.00'}]);
 }finally{await gate.query('SELECT pg_advisory_unlock_all()');await older;gate.release();}
});
it('stores the exact quote/FX observation range in the snapshot',async()=>{
 await sampleSnapshots(h.appPool);
 expect((await h.appPool.query(`SELECT observed_from=q.observed_at AS first_matches,observed_to=q.observed_at AS last_matches FROM portfolio_snapshots CROSS JOIN latest_quotes q`)).rows[0]).toEqual({first_matches:true,last_matches:true});
});
it('labels known stale FX estimates and leaves missing cross-provider FX incomplete',async()=>{
 await h.ownerPool.query(`UPDATE instruments SET currency='USD' WHERE id=$1`,[instrumentId]);await h.ownerPool.query(`UPDATE latest_quotes SET raw_currency='USD' WHERE instrument_id=$1`,[instrumentId]);
 await h.ownerPool.query(`INSERT INTO latest_fx_rates(currency,rate,observed_at,provider) VALUES('USD',80,now()-interval '25 hours','fixture')`);
 const stale=await readPortfolio(h.appPool,userId);expect(stale.quality).toBe('stale');expect(stale.positions[0]!.value).toBe('8000.00');
 await h.ownerPool.query(`UPDATE latest_fx_rates SET provider='other' WHERE currency='USD'`);const incomplete=await readPortfolio(h.appPool,userId);expect(incomplete.totalValue).toBeNull();expect(incomplete.quality).toBe('incomplete');
});
it('returns unavailable values instead of failing when a supported position outgrows valuation storage range',async()=>{
 await h.ownerPool.query(`UPDATE positions SET quantity=100000000000000 WHERE account_id=(SELECT id FROM accounts WHERE user_id=$1)`,[userId]);
 await setPrice('999999999999.99999999');
 const portfolio=await readPortfolio(h.appPool,userId);expect(portfolio.positions[0]!.value).toBeNull();expect(portfolio.totalValue).toBeNull();expect(portfolio.quality).toBe('incomplete');
 await sampleSnapshots(h.appPool);expect((await h.appPool.query('SELECT count(*)::int n FROM portfolio_snapshots')).rows[0].n).toBe(0);
});
it('rotates incomplete sampling attempts so a complete account beyond the first bounded batch is sampled',async()=>{
 const missing=(await h.ownerPool.query(`INSERT INTO instruments(symbol,name,exchange,currency,multiplier,kind,tradable,provider) VALUES('MISSING','Missing','NSE','INR',1,'EQUITY',true,'fixture') RETURNING id`)).rows[0].id;
 await h.ownerPool.query(`WITH new_users AS (
  INSERT INTO users(id,username,email,password_hash) SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'missing'||n,'missing'||n||'@test.example','unused' FROM generate_series(1,100)n RETURNING id
 ),new_accounts AS (
  INSERT INTO accounts(id,user_id,cash_balance,cash_sequence) SELECT id,id,1000000,1 FROM new_users RETURNING id
 ),credits AS (
  INSERT INTO cash_movements(account_id,account_sequence,amount,resulting_balance,reason) SELECT id,1,1000000,1000000,'OPENING_CREDIT' FROM new_accounts RETURNING account_id
 ) INSERT INTO positions(account_id,instrument_id,quantity,native_cost,base_cost) SELECT account_id,$1,1,100,100 FROM credits`,[missing]);
 await sampleSnapshots(h.appPool);await sampleSnapshots(h.appPool);
 expect((await h.appPool.query('SELECT count(*)::int n FROM portfolio_snapshots WHERE account_id=(SELECT id FROM accounts WHERE user_id=$1)',[userId])).rows[0].n).toBe(1);
});

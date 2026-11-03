import type { Pool } from 'pg';
import { statisticFields, type Instrument, type MarketProvider, type ProviderStatistics } from './provider.js';
import { getProvider, readInstrument, readQuote, refreshInstrument } from './service.js';

type StatisticsDto = ProviderStatistics['statistics'] & {
  instrumentId:string; provider:string; fetchedAt:string; quality:'fresh'|'stale';
  sector:string|null; industry:string|null; description:string|null;
};
const columnNames=['open','day_high','day_low','previous_close','volume','average_volume','market_cap','trailing_pe','fifty_two_week_high','fifty_two_week_low'];
const priceFields=new Set(['open','dayHigh','dayLow','previousClose','fiftyTwoWeekHigh','fiftyTwoWeekLow']);
const pending=new WeakMap<Pool,Map<string,Promise<void>>>();

function valid(data:ProviderStatistics,instrument:Instrument):boolean {
  if(data.symbol!==instrument.symbol || data.rawCurrency!==(instrument.multiplier==='0.01000000'?'GBp':instrument.currency))return false;
  if(!data.statistics || !statisticFields.some(k=>data.statistics[k]!==null))return false;
  for(const key of statisticFields){
    const value=data.statistics[key];
    const pattern=key==='trailingPE'?/^-?(?:0|[1-9]\d{0,19})(?:\.\d{1,24})?$/:key==='volume'||key==='averageVolume'?/^(?:0|[1-9]\d{0,19})$/:/^(?:0|[1-9]\d{0,19})(?:\.\d{1,24})?$/;
    if(value!==null && (typeof value!=='string'||!pattern.test(value)))return false;
  }
  return ([['sector',256],['industry',256],['description',20000]] as const).every(([key,limit])=>data[key]===null || typeof data[key]==='string'&&data[key]!.length<=limit);
}

export async function refreshStatistics(pool:Pool,id:string,provider=getProvider()):Promise<void>{
  if(!provider.statistics)return;
  const instrument=await readInstrument(pool,id);
  if(instrument.provider!==provider.name)return;
  const client=await pool.connect();let locked=false,discard=false;
  try {
    locked=(await client.query<{locked:boolean}>('SELECT pg_try_advisory_lock(1480963207,hashtext($1)) AS locked',[id])).rows[0]!.locked;
    if(!locked)return;
    const due=await client.query(`UPDATE public.instruments i SET statistics_attempted_at=clock_timestamp()
      WHERE i.id=$1 AND (i.statistics_attempted_at IS NULL OR i.statistics_attempted_at<clock_timestamp()-interval '60 seconds')
      AND NOT EXISTS(SELECT 1 FROM public.latest_instrument_statistics s WHERE s.instrument_id=i.id AND s.provider=$2 AND s.fetched_at>clock_timestamp()-interval '30 minutes') RETURNING i.id`,[id,provider.name]);
    if(!due.rowCount)return;
    let data:ProviderStatistics;
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      data=await Promise.race([provider.statistics(instrument),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Statistics timeout')),6500)})]);
    } catch {return;} finally {clearTimeout(timer);}
    if(!valid(data,instrument))return;
    const metrics=statisticFields.map((key,index)=>`($${index+3}::numeric${priceFields.has(key)?'*$2::numeric':''})`);
    await client.query(`INSERT INTO public.latest_instrument_statistics(instrument_id,${columnNames.join(',')},sector,industry,description,provider,fetched_at)
      VALUES($1,${metrics.join(',')},$13,$14,$15,$16,clock_timestamp()) ON CONFLICT(instrument_id) DO UPDATE SET
      ${columnNames.map(c=>`${c}=EXCLUDED.${c}`).join(',')},sector=EXCLUDED.sector,industry=EXCLUDED.industry,description=EXCLUDED.description,provider=EXCLUDED.provider,fetched_at=EXCLUDED.fetched_at`,
      [id,instrument.multiplier,...statisticFields.map(k=>data.statistics[k]),data.sector,data.industry,data.description,provider.name]);
  } finally {
    if(locked)try{await client.query('SELECT pg_advisory_unlock(1480963207,hashtext($1))',[id]);}catch{discard=true;}
    client.release(discard);
  }
}

export async function readMarketSnapshot(pool:Pool,id:string){
  const quote=await readQuote(pool,id);
  const result=await pool.query<StatisticsDto>(`SELECT s.instrument_id AS "instrumentId",${columnNames.map((c,i)=>`s.${c}::text AS "${statisticFields[i]}"`).join(',')},
    s.sector,s.industry,s.description,s.provider,to_char(s.fetched_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "fetchedAt",
    CASE WHEN s.fetched_at<clock_timestamp()-interval '60 minutes' OR s.fetched_at>clock_timestamp()+interval '5 seconds' THEN 'stale' ELSE 'fresh' END AS quality
    FROM public.latest_instrument_statistics s JOIN public.instruments i ON i.id=s.instrument_id WHERE s.instrument_id=$1 AND s.provider=i.provider`,[id]);
  return {...quote,statistics:result.rows[0]??null};
}

function schedule(pool:Pool,id:string,work:()=>Promise<void>){
  let jobs=pending.get(pool);if(!jobs){jobs=new Map();pending.set(pool,jobs);}
  if(jobs.has(id)||jobs.size>=2)return;
  const job=work().catch(()=>{/* Last successful observations remain readable. */}).finally(()=>jobs!.delete(id));
  jobs.set(id,job);
}
export async function drainSnapshotRefreshes(pool:Pool):Promise<void>{await Promise.all(pending.get(pool)?.values()??[]);}

export async function marketSnapshot(pool:Pool,id:string,provider=getProvider()){
  let result=await readMarketSnapshot(pool,id);
  if(!result.quote){
    await refreshInstrument(pool,id,provider);
    result=await readMarketSnapshot(pool,id);
    schedule(pool,id,()=>refreshStatistics(pool,id,provider));
  } else {
    const due=Date.now()-Date.parse(result.quote.fetchedAt)>=15000;
    schedule(pool,id,async()=>{
      if(due)await refreshInstrument(pool,id,provider);
      await refreshStatistics(pool,id,provider);
    });
  }
  return result;
}

/** A first-view caller can join the existing bounded refresh without delaying the quote. */
export async function initialStatistics(pool:Pool,id:string,provider=getProvider()){
  const current=await readMarketSnapshot(pool,id);
  if(current.statistics)return current.statistics;
  const job=pending.get(pool)?.get(id);
  if(job)await job;
  else await refreshStatistics(pool,id,provider);
  return (await readMarketSnapshot(pool,id)).statistics;
}

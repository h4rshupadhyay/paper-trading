import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../platform/errors.js';
const quantity=z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/).refine(s=>/[1-9]/.test(s));
const price=z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/).refine(s=>/[1-9]/.test(s));
export const uuid=z.string().uuid();
const schema=z.object({instrumentId:uuid,side:z.enum(['BUY','SELL']),type:z.enum(['MARKET','LIMIT','STOP','STOP_LIMIT']),quantity,
  limitPrice:price.optional(),stopPrice:price.optional(),expiresAt:z.iso.datetime({offset:true}).optional()}).strict().superRefine((o,ctx)=>{
  if ((o.type==='LIMIT'||o.type==='STOP_LIMIT')!==Boolean(o.limitPrice)) ctx.addIssue({code:'custom',message:'Invalid limit price',path:['limitPrice']});
  if ((o.type==='STOP'||o.type==='STOP_LIMIT')!==Boolean(o.stopPrice)) ctx.addIssue({code:'custom',message:'Invalid stop price',path:['stopPrice']});
});
export type OrderInput=z.infer<typeof schema>;
function fixed(value:string,scale:number):string { const [whole,fraction='']=value.split('.'); return `${whole}.${fraction.padEnd(scale,'0')}`; }
export function parseOrder(value:unknown,key:unknown):{input:OrderInput;fingerprint:string;key:string} {
  const parsed=schema.safeParse(value);
  if(!parsed.success || typeof key!=='string'|| !/^[\x21-\x7e]{8,128}$/.test(key)) throw new AppError(400,'VALIDATION_ERROR','Invalid order or idempotency key');
  const p=parsed.data;
  const input={...p,instrumentId:p.instrumentId.toLowerCase(),quantity:fixed(p.quantity,4),...(p.limitPrice?{limitPrice:fixed(p.limitPrice,8)}:{}),...(p.stopPrice?{stopPrice:fixed(p.stopPrice,8)}:{}),...(p.expiresAt?{expiresAt:new Date(p.expiresAt).toISOString()}:{})};
  const fingerprint=createHash('sha256').update(JSON.stringify([input.instrumentId,input.side,input.type,input.quantity,input.limitPrice??null,input.stopPrice??null,input.expiresAt??null])).digest('hex');
  return {input,fingerprint,key};
}
export function requireId(value:unknown):string { const parsed=uuid.safeParse(value); if(!parsed.success)throw new AppError(400,'VALIDATION_ERROR','Invalid identifier'); return parsed.data; }

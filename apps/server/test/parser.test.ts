import request from 'supertest';
import { expect,it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Pool } from 'pg';
import { loadConfig } from '../src/platform/config.js';
import { createSafeLogger } from '../src/platform/logging.js';
it('rejects unsupported JSON charset and content encoding as client errors without touching storage',async()=>{
 const config=loadConfig({DATABASE_URL:'postgresql://app:password@127.0.0.1:55439/unused',PUBLIC_ORIGIN:'http://localhost:3000',CSRF_SECRET:'test secret at least thirty two bytes long'});
 const pool={query(){throw Error('Storage should not be touched')}} as unknown as Pool;
 const app=createApp({pool,config,logger:createSafeLogger(()=>{})});
 for(const headers of [{'Content-Type':'application/json; charset=iso-8859-1'},{'Content-Type':'application/json','Content-Encoding':'unsupported'}]) {
  const result=await request(app).post('/api/auth/login').set('Origin',config.publicOrigin).set(headers).send('{}');
  expect(result.status).toBe(415);expect(result.body.error.code).toBe('UNSUPPORTED_ENCODING');
 }
});

import { expect, it, vi } from 'vitest';
import { createHarness } from './harness.js';

it('waits for client socket shutdown before dropping its isolated database',async()=>{
  const harness=await createHarness();
  const client=await harness.appPool.connect();
  const end=client.end.bind(client);
  let socketEnded=false;
  client.once('end',()=>{socketEnded=true;});
  vi.spyOn(client,'end').mockImplementation(callback=>{
    setTimeout(()=>{end(callback);},100);
  });
  const errors:Error[]=[];
  harness.appPool.on('error',error=>{errors.push(error);});
  client.release();
  try {
    await harness.close();
    expect(socketEnded).toBe(true);
    expect(errors).toEqual([]);
  } finally {await harness.close();}
});

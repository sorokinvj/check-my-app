import { launch } from '@cloudflare/playwright';
let used = false;
export default {
 async fetch(request, env) {
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/probe' || used) return new Response('Not found', {status:404});
  used = true;
  const browser = await launch(env.BROWSER, { keep_alive: 60000 });
  const result = {};
  try {
   const cdp = await browser.newBrowserCDPSession();
   for (const [method,params] of [
    ['Browser.getVersion',{}],
    ['Extensions.getExtensions',{}],
    ['Extensions.loadUnpacked',{path:'/checkmyapp-preflight-path-that-does-not-exist'}],
   ]) {
    try {result[method] = await cdp.send(method,params);} catch(error) {result[method]={error:error.message};}
   }
   return Response.json(result);
  } finally {await browser.close();}
 }
};

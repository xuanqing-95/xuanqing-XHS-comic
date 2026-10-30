import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { runJsonChat, generatePage } from './provider-clients.mjs';
import { relayHeaders, officialChatOptions } from './official-provider-utils.mjs';
const oldFetch=globalThis.fetch;
const previous={key:process.env.OFFICIAL_TEST_KEY,token:process.env.OPENAI_RELAY_TOKEN};
process.env.OFFICIAL_TEST_KEY='test-only-key';process.env.OPENAI_RELAY_TOKEN='test-only-relay';
const temp=await mkdtemp(path.join(os.tmpdir(),'official-provider-'));
const png=await sharp({create:{width:16,height:16,channels:3,background:'red'}}).png().toBuffer();
const file=path.join(temp,'reference.png');await writeFile(file,png);
const calls=[];
let quota=false;
globalThis.fetch=async(url,options)=>{
 calls.push({url,options});
 if(quota)return new Response(JSON.stringify({error:{code:'insufficient_quota'}}),{status:429,headers:{'content-type':'application/json'}});
 return new Response(JSON.stringify(url.endsWith('/chat/completions')?{choices:[{message:{content:'{"ok":true}'}}],usage:{prompt_tokens:8,completion_tokens:2}}:{data:[{b64_json:png.toString('base64')}],usage:{input_tokens:3,input_tokens_details:{text_tokens:2,image_tokens:1},output_tokens:4}}),{headers:{'content-type':'application/json'}});
};
const common={provider:'openai',model:'gpt-6.1-terra',pricingModel:'openai:gpt-6.1-terra',adapter:'openai_compatible_chat',baseURL:'https://www.pipeline.xin/api/internal/openai',apiKeyEnv:['OFFICIAL_TEST_KEY'],relayTokenEnv:'OPENAI_RELAY_TOKEN'};
try{
 const legacyEnv={ZENMUX_RELAY_TOKEN:'legacy-only'};
 assert.deepEqual(relayHeaders({provider:'zenmux',relayTokenEnv:'ZENMUX_RELAY_TOKEN'},legacyEnv),{'X-Redflow-Relay-Token':'legacy-only'});
 assert.deepEqual(officialChatOptions('zenmux'),{});
 assert.deepEqual(officialChatOptions('openai'),{max_completion_tokens:8192,reasoning_effort:'low',store:false,service_tier:'default'});
 assert.throws(()=>relayHeaders(common,legacyEnv),/Missing relay token/);
 assert.throws(()=>relayHeaders({...common,relayTokenEnv:'ZENMUX_RELAY_TOKEN'},legacyEnv),/trusted endpoint/);
 for(const baseURL of ['http://www.pipeline.xin/api/internal/openai','https://www.pipeline.xin.evil.invalid/api/internal/openai','https://user:pass@www.pipeline.xin/api/internal/openai','https://www.pipeline.xin/api/internal/openai?target=evil','https://www.pipeline.xin/api/internal/zenmux','https://www.pipeline.xin:8443/api/internal/openai']) {
  assert.throws(()=>relayHeaders({...common,baseURL},legacyEnv),/trusted endpoint/);
 }
 const chat=await runJsonChat({route:{...common,capability:'vision'},prompt:'Return JSON',imageFiles:[file]});assert.equal(chat.data.ok,true);
 assert.equal(calls[0].options.headers['X-Redflow-OpenAI-Relay-Token'],'test-only-relay');assert.equal(calls[0].options.headers['X-Redflow-Relay-Token'],undefined);assert.equal(calls[0].options.redirect,'error');assert.equal(JSON.parse(calls[0].options.body).max_completion_tokens,8192);
 await assert.rejects(runJsonChat({route:{...common,capability:'text',baseURL:'https://untrusted.invalid/v1'},prompt:'JSON'}),/trusted endpoint/);assert.equal(calls.length,1);
 await runJsonChat({route:{...common,capability:'text',baseURL:'https://api.openai.com/v1'},prompt:'JSON'});assert.equal(calls.at(-1).options.headers['X-Redflow-OpenAI-Relay-Token'],undefined);
 const image={...common,capability:'image',model:'gpt-image-2',pricingModel:'openai:gpt-image-2',adapter:'openai_compatible_image',supportsReferences:true,dimensionControl:{status:'supported',mechanism:'size',guarantee:'exact',operations:['generation','edit'],evidence:{level:'documented',source:'test'}},aspectRatioSizes:{'3:4':'1152x1536'},supportedSizes:['1152x1536'],exactOutputSizes:['1152x1536']};
 const out=await generatePage({route:image,prompt:'test',referenceFiles:[file],aspectRatio:'3:4',quality:'low',outputPath:path.join(temp,'out.png')});assert.equal(out.usage.input_tokens_details.image_tokens,1);assert.match(calls.at(-1).url,/images\/edits$/);assert.equal(calls.at(-1).options.headers['Content-Type'],'application/json');
 quota=true;const count=calls.length;await assert.rejects(runJsonChat({route:{...common,capability:'text'},prompt:'JSON'}),/HTTP 429/);assert.equal(calls.length,count+1);
 console.log('Official provider PASS: isolated headers, endpoint restrictions, direct/relay, bounded output, image edits, real usage passthrough, no quota retry');
}finally{globalThis.fetch=oldFetch;for(const [name,value]of [['OFFICIAL_TEST_KEY',previous.key],['OPENAI_RELAY_TOKEN',previous.token]])if(value===undefined)delete process.env[name];else process.env[name]=value;await rm(temp,{recursive:true,force:true});}

const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const pkg=require('../package.json');
const file='../'+pkg.n8n.nodes[0];
const Node=Object.values(require(file))[0],node=new Node();
const folder=path.dirname(require.resolve(file));
const operations=require(path.join(folder,'operations.json')),routes=require(path.join(folder,'routes.json'));
const {parseArgument}=require(path.join(folder,'transport.js'));
function sample(schema){
 const type=Array.isArray(schema.type)?schema.type.find(t=>t!=='null'):schema.type;
 if(schema.enum)return schema.enum[0];
 if(type==='integer'||type==='number')return schema.minimum??1;
 if(type==='boolean')return true;
 if(type==='array')return Array.from({length:schema.minItems??1},()=>sample(schema.items??{type:'string'}));
 if(type==='object')return Object.fromEntries((schema.required??[]).map(key=>[key,sample(schema.properties[key])]));
 return 'fixture-123';
}
function context(op=operations[0],{items=[{json:{}}],response={statusCode:200,body:{ok:true}},error,params={},continueOnFail=false,confirm=true}={}) {
 const calls=[];
 const values={operation:op.name,confirmWrite:confirm};
 for(const key of op.inputSchema.required??[])values[op.name+'__'+key]=sample(op.inputSchema.properties[key]);
 Object.assign(values,params);
 const ctx={getInputData:()=>items,getNode:()=>({name:'Test',type:'test',typeVersion:1,parameters:{},position:[0,0]}),getNodeParameter:(name,i,fallback)=>values[name]??fallback,continueOnFail:()=>continueOnFail,helpers:{httpRequestWithAuthentication:async(credential,options)=>{calls.push({credential,options});if(error)throw error;return response;}}};
 return {ctx,calls};
}
test('each operation makes one native REST request with no MCP handshake, headers or envelope',async()=>{
 for(const op of operations){const {ctx,calls}=context(op);const result=await node.execute.call(ctx);assert.equal(calls.length,1,op.name);const {credential,options}=calls[0];assert.equal(credential,node.description.credentials[0].name);assert.equal(options.method,routes[op.name].method);const url=new URL(options.url);assert.equal(url.protocol,'https:');assert(url.pathname.startsWith('/v1/'));assert(options.disableFollowRedirect);assert.equal(options.headers.Accept,'application/json');assert(!JSON.stringify(options).includes('jsonrpc'));assert(!JSON.stringify(options.headers).includes('MCP'));assert.deepEqual(result[0][0].json,{ok:true});}
});
test('links outputs to the corresponding input item',async()=>{const {ctx,calls}=context(operations[0],{items:[{json:{a:1}},{json:{a:2}}]});const result=await node.execute.call(ctx);assert.equal(calls.length,2);assert.deepEqual(result[0].map(x=>x.pairedItem),[{item:0},{item:1}]);});
test('encodes identifiers without exposing them as path or query structure',async()=>{const op=operations.find(o=>routes[o.name].path.includes(':'));if(!op)return;const key=routes[op.name].path.match(/:([A-Za-z][A-Za-z0-9]*)/)[1];const {ctx,calls}=context(op,{params:{[op.name+'__'+key]:'owned?item#one'}});await node.execute.call(ctx);assert(calls[0].options.url.includes('owned%3Fitem%23one'));assert.equal(new URL(calls[0].options.url).hash,'');assert(!calls[0].options.body?.[key]);});
test('uses query pagination on GET without a request body',async()=>{const op=operations.find(o=>routes[o.name].method==='GET'&&o.inputSchema.properties?.offset);if(!op)return;const {ctx,calls}=context(op,{params:{['options_'+op.name]:{offset:50}}});await node.execute.call(ctx);assert.equal(new URL(calls[0].options.url).searchParams.get('offset'),'50');assert.equal(calls[0].options.body,undefined);});
test('requires explicit confirmation before mutations',async()=>{const op=operations.find(o=>o.annotations?.readOnlyHint!==true);if(!op)return;const {ctx,calls}=context(op,{confirm:false});await assert.rejects(node.execute.call(ctx),/confirmation/);assert.equal(calls.length,0);});
test('invalid required values fail before a network request',async()=>{const op=operations.find(o=>(o.inputSchema.required??[]).length);if(!op)return;const key=op.inputSchema.required[0];const {ctx,calls}=context(op,{params:{[op.name+'__'+key]:''}});await assert.rejects(node.execute.call(ctx),/required/);assert.equal(calls.length,0);});
test('HTTP failures never copy secrets or raw provider errors into workflow data',async()=>{const error=Object.assign(new Error('Bearer SECRET; private response'),{statusCode:401,request:{headers:{Authorization:'Bearer SECRET'}}});const {ctx}=context(operations[0],{error,continueOnFail:true});const result=await node.execute.call(ctx);assert.match(result[0][0].json.error,/401/);assert(!JSON.stringify(result).includes('SECRET'));});
test('204 responses become a successful JSON item',async()=>{const {ctx}=context(operations[0],{response:{statusCode:204,body:''}});assert.deepEqual((await node.execute.call(ctx))[0][0].json,{success:true});});
test('rejects invalid JSON responses',async()=>{const {ctx}=context(operations[0],{response:{statusCode:200,body:'<html>error</html>'}});await assert.rejects(node.execute.call(ctx),/invalid JSON/);});
test('parses valid JSON arrays and rejects wrong types and out-of-range values',()=>{assert.deepEqual(parseArgument('["a"]',{type:'array'},true,'values'),['a']);assert.throws(()=>parseArgument('{}',{type:'array'},true,'values'));assert.throws(()=>parseArgument(4,{type:'integer',maximum:3},true,'count'));});
